// Global test setup (vitest). Keep tests from touching the real home dir.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Vitest forks a worker per file (measured: distinct pids and VITEST_POOL_IDs),
// so anything scoped to the run is shared by every worker at once. Every path
// below is therefore scoped per worker.
const workerScope = `${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}`;

// Redirect chat-session persistence to a temp dir so ChatPanel renders (which
// fire a saveSession effect) never write to the real ~/.openswarm/chat. (INT-2014)
// Per worker because listing sessions is a `readdir` of the whole directory, so
// a shared one lets a worker observe another worker's sessions.
process.env.OPENSWARM_CHAT_DIR = join(tmpdir(), 'openswarm-test-chat', workerScope);

// Redirect the agent coordination board away from the real home dir: several
// suites exercise the real store (worker routing, the agentic loop's ask_human
// stop), and without this they append fixture events to the operator's live
// ~/.openswarm/coordination.json.
//
// Per worker, not per run: `consume` is a destructive read-modify-write behind
// a file lock, so one shared board puts every worker in contention. That
// surfaces as a `coordination_read` which errors — and only a NON-erroring read
// resets the inbox-nudge clock (agenticLoop.ts), so the nudge fires and the
// test asserting it must not goes red. It passed in isolation and failed only
// in the full suite, which is the signature. (AGT-4087)
process.env.OPENSWARM_COORDINATION_FILE = join(tmpdir(), 'openswarm-test-coordination', workerScope, 'events.json');

// The board mirrors every published event into the automation database, so the
// same suites that write fixture events would otherwise append them to the
// operator's live ~/.openswarm/automation.db — and pay a synchronous SQLite
// write for each one, which is slow enough at suite scale to matter. Scoped
// per worker for the same reason as the board: sharing it would reintroduce
// the contention the line above removes.
process.env.OPENSWARM_AUTOMATION_DB = join(tmpdir(), 'openswarm-test-automation', workerScope, 'automation.db');

// The agentic loop appends a usage-ledger line for every model response it
// sees, including the fake responses loop tests feed it. Keep those out of the
// operator's live ~/.openswarm/usage/. Per worker: ledger tests read the whole
// directory back. (AGT-4178)
process.env.OPENSWARM_USAGE_DIR = join(tmpdir(), 'openswarm-test-usage', workerScope);

// Same shape as the usage ledger above: the agentic loop now opens a session
// recorder per invocation, so every loop test would otherwise leave a JSONL
// transcript in the operator's live ~/.openswarm/sessions/. Redirected rather
// than disabled, so the wiring stays exercised by those tests. Per worker
// because pruning reads the whole directory back. (AGT-4442)
process.env.OPENSWARM_SESSION_LOG_DIR = join(tmpdir(), 'openswarm-test-sessions', workerScope);

// Same reason as the session log above: pipeline tests build worker options
// that carry a scratchpad id, and a tool test that writes a note would land it
// in the operator's live ~/.openswarm/scratch/. Per worker because the prune
// sweep reads the whole directory back. (AGT-4459)
process.env.OPENSWARM_SCRATCHPAD_DIR = join(tmpdir(), 'openswarm-test-scratch', workerScope);

// Two settings, for two different hazards (AGT-4460).
//
// The directory redirect is the same story as the two above: without it a test
// leaves a snapshot store in the operator's live ~/.openswarm/snapshots/. That
// is worse here than elsewhere — a store is keyed by run id, and a fixture
// using a real identifier writes trees of the TEST's checkout under that run's
// name. A later rollback of the real run would restore the wrong repository
// into it. Observed exactly once, before this line existed.
process.env.OPENSWARM_SNAPSHOT_DIR = join(tmpdir(), 'openswarm-test-snapshots', workerScope);
// Off by default because a rollback writes to `projectPath`, and pipeline tests
// pass `process.cwd()` — a stagnating test could revert the developer's working
// tree. Tests that exercise snapshots delete this in their own beforeEach and
// point projectPath at a temporary worktree.
process.env.OPENSWARM_SNAPSHOT = '0';
