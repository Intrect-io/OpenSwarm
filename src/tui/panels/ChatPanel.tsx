// ============================================
// OpenSwarm - Chat tab panel (EPIC INT-1813 S4 + S8 / INT-1937, INT-1941)
// Wires the pure chat model to the input/log components and to
// chatSession.callChatModel (streaming). S8 adds /plan + /goal orchestration via
// planCommand.runPlanCommand, with confirms routed through a pending-input flow
// (the Ink PlanIO implementation). Network/effect boundary.
// ============================================

import { Box } from 'ink';
import { useReducer, useState, useCallback, useEffect, useRef } from 'react';
import {
  chatReducer,
  initialChatState,
  parseInput,
  matchSlash,
  movePaletteSelection,
  normalizeConfirm,
  isActivityNoise,
  historyToMessages,
  SLASH_COMMANDS,
  type ChatLine,
} from '../chatModel.js';
import { ChatLog } from '../components/ChatLog.js';
import { ChatInput } from '../components/ChatInput.js';
import { CommandPalette } from '../components/CommandPalette.js';
import { SelectList } from '../components/SelectList.js';
import { listAdapterNames } from '../../adapters/index.js';
import { callChatModel, loadDefaultProvider, saveSession, generateSessionId, type Message } from '../../support/chatSession.js';
import { getDefaultChatModel, listChatModels } from '../../support/chatBackend.js';
import { runPlanCommand, type PlanIO } from '../../support/planCommand.js';
import { runGoalCommand, buildGoalPursuitPrompt, GOAL_PURSUIT_MAX_TURNS } from '../../support/goalCommand.js';
import type { AdapterName } from '../../adapters/types.js';
import { track } from '../../telemetry/telemetry.js';

function buildConversationPrompt(messages: Message[]): string {
  if (messages.length <= 1) return messages[0]?.content ?? '';
  return [
    'Use the following conversation history as context. Continue by answering the latest user message.',
    '',
    messages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n'),
  ].join('\n');
}

export interface ChatPanelProps {
  active: boolean;
  provider?: string;
  model?: string;
  /** Project root for /plan + /goal dispatch (defaults to cwd). */
  projectPath?: string;
  /** Session id to persist under; resume passes the existing id. (INT-2014) */
  sessionId?: string;
  /** Conversation restored from a resumed session. (INT-2014) */
  initialHistory?: ChatLine[];
  /** Session goal restored from a resumed session — keeps it "in pursuit". (INT-2014) */
  goal?: string;
}

/** Process-scoped: the signal is "did this session engage at all", not a counter. */
let engagementReported = false;

export function ChatPanel({ active, provider: providerProp, model: modelProp, projectPath, sessionId: sessionIdProp, initialHistory, goal: goalProp }: ChatPanelProps) {
  const [state, dispatch] = useReducer(
    chatReducer,
    undefined,
    () => (initialHistory && initialHistory.length > 0 ? { history: initialHistory, streaming: null } : initialChatState),
  );
  const [input, setInput] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  // A /goal pursuit is active — only /goal clear stops it (no Esc/other input). (INT-2014)
  const [goalActive, setGoalActive] = useState<boolean>(!!goalProp);
  // Stable across renders: session id, createdAt, the active goal, and the abort
  // controller that /goal clear fires. (INT-2014)
  const sessionIdRef = useRef<string>(sessionIdProp ?? generateSessionId());
  const createdAtRef = useRef<string>(new Date().toISOString());
  const goalRef = useRef<string | undefined>(goalProp);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const modelSelectorRequestRef = useRef(0);
  const resumedGoalRef = useRef(false);
  const persistenceErrorRef = useRef<string | null>(null);
  // When set, the next submitted line is routed here (a /plan confirm or edit)
  // instead of being treated as chat — the Ink analogue of blessed pendingInput.
  const [pending, setPending] = useState<{ resolve: (value: string) => void } | null>(null);
  const pendingRef = useRef<{ resolve: (value: string) => void } | null>(null);

  // provider/model are runtime-switchable via /provider and /model (INT-1960/1961).
  const [provider, setProvider] = useState<AdapterName>((providerProp as AdapterName | undefined) ?? loadDefaultProvider());
  const [model, setModel] = useState<string>(modelProp ?? getDefaultChatModel((providerProp as AdapterName | undefined) ?? loadDefaultProvider()));
  // Active /provider | /model selector overlay (null = none). (INT-1960/1961)
  const [selector, setSelector] = useState<{ kind: 'provider' | 'model'; title: string; items: string[] } | null>(null);
  const [selectorIndex, setSelectorIndex] = useState(0);
  const cwd = projectPath ?? process.cwd();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      modelSelectorRequestRef.current += 1;
      abortRef.current?.abort();
      const pendingRequest = pendingRef.current;
      pendingRef.current = null;
      pendingRequest?.resolve('no');
    };
  }, []);

  useEffect(() => {
    modelSelectorRequestRef.current += 1;
  }, [provider]);

  // Persist the conversation on every change so it survives exit and can be
  // reopened with `openswarm resume`. System/UI lines are dropped by
  // historyToMessages; an active goal rides along so resume can restart it. (INT-2014)
  useEffect(() => {
    if (state.history.length === 0) return;
    void saveSession({
      id: sessionIdRef.current,
      provider,
      model,
      messages: historyToMessages(state.history),
      totalCost: 0,
      totalTokens: 0,
      createdAt: createdAtRef.current,
      updatedAt: '', // saveSession stamps this
      goal: goalRef.current,
    })
      .then(() => {
        if (!mountedRef.current) return;
        persistenceErrorRef.current = null;
      })
      .catch((e) => {
        if (!mountedRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (persistenceErrorRef.current === msg) return;
        persistenceErrorRef.current = msg;
        dispatch({ type: 'system', content: `✖ failed to save session: ${msg}` });
      });
  }, [state.history, provider, model, goalActive]);

  const ask = useCallback(
    (prompt: string) =>
      new Promise<string>((resolve) => {
        if (!mountedRef.current) {
          resolve('no');
          return;
        }
        dispatch({ type: 'system', content: prompt });
        const request = { resolve };
        pendingRef.current = request;
        setPending(request);
      }),
    [],
  );

  const planIO: PlanIO = {
    print: (line) => {
      if (!mountedRef.current) return;
      dispatch({ type: 'system', content: line });
    },
    confirm: async (prompt) => normalizeConfirm(await ask(prompt)),
    promptText: (prompt) => ask(prompt),
  };

  const runPlan = useCallback(
    async (goal: string) => {
      setBusy(true);
      try {
        await runPlanCommand(goal, planIO, { projectPath: cwd, model });
      } catch (e) {
        if (!mountedRef.current) return;
        dispatch({ type: 'system', content: `✖ plan failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    // planIO is rebuilt each render but only closes over stable dispatch/ask.
    [cwd, model], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Stream an agentic chat turn into the reducer. Shared by free chat and simple
  // /goal pursuit (the latter raises maxTurns). (INT-1821)
  const streamChat = useCallback(
    async (prompt: string, maxTurns?: number) => {
      dispatch({ type: 'stream', chunk: '' });
      setActivity([]);
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await callChatModel(
          prompt,
          provider,
          model,
          // Reasoning/thinking deltas (isThinking=true) must NOT land in the answer
          // buffer — that's the /goal token-spam (INT-2013). Drop them here; codex
          // surfaces reasoning separately via onLog ('💭 …'). (INT-2014)
          (t, isThinking) => {
            if (!mountedRef.current) return;
            if (!isThinking) dispatch({ type: 'stream', chunk: t });
          },
          (line) => {
            if (!mountedRef.current) return;
            if (isActivityNoise(line)) return;
            setActivity((a) => [...a, line].slice(-10));
          },
          maxTurns,
          ac.signal, // wired so /goal clear can abort a pursuit (INT-2014)
          cwd, // run in the repo `openswarm chat` was launched from (INT-2005)
        );
      } catch (e) {
        if (!mountedRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        // An abort (from /goal clear) is intentional, not an error.
        if (!ac.signal.aborted) dispatch({ type: 'stream', chunk: `\n[error] ${msg}` });
      } finally {
        if (mountedRef.current) {
          dispatch({ type: 'commit' });
          setActivity([]);
          setBusy(false);
          if (abortRef.current === ac) abortRef.current = null;
        }
      }
    },
    [provider, model, cwd],
  );

  // /goal routes by complexity: simple → pursue in-session (streamed), complex →
  // decompose & dispatch via the /plan flow. (INT-1821 / S8)
  const runGoal = useCallback(
    async (goal: string) => {
      goalRef.current = goal; // rides along into saveSession so resume keeps it
      setGoalActive(true);
      setBusy(true);
      try {
        await runGoalCommand(
          goal,
          planIO,
          { projectPath: cwd, model, provider },
          { pursue: (g) => streamChat(buildGoalPursuitPrompt(g), GOAL_PURSUIT_MAX_TURNS) },
        );
      } catch (e) {
        if (!mountedRef.current) return;
        dispatch({ type: 'system', content: `✖ goal failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        if (mountedRef.current) {
          goalRef.current = undefined;
          setBusy(false);
          // Pursuit turn finished — unblock input and remove the completed goal
          // from the persisted session.
          setGoalActive(false);
        }
      }
    },
    [cwd, model, provider, streamChat], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (!goalProp || resumedGoalRef.current) return;
    resumedGoalRef.current = true;
    void runGoal(goalProp);
  }, [goalProp, runGoal]);

  // Open the /model selector for the current provider (async catalog). (INT-1961)
  const openModelSelector = useCallback(async () => {
    const requestId = ++modelSelectorRequestRef.current;
    const requestedProvider = provider;
    dispatch({ type: 'system', content: `Fetching models for ${provider}…` });
    try {
      const models = await listChatModels(requestedProvider);
      if (!mountedRef.current || requestId !== modelSelectorRequestRef.current) return;
      if (!models.length) {
        dispatch({ type: 'system', content: `No models listed for ${requestedProvider}. Use /model <name>.` });
        return;
      }
      setSelectorIndex(Math.max(0, models.indexOf(model)));
      setSelector({ kind: 'model', title: `Switch model (${requestedProvider}):`, items: models });
    } catch (e) {
      if (!mountedRef.current || requestId !== modelSelectorRequestRef.current) return;
      dispatch({ type: 'system', content: `✖ failed to list models: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [provider, model]);

  const runCommand = useCallback(
    (name: string, args: string) => {
      switch (name) {
        case '/clear':
          dispatch({ type: 'clear' });
          break;
        case '/help':
          dispatch({ type: 'system', content: SLASH_COMMANDS.map((c) => `${c.name} ${c.args} — ${c.desc}`).join('\n') });
          break;
        case '/plan':
          void runPlan(args);
          break;
        case '/goal': {
          // /goal clear stops the active pursuit — the only way to interrupt it.
          // It aborts the in-flight turn and releases the session goal. (INT-2014)
          if (args.trim() === 'clear') {
            abortRef.current?.abort();
            goalRef.current = undefined;
            setGoalActive(false);
            dispatch({ type: 'system', content: '✖ Goal cleared.' });
            break;
          }
          // /goal routes by complexity (INT-1821): simple → pursue in-session,
          // complex → decompose & dispatch. Shared, UI-agnostic goalCommand.
          void runGoal(args);
          break;
        }
        case '/provider': {
          // `/provider <name>` switches directly; bare `/provider` opens a selector. (INT-1960)
          const items = listAdapterNames();
          const target = args.trim();
          if (target) {
            if (!items.includes(target as AdapterName)) {
              dispatch({ type: 'system', content: `Unknown provider "${target}". Options: ${items.join(', ')}` });
            } else {
              setProvider(target as AdapterName);
              setModel(getDefaultChatModel(target as AdapterName));
              dispatch({ type: 'system', content: `Provider → ${target} (model: ${getDefaultChatModel(target as AdapterName)})` });
            }
            break;
          }
          setSelectorIndex(Math.max(0, items.indexOf(provider)));
          setSelector({ kind: 'provider', title: 'Switch provider:', items });
          break;
        }
        case '/model': {
          // `/model <name>` switches directly; bare `/model` opens an async selector. (INT-1961)
          const target = args.trim();
          if (target) {
            setModel(target);
            dispatch({ type: 'system', content: `Model → ${target}` });
            break;
          }
          void openModelSelector();
          break;
        }
        default:
          dispatch({ type: 'system', content: `Unknown command: ${name}` });
      }
    },
    [runPlan, runGoal, provider, openModelSelector],
  );

  // Apply the highlighted choice in the /provider | /model selector. (INT-1960/1961)
  const applySelector = useCallback(() => {
    if (!selector) return;
    const choice = selector.items[selectorIndex];
    if (choice) {
      if (selector.kind === 'provider') {
        setProvider(choice as AdapterName);
        setModel(getDefaultChatModel(choice as AdapterName));
        dispatch({ type: 'system', content: `Provider → ${choice} (model: ${getDefaultChatModel(choice as AdapterName)})` });
      } else {
        setModel(choice);
        dispatch({ type: 'system', content: `Model → ${choice}` });
      }
    }
    setSelector(null);
    setSelectorIndex(0);
  }, [selector, selectorIndex]);

  const submit = useCallback(
    async (raw: string) => {
      // One bit, once per process: this session got as far as a submitted line.
      // Launching the TUI and submitting nothing were indistinguishable, and
      // that is precisely the difference between someone who bounced off the
      // first screen and someone who tried and was let down. (INT-3190)
      if (!engagementReported) {
        engagementReported = true;
        void track({ event: 'engage', command: 'openswarm' });
      }
      setInput('');
      const parsed = parseInput(raw);
      // A pending /plan confirm/edit consumes the next line verbatim.
      if (pending) {
        if (parsed?.kind === 'command' && parsed.name === '/goal' && parsed.args.trim() === 'clear') {
          const { resolve } = pending;
          pendingRef.current = null;
          setPending(null);
          runCommand(parsed.name, parsed.args);
          resolve('no');
          return;
        }
        const { resolve } = pending;
        pendingRef.current = null;
        setPending(null);
        resolve(raw);
        return;
      }
      if (!parsed) return;
      // While a goal is actively being pursued, only "/goal clear" is honored —
      // the pursuit runs to completion and nothing else can interrupt it. (INT-2014)
      if (goalActive && busy) {
        if (parsed.kind === 'command' && parsed.name === '/goal' && parsed.args.trim() === 'clear') {
          runCommand(parsed.name, parsed.args);
        } else {
          dispatch({ type: 'system', content: 'Goal in progress — type "/goal clear" to stop it.' });
        }
        return;
      }
      if (parsed.kind === 'command') {
        runCommand(parsed.name, parsed.args);
        return;
      }
      dispatch({ type: 'user', content: parsed.text });
      await streamChat(buildConversationPrompt([...historyToMessages(state.history), { role: 'user', content: parsed.text }]));
    },
    [pending, runCommand, streamChat, goalActive, busy, state.history],
  );

  // Keep the field active while a /plan confirm is pending, or while a goal is
  // being pursued (so the user can type "/goal clear"). (INT-2014)
  const inputActive = active && (!busy || pending !== null || goalActive);

  // Interactive command palette (INT-1959): ↑/↓ select, Enter/Tab complete.
  // A /provider|/model selector (INT-1960/1961) takes precedence when open.
  const matches = matchSlash(input);
  const selectorOpen = inputActive && selector !== null;
  const slashOpen = inputActive && pending === null && selector === null && matches.length > 0;
  const menuOpen = selectorOpen || slashOpen;
  const handleChange = useCallback((v: string) => {
    setInput(v);
    setPaletteIndex(0);
  }, []);
  const onSlashSelect = useCallback(() => {
    const cmd = matches[paletteIndex];
    if (!cmd) return;
    if (cmd.args) {
      // command takes args → complete to "name " so the user can type them
      setInput(`${cmd.name} `);
      setPaletteIndex(0);
    } else {
      setInput('');
      runCommand(cmd.name, '');
    }
  }, [matches, paletteIndex, runCommand]);

  return (
    <Box flexDirection="column">
      <ChatLog history={state.history} streaming={state.streaming} activity={activity} busy={busy && pending === null} />
      <ChatInput
        value={input}
        active={inputActive}
        busy={busy && pending === null && !goalActive}
        onChange={handleChange}
        onSubmit={submit}
        paletteOpen={menuOpen}
        onPaletteMove={(delta) =>
          selectorOpen
            ? setSelectorIndex((i) => movePaletteSelection(i, delta, selector!.items.length))
            : setPaletteIndex((i) => movePaletteSelection(i, delta, matches.length))
        }
        onPaletteSelect={() => (selectorOpen ? applySelector() : onSlashSelect())}
        onPaletteClose={() => {
          if (selectorOpen) {
            setSelector(null);
            setSelectorIndex(0);
          } else {
            setInput('');
          }
        }}
      />
      {selectorOpen ? (
        <SelectList title={selector!.title} items={selector!.items} selectedIndex={selectorIndex} />
      ) : (
        <CommandPalette matches={matches} selectedIndex={paletteIndex} />
      )}
    </Box>
  );
}
