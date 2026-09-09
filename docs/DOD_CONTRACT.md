# Executable DoD contract

An issue may declare the coordinator-owned part of its Definition of Done in a
fenced JSON block. The block is policy only: verification commands still come
from the repository's trusted verify configuration, and no command from an
issue description is executed.

```openswarm:dod
{
  "version": 1,
  "completion": {
    "noChanges": "park"
  },
  "automation": {
    "scopeMismatch": "retry_ephemeral",
    "maxRepairs": 1
  }
}
```

## What the coordinator will resolve

| Outcome | Default without a contract | With a contract |
| -- | -- | -- |
| Worker stated that no source edit is required (`Worker finished without edits: …`) | Park | `completion.noChanges: complete` marks the run Done |
| Worker claimed success with zero diff and no reason | Park | Always park — that is an unfinished run, not a no-op |
| Publication fence lists *only* ephemeral artifacts | One bounded retry (residual) | `automation.scopeMismatch` and `maxRepairs` (0–3) |
| A source/test/docs file is outside reserved scope | Park | Always park — a contract cannot widen write scope |
| Malformed `openswarm:dod` block | Park, with the parse error | — |

`completion.noChanges` may be `complete` only when the worker actually stated
why no edit was required. The silent stuck-loop park (same code, different
reason) is never auto-completed.

The live publication fence already drops ephemeral artifacts before it throws
(`assertBranchWithinWriteScope`). The ephemeral retry is residual defence for
a park reason that still lists only those paths. Repairs are capped at three.
The default is one.
