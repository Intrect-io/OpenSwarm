// Global test setup (vitest). Keep tests from touching the real home dir.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect chat-session persistence to a temp dir so ChatPanel renders (which
// fire a saveSession effect) never write to the real ~/.openswarm/chat. (INT-2014)
process.env.OPENSWARM_CHAT_DIR = join(tmpdir(), 'openswarm-test-chat');

// Redirect the agent coordination board the same way: several suites exercise
// the real store (worker routing, the agentic loop's ask_human stop), and
// without this they append fixture events to the operator's live
// ~/.openswarm/coordination.json.
process.env.OPENSWARM_COORDINATION_FILE = join(tmpdir(), 'openswarm-test-coordination', 'events.json');
