// ============================================
// OpenSwarm - Shared `/plan` cockpit logic
// ============================================
//
// The TUI's planner cockpit: turn a goal into a previewed decomposition, gate on
// human approval, then dispatch to the daemon loop. Shared by the readline
// (chat.ts) and blessed (chatTui.ts) front-ends — each supplies its own I/O via
// the `PlanIO` interface, so the planning/approval/dispatch logic lives in one
// place (in keeping with the adapter-parser dedup, INT-1441).
//
// The Planner itself (runPlanner) and the dispatch engine (POST /api/plan/dispatch
// → createSubIssuesWithDependencies / exec pipeline) already exist; this only adds
// the human-in-the-loop approval surface.
//
// Dispatch Path A enforces `autonomous.decomposition.maxChildrenPerTask` via
// refuseForChildCap but does **not** call reserveDailyCreations — that admission
// gate paces the unsupervised runner only (AGT-4123 Option 2). Created children
// still flow through createSubIssuesWithDependencies → registerDecomposition.

import { runPlanner, type SubTask } from './planner.js';

const DAEMON_BASE = 'http://127.0.0.1:3847';

export interface PlanIO {
  /** Print one line to the surface (chatLog / stdout). */
  print(line: string): void;
  /** Ask the user to approve the plan. Returns the chosen action. */
  confirm(prompt: string): Promise<'yes' | 'no' | 'edit'>;
  /** Optional free-text prompt — used by 'edit' to drop sub-tasks. If absent, 'edit' cancels. */
  promptText?(prompt: string): Promise<string>;
}

export interface PlanCommandOptions {
  projectPath?: string;
  model?: string;
}

/**
 * Run the `/plan <goal>` flow: plan → render → approve/edit → dispatch.
 */
export async function runPlanCommand(
  goal: string,
  io: PlanIO,
  opts: PlanCommandOptions = {},
): Promise<void> {
  const trimmed = goal.trim();
  if (!trimmed) {
    io.print('Usage: /plan <goal>');
    return;
  }
  const projectPath = opts.projectPath ?? process.cwd();

  io.print(`🧭 Planning: ${trimmed}`);
  io.print('   (running the Planner — may take up to ~2 min; requires the claude CLI)');

  let result: Awaited<ReturnType<typeof runPlanner>>;
  try {
    result = await runPlanner({
      taskTitle: trimmed,
      taskDescription: trimmed,
      projectPath,
      model: opts.model,
    });
  } catch (err) {
    // The planner can reject (e.g. RateLimitError, CLI missing) — contain it so
    // the command surface never surfaces an unhandled promise rejection.
    const message = err instanceof Error ? err.message : String(err);
    io.print(`✖ Planner failed: ${message}`);
    return;
  }

  if (!result.success) {
    io.print(`✖ Planner failed: ${result.error ?? 'unknown error'}`);
    return;
  }

  // No decomposition → dispatch the goal itself as a single task.
  if (!result.needsDecomposition || result.subTasks.length === 0) {
    io.print(`• No decomposition needed — single task (~${result.totalEstimatedMinutes || '?'} min).`);
    const decision = await io.confirm('Dispatch this goal as one task? [y/n]');
    if (decision !== 'yes') {
      io.print('Cancelled.');
      return;
    }
    await dispatch(trimmed, [], projectPath, io);
    return;
  }

  // Render + approval loop. 'edit' drops sub-tasks by number, then re-renders.
  let subTasks: SubTask[] = [...result.subTasks];
  for (;;) {
    renderPlan(trimmed, subTasks, io);
    const decision = await io.confirm('Approve & dispatch this plan? [y/n/edit]');

    if (decision === 'no') {
      io.print('Cancelled.');
      return;
    }

    if (decision === 'edit') {
      if (!io.promptText) {
        io.print('Editing is not available on this surface — cancelling.');
        return;
      }
      const raw = await io.promptText('Sub-task numbers to DROP (comma-separated), or blank to keep all:');
      const drop = new Set(
        raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n)),
      );
      if (drop.size > 0) {
        subTasks = subTasks.filter((_, i) => !drop.has(i + 1));
        if (subTasks.length === 0) {
          io.print('All sub-tasks dropped — cancelling.');
          return;
        }
      }
      continue;
    }

    // 'yes'
    await dispatch(trimmed, subTasks, projectPath, io);
    return;
  }
}

function renderPlan(goal: string, subTasks: SubTask[], io: PlanIO): void {
  const total = subTasks.reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);
  io.print('');
  io.print(`📋 Plan for: ${goal}`);
  io.print(`   ${subTasks.length} sub-task(s), ~${total} min total`);
  subTasks.forEach((st, i) => {
    const deps = st.dependencies?.length ? `  ⮑ after: ${st.dependencies.join(', ')}` : '';
    io.print(`   ${i + 1}. [P${st.priority} · ${st.estimatedMinutes}m] ${st.title}${deps}`);
  });
  io.print('');
}

async function dispatch(
  goal: string,
  subTasks: SubTask[],
  projectPath: string,
  io: PlanIO,
): Promise<void> {
  try {
    const res = await fetch(`${DAEMON_BASE}/api/plan/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, projectPath, subTasks }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
      io.print(`✖ Dispatch failed: ${err.error ?? res.status}`);
      return;
    }
    const data = (await res.json()) as {
      mode: string;
      parentIssue?: { identifier?: string };
      taskIds?: string[];
    };
    if (data.mode === 'linear') {
      io.print(`✅ Dispatched to Linear (${data.parentIssue?.identifier ?? 'parent issue'}). The daemon will pick it up — watch the Tasks tab.`);
    } else {
      io.print(`✅ Dispatched ${data.taskIds?.length ?? 0} task(s) to the exec pipeline — watch the Tasks tab.`);
    }
  } catch {
    io.print('✖ Could not reach the daemon at :3847. Start it with `openswarm start`, then retry.');
  }
}
