# Audit residuals: what landed and what remains

The 2026-08-09 `review --max` audit filed umbrella cards. Most pull requests
written for them close one slice of a card, not the whole card. This file
records, per card, what the security-boundaries batch landed and what an
independent review against each card's acceptance criteria found still open.
Use it before moving a card to Done.

Batch: PRs #882 #883 #895 #897 #899 #900 #898 #851 #848, plus the review fixes
that follow them on the same branch.

| Card | Landed in this batch | Still open |
|------|----------------------|------------|
| AGT-3436 shell expansion bypasses | #882: run-time words in program and flag position, subshells, compound prefixes, git subcommand position. Review fixes: process substitution only outside double quotes, `$"..."`, globbed program names (`/bin/r[m]`), `coproc`, an unquoted program word after a launcher (`sudo $X /x`). | A bare-word target after a launcher (`X="rm -rf"; sudo $X build`). Data executed by a shell (`echo "rm -rf /x" \| sh`, `bash <<< "..."`). |
| AGT-3467 trust boundaries | #883: the repo snapshot is read with `O_NOFOLLOW` under a size cap. Review fixes: the open is non-blocking, so a FIFO cannot hang it; `.openswarm`'s identity is compared before and after the open; a symlinked `.openswarm` no longer makes every run rescan in full. | No hard-link test. PKCE loopback binding was already on main. |
| AGT-3447 repository boundaries | #895: graph export writes through a pinned `.openswarm` directory. Verification fails closed without an OS sandbox on macOS and on unknown platforms. Review fix: a rename that landed outside the pinned directory is now detected after the fact and fails the write. | Detection only: Node has no `renameat`, so the file can still be carried out before the check notices. `workSessionRoutes` diff race safety and overlapping checkpoint IDs were not verified. |
| AGT-3441 pipeline inputs and isolation | #897: malformed bus files are quarantined, tester fields are validated, guard paths are contained, and non-executing evidence is rejected. Review fixes: evidence counts only segments that can run (no comments, no short-circuited or `if` segments), and a bus read error is retried rather than quarantined. | Fan-out isolation: `workerFanout.ts` still symlinks shared project paths into candidate sandboxes. Path containment covers guards and evidence, not every project-path check. |
| AGT-3431 filesystem containment | #899: the input debug log is tightened to 0600. Review fix: it is opened `O_NOFOLLOW` and refused when hard-linked or owned by another user. | `designPipeline.ts` creates `.github/workflows` through a symlinked `.github`. |
| AGT-3423 subprocess bounds and cancellation | #900: `openswarm work` handles SIGTERM through the cancellation path, and retained CLI stdout/stderr is tail-bounded. Review fixes: the live-log stream remainder is capped; a failure message quotes retained stderr without the truncation marker; the force-quit hint shows only for SIGINT. | `support/dev.ts` accumulates task output without a bound. Over 32M characters, codex's earliest executed commands fall out of the retained output, so the evidence gate can refuse a run that did test (fail closed). |
| AGT-3433 issue and delivery mutations | #898: background auto-link jobs are bounded and a timed-out job cannot write late. | The card's other six items need item-by-item evidence. Earlier commits appear to cover grooming ID filtering, CI polling deadline, outbound claim, idempotent create, cursor progress, and executable-source evidence, but this batch did not verify them. |

Two PRs carry no card:

- #851 bounds trace metadata by UTF-8 bytes and widens the shell guard to
  process substitution. Review fixes: object metadata is copied before the
  bound, and process substitution is recognised only outside double quotes.
- #848 removes Wrangler directories from the worker's writable roots and warns
  when `sharedPaths` names a secret-like path. Review fix: the warning comes
  from `resolveSharedPaths`, so fan-out and verification sandboxes raise it
  too. The real-write test still runs only where `/usr/bin/bwrap` exists.
