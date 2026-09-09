import { RunLedger } from './runLedger.js';

const [dbPath, issueId, ownerInstanceId, nowText, maxActiveText, scopeText] = process.argv.slice(2);
if (!dbPath || !issueId || !ownerInstanceId || !nowText) {
  throw new Error('usage: runLedgerClaimProcess.fixture.ts <db> <issue> <owner> <now>');
}

const ledger = new RunLedger(dbPath);
try {
  ledger.registerRun({
    issueId,
    source: 'fixture',
    identifier: issueId,
    title: `Process race ${issueId}`,
    projectPath: '/process-repo',
    metadata: scopeText ? { fileScope: [scopeText] } : undefined,
  }, Number(nowText) - 1);
  const claimed = ledger.claimRun(issueId, {
    ownerInstanceId,
    leaseMs: 60_000,
    maxActiveForProject: maxActiveText ? Number(maxActiveText) : 1,
    conflictScope: scopeText ? [scopeText] : undefined,
    unknownScopeAdmission: 'serialize',
    now: Number(nowText),
  });
  process.stdout.write(claimed ? 'claimed\n' : 'blocked\n');
} finally {
  ledger.close();
}
