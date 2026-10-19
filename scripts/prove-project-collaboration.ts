/** Opt-in live-provider proof in an isolated validation repository; never touches daemon state. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const output = process.argv[2];
assert(output, 'Usage: <evidence.json>');
const root = mkdtempSync(join(tmpdir(), 'project-collaboration-live-'));
const repo = join(root, 'validation-project'); mkdirSync(repo);
for (const [name, suffix] of Object.entries({ OPENSWARM_AUTOMATION_DB: 'automation.db', OPENSWARM_COORDINATION_FILE: 'coordination.json',
  OPENSWARM_SESSION_LOG_DIR: 'sessions', OPENSWARM_USAGE_DIR: 'usage', OPENSWARM_SCRATCHPAD_DIR: 'scratch' })) process.env[name] = join(root, suffix);
const { getAdapter, spawnCli } = await import('../src/adapters/index.js');
const { syncChannels } = await import('../src/coordination/channelStore.js');
const { sendChannelMessage, getChannelDelivery } = await import('../src/coordination/channelQueue.js');
const { getCoordinationThread } = await import('../src/coordination/coordinationThreads.js');
const { repositoryCell } = await import('../src/coordination/repositoryCell.js');
const { OrchestratorSupervisor } = await import('../src/coordination/orchestratorSupervisor.js');
const { resolveOrchestratorConfig } = await import('../src/coordination/orchestratorConfig.js');
const { runOrchestrator } = await import('../src/coordination/orchestratorAgent.js');
const adapter = getAdapter('codex-responses');
assert(await adapter.isAvailable(), 'No configured codex-responses account; live receipt remains unverified');
const model = process.env.PROJECT_PROOF_MODEL ?? 'gpt-5.6-luna';
syncChannels([repo]); const repoKey = repositoryCell(repo).repoKey;
const nonce = `PROOF-${randomUUID()}`;
const general = sendChannelMessage({ repoKey, body: `Isolated receipt check. Do not read files, search the web or contact external services. Respond with exactly ${nonce}.`, idempotencyKey: randomUUID() });
const supervisor = new OrchestratorSupervisor({
  config: resolveOrchestratorConfig({ orchestrator: { enabled: true, adapter: 'codex-responses', model, reasoningEffort: 'low', maxTurns: 2, timeoutMs: 60_000 } })!,
  getRepositories: () => [repo], getPending: () => [],
  buildInstructionCapsule: () => ({ text: 'This is an isolated validation project. Only acknowledge the provided nonce. Never contact other people or systems.', digest: '', sources: [], errors: [], repositoryRoot: repo }),
  run: runOrchestrator,
});
await supervisor.requestSweep(); await supervisor.stop();
assert.equal(getChannelDelivery(general.id).status, 'responded');
const generalReadback = getCoordinationThread({ repository: repoKey, threadId: general.threadId });
assert(generalReadback.messages.items.some((m) => m.actorRole === 'orchestrator' && m.body.includes(nonce)));
const taskNonce = `RECEIPT-${randomUUID()}`;
const context = { repository: repo, repoKey, taskId: 'isolated-task', actor: 'validation-worker', actorName: 'Validation worker', actorRole: 'worker' };
const task = sendChannelMessage({ repoKey, taskId: context.taskId, recipient: context.actor, body: `Reply with exactly ${taskNonce} in the existing discussion.`, idempotencyKey: randomUUID() });
const result = await spawnCli(adapter, { cwd: repo, prompt: 'Isolated inbox proof. Call coordination_read. Find the operator message. Call coordination_thread_reply on exactly the threadId from its metadata, body equal to the requested RECEIPT token, delivery_id copied exactly from metadata.deliveryId, and a stable idempotency_key. Do not call any external tools, files, tracker or web search. Then finish.',
  model, reasoningEffort: 'low', maxTurns: 5, timeoutMs: 60_000, coordinationContext: context,
  shellTools: false, filesystemTools: false, webTools: false, memoryTools: false, mcpTools: [],
  processContext: { taskId: 'isolated-task', stage: 'worker' } });
assert.equal(result.exitCode, 0);
const taskReadback = getCoordinationThread({ repository: repoKey, threadId: task.threadId });
assert.equal(getChannelDelivery(task.id).status, 'responded');
assert(taskReadback.messages.items.some((m) => m.actor === context.actor && m.taskId === context.taskId && m.body === taskNonce && m.replyToDeliveryId === task.id));
const evidence = { verifiedAt: new Date().toISOString(), root, repoKey, adapter: adapter.name, model,
  general: { delivery: getChannelDelivery(general.id), messages: generalReadback.messages.items.map(({ id, actor, actorRole, body }) => ({ id, actor, actorRole, body })) },
  task: { delivery: getChannelDelivery(task.id), messages: taskReadback.messages.items.map(({ id, actor, taskId, body, replyToDeliveryId }) => ({ id, actor, taskId, body, replyToDeliveryId })) },
  boundary: 'Real native provider and coordination tools with an isolated store. Direct durable send; not production scheduler/HTTP deployment proof.' };
writeFileSync(output, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ verified: true, root, model, coordinator: evidence.general.delivery.status, recipient: evidence.task.delivery.status }));
