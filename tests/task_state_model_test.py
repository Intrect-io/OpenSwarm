# Task: AGT-3420 — nonnegative validators + dump_excluding_absent
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from task_state_model import ExecutionState, OpenSwarmTaskState


def test_retry_count_rejects_negative() -> None:
    with pytest.raises((ValueError, Exception)):
        ExecutionState(status="todo", retryCount=-1)


def test_topo_rank_rejects_negative() -> None:
    with pytest.raises((ValueError, Exception)):
        OpenSwarmTaskState(
            issueId="AGT-1",
            updatedAt=datetime.now(timezone.utc),
            topoRank=-3,
        )


def test_dump_excluding_absent_omits_none_optionals() -> None:
    state = OpenSwarmTaskState(
        issueId="AGT-1",
        updatedAt=datetime.now(timezone.utc),
    )
    dumped = state.dump_excluding_absent()
    assert "title" not in dumped
    assert "topoRank" not in dumped
    assert dumped["issueId"] == "AGT-1"
    assert "blockedReason" not in dumped["execution"]
