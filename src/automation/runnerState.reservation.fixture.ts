// Child-process fixture for the cross-process reservation guard: claims `count`
// slots against `limit` in a process of its own, so the parent can race two real
// runners against one shared state file. Prints "1" when granted, "0" when
// refused, and "e:<message>" on error.
//
// The process then stays alive for `holdMs` so a peer deciding in that window
// sees a LIVE holder. Exiting immediately would instead exercise the unrelated
// path that reclaims a dead predecessor's slots — the fixture would prove
// nothing about the concurrent case it is here to guard.

const count = Number(process.argv[2]);
const limit = Number(process.argv[3]);
const holdMs = Number(process.argv[4] ?? 0);
if (!Number.isInteger(count) || !Number.isInteger(limit) || !Number.isInteger(holdMs)) {
  console.error('usage: fixture <count> <limit> [holdMs]');
  process.exit(2);
}

process.env.HOME = process.env.HOME || '/tmp';
process.env.USERPROFILE = process.env.USERPROFILE || process.env.HOME;

const { reserveDailyCreations } = await import('./runnerState.js');
try {
  process.stdout.write(reserveDailyCreations(count, limit) ? '1' : '0');
} catch (error) {
  process.stdout.write(`e:${error instanceof Error ? error.message : String(error)}`);
}
if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
