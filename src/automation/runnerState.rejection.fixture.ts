const rejectionFile = process.argv[2];
const issueId = process.argv[3];
const reason = process.argv[4];
if (!rejectionFile || !issueId || !reason) {
  console.error('usage: fixture <rejectionFile> <issueId> <reason>');
  process.exit(2);
}

process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE = rejectionFile;
process.env.HOME = process.env.HOME || '/tmp';
process.env.USERPROFILE = process.env.USERPROFILE || process.env.HOME;

const { incrementRejection } = await import('./runnerState.js');
const count = incrementRejection(issueId, reason);
process.stdout.write(String(count));
