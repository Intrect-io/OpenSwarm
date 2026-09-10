"""Pydantic mirror of OpenSwarm canonical task state."""

from __future__ import annotations

from datetime import datetime
from math import isfinite
from typing import Literal

try:
    from pydantic import BaseModel, ConfigDict, Field, field_validator
except ImportError:  # Pydantic v1 compatibility
    from pydantic import BaseModel, Field

    ConfigDict = None  # type: ignore[assignment]
    field_validator = None  # type: ignore[assignment]


TaskExecutionStatus = Literal[
    "backlog",
    "todo",
    "ready",
    "blocked",
    "in_progress",
    "in_review",
    "decomposed",
    "done",
    "failed",
    "halted",
]


if ConfigDict is not None:

    class AliasModel(BaseModel):
        model_config = ConfigDict(populate_by_name=True)

        def model_dump(self, **kwargs):
            """Omit absent optional fields from default serialization."""
            kwargs.setdefault("exclude_none", True)
            return super().model_dump(**kwargs)

        def model_dump_json(self, **kwargs):
            """Omit absent optional fields from default JSON serialization."""
            kwargs.setdefault("exclude_none", True)
            return super().model_dump_json(**kwargs)

else:

    class AliasModel(BaseModel):
        class Config:
            allow_population_by_field_name = True

        def dict(self, **kwargs):
            kwargs.setdefault("exclude_none", True)
            return super().dict(**kwargs)

        def json(self, **kwargs):
            kwargs.setdefault("exclude_none", True)
            return super().json(**kwargs)

        # Pydantic v2 API alias used by callers / sanity checks.
        def model_dump(self, **kwargs):
            by_alias = kwargs.pop("by_alias", False)
            return self.dict(by_alias=by_alias, **kwargs)


class WorktreeState(AliasModel):
    branch_name: str | None = Field(default=None, alias="branchName")
    worktree_path: str | None = Field(default=None, alias="worktreePath")
    owner_agent: str | None = Field(default=None, alias="ownerAgent")
    lease_expires_at: datetime | None = Field(default=None, alias="leaseExpiresAt")


def _coerce_nonneg_int(v: object, *, field: str) -> int:
    """Accept canonical integral values (int, whole float, digit string)."""
    if isinstance(v, bool):
        raise ValueError(f"Expected non-negative integral {field}, got {v!r}")
    if isinstance(v, int):
        if v < 0:
            raise ValueError(f"Expected non-negative integral {field}, got {v!r}")
        return v
    if isinstance(v, float):
        if not isfinite(v) or v != int(v) or v < 0:
            raise ValueError(f"Expected non-negative integral {field}, got {v!r}")
        return int(v)
    if isinstance(v, str):
        try:
            n = int(v)
            if n >= 0:
                return n
        except (ValueError, TypeError):
            pass
        raise ValueError(f"Expected non-negative integral {field}, got {v!r}")
    raise ValueError(f"Expected non-negative integral {field}, got {v!r}")


class ExecutionState(AliasModel):
    status: TaskExecutionStatus = "backlog"
    blocked_reason: str | None = Field(default=None, alias="blockedReason")
    retry_count: int = Field(default=0, alias="retryCount", ge=0)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    last_session_id: str | None = Field(default=None, alias="lastSessionId")

    if field_validator is not None:
        @field_validator("retry_count", mode="before")
        @classmethod
        def coerce_retry_count(cls, v: object) -> int:
            if v is None:
                return 0
            return _coerce_nonneg_int(v, field="retryCount")


class OpenSwarmTaskState(AliasModel):
    version: Literal[1] = 1
    issue_id: str = Field(alias="issueId")
    issue_identifier: str | None = Field(default=None, alias="issueIdentifier")
    title: str | None = None
    project_id: str | None = Field(default=None, alias="projectId")
    project_name: str | None = Field(default=None, alias="projectName")
    parent_issue_id: str | None = Field(default=None, alias="parentIssueId")
    child_issue_ids: list[str] = Field(default_factory=list, alias="childIssueIds")
    dependency_issue_ids: list[str] = Field(default_factory=list, alias="dependencyIssueIds")
    dependency_titles: list[str] = Field(default_factory=list, alias="dependencyTitles")
    file_scope: list[str] = Field(default_factory=list, alias="fileScope")
    topo_rank: int | None = Field(default=None, alias="topoRank", ge=0)
    linear_state: str | None = Field(default=None, alias="linearState")
    execution: ExecutionState = Field(default_factory=ExecutionState)
    worktree: WorktreeState = Field(default_factory=WorktreeState)
    updated_at: datetime = Field(alias="updatedAt")

    if field_validator is not None:
        @field_validator("topo_rank", mode="before")
        @classmethod
        def coerce_topo_rank(cls, v: object) -> int | None:
            if v is None:
                return None
            return _coerce_nonneg_int(v, field="topoRank")