"""Pydantic mirror of OpenSwarm canonical task state."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

try:
    from pydantic import BaseModel, ConfigDict, Field
except ImportError:  # Pydantic v1 compatibility
    from pydantic import BaseModel, Field

    ConfigDict = None  # type: ignore[assignment]


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

else:

    class AliasModel(BaseModel):
        class Config:
            allow_population_by_field_name = True


class WorktreeState(AliasModel):
    branch_name: str | None = Field(default=None, alias="branchName")
    worktree_path: str | None = Field(default=None, alias="worktreePath")
    owner_agent: str | None = Field(default=None, alias="ownerAgent")
    lease_expires_at: datetime | None = Field(default=None, alias="leaseExpiresAt")


class ExecutionState(AliasModel):
    status: TaskExecutionStatus = "backlog"
    blocked_reason: str | None = Field(default=None, alias="blockedReason")
    retry_count: int = Field(default=0, alias="retryCount")
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    last_session_id: str | None = Field(default=None, alias="lastSessionId")


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
    topo_rank: int | None = Field(default=None, alias="topoRank")
    linear_state: str | None = Field(default=None, alias="linearState")
    execution: ExecutionState = Field(default_factory=ExecutionState)
    worktree: WorktreeState = Field(default_factory=WorktreeState)
    updated_at: datetime = Field(alias="updatedAt")

    def model_dump(self, **kwargs):
        """Omit absent optional fields from serialization."""
        kwargs.setdefault("exclude_none", True)
        return super().model_dump(**kwargs)

    def model_dump_json(self, **kwargs):
        """Omit absent optional fields from JSON serialization."""
        kwargs.setdefault("exclude_none", True)
        return super().model_dump_json(**kwargs)