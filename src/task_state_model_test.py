"""Tests for task_state_model.py.

Covers two contracts:
  * strict numeric fields — the canonical Zod schema uses
    `z.number().int().nonnegative()` / `z.number().min(0).max(1)`, so a JSON
    string or boolean must be rejected rather than coerced;
  * camelCase serialization — absent optionals are omitted and true JSON
    numbers round-trip unchanged.

Both Pydantic backends the module supports are exercised: the installed v2
model and a v1-forced copy (the module keeps a v1 compatibility branch).
"""

from __future__ import annotations

import importlib.util
import sys
import types
import warnings
from pathlib import Path

import pytest

# Allow `python -m pytest src/task_state_model_test.py` without installing a package.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from task_state_model import ExecutionState, OpenSwarmTaskState  # noqa: E402

MODEL_PATH = Path(__file__).resolve().parent / "task_state_model.py"


def _load_v1_model():
    """Import task_state_model with Pydantic v1 semantics forced."""
    try:
        import pydantic.v1 as pydantic_v1
    except ImportError:  # pragma: no cover - v2 always ships the shim
        return None
    if not hasattr(pydantic_v1, "validator"):
        return None

    fake = types.ModuleType("pydantic")
    fake.BaseModel = pydantic_v1.BaseModel
    fake.Field = pydantic_v1.Field
    fake.validator = pydantic_v1.validator

    spec = importlib.util.spec_from_file_location("task_state_model_v1", MODEL_PATH)
    module = importlib.util.module_from_spec(spec)
    saved = sys.modules.get("pydantic")
    sys.modules["pydantic"] = fake
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            spec.loader.exec_module(module)
            # `from __future__ import annotations` leaves stringised forward
            # refs that the v1 shim cannot resolve on its own.
            module.ExecutionState.update_forward_refs(**vars(module))
            module.OpenSwarmTaskState.update_forward_refs(**vars(module))
    finally:
        if saved is not None:
            sys.modules["pydantic"] = saved
        else:
            del sys.modules["pydantic"]
    return module


_V1_MODEL = _load_v1_model()


def _models():
    """(backend, ExecutionState, OpenSwarmTaskState) pairs under test."""
    pairs = [("v2", ExecutionState, OpenSwarmTaskState)]
    if _V1_MODEL is not None:
        pairs.append(("v1", _V1_MODEL.ExecutionState, _V1_MODEL.OpenSwarmTaskState))
    return pairs


BACKENDS = [name for name, _, _ in _models()]


def _exec_state(backend, **kwargs):
    for name, execution, _ in _models():
        if name == backend:
            return execution(**kwargs)
    raise AssertionError(f"unknown backend {backend}")


def _task_state(backend, **kwargs):
    for name, _, task_state in _models():
        if name == backend:
            return task_state(**kwargs)
    raise AssertionError(f"unknown backend {backend}")


def _dump(state, backend):
    """model_dump(by_alias=True, mode='json'); v1's shim rejects `mode`."""
    kwargs = {"by_alias": True}
    if backend != "v1":
        kwargs["mode"] = "json"
    return state.model_dump(**kwargs)


class TestStrictNumericFields:
    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_numeric_string_retry_count(self, backend):
        with pytest.raises(ValueError):
            _exec_state(backend, retryCount="1")

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_boolean_retry_count(self, backend):
        with pytest.raises(ValueError):
            _exec_state(backend, retryCount=True)

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_word_string_retry_count(self, backend):
        with pytest.raises(ValueError):
            _exec_state(backend, retryCount="true")

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_accepts_genuine_int_retry_count(self, backend):
        assert _exec_state(backend, retryCount=1).retry_count == 1

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_accepts_zero_retry_count(self, backend):
        assert _exec_state(backend, retryCount=0).retry_count == 0

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_accepts_whole_float_retry_count(self, backend):
        assert _exec_state(backend, retryCount=1.0).retry_count == 1

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_fractional_retry_count(self, backend):
        with pytest.raises(ValueError):
            _exec_state(backend, retryCount=1.5)

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_negative_retry_count(self, backend):
        with pytest.raises(ValueError):
            _exec_state(backend, retryCount=-1)

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_defaults_absent_retry_count(self, backend):
        assert _exec_state(backend).retry_count == 0

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_numeric_string_topo_rank(self, backend):
        with pytest.raises(ValueError):
            _task_state(backend, issueId="AGT-1", topoRank="1", updatedAt="2026-01-01T00:00:00Z")

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_boolean_topo_rank(self, backend):
        with pytest.raises(ValueError):
            _task_state(backend, issueId="AGT-1", topoRank=True, updatedAt="2026-01-01T00:00:00Z")

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_accepts_genuine_int_topo_rank(self, backend):
        state = _task_state(backend, issueId="AGT-1", topoRank=2, updatedAt="2026-01-01T00:00:00Z")
        assert state.topo_rank == 2

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_numeric_string_confidence(self, backend):
        with pytest.raises(ValueError):
            _exec_state(backend, confidence="0.5")

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_boolean_confidence(self, backend):
        with pytest.raises(ValueError):
            _exec_state(backend, confidence=True)

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_accepts_numeric_confidence(self, backend):
        assert _exec_state(backend, confidence=0.5).confidence == 0.5
        assert _exec_state(backend, confidence=0).confidence == 0.0
        assert _exec_state(backend, confidence=1).confidence == 1.0

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_rejects_out_of_range_confidence(self, backend):
        with pytest.raises(ValueError):
            _exec_state(backend, confidence=1.5)
        with pytest.raises(ValueError):
            _exec_state(backend, confidence=-0.1)


class TestCamelCaseSerialization:
    @pytest.mark.parametrize("backend", BACKENDS)
    def test_round_trips_genuine_numbers_with_camel_case_aliases(self, backend):
        state = _task_state(
            backend,
            issueId="AGT-1",
            topoRank=2,
            execution={"status": "todo", "retryCount": 1, "confidence": 0.5},
            updatedAt="2026-01-01T00:00:00Z",
        )
        dumped = _dump(state, backend)

        assert dumped["issueId"] == "AGT-1"
        assert dumped["topoRank"] == 2
        assert dumped["execution"]["retryCount"] == 1
        assert dumped["execution"]["confidence"] == 0.5
        assert isinstance(dumped["execution"]["retryCount"], int)

    @pytest.mark.parametrize("backend", BACKENDS)
    def test_omits_absent_optionals(self, backend):
        state = _task_state(backend, issueId="AGT-1", updatedAt="2026-01-01T00:00:00Z")
        dumped = _dump(state, backend)

        for absent in ("issueIdentifier", "title", "projectId", "parentIssueId", "topoRank"):
            assert absent not in dumped
        assert dumped["execution"] == {"status": "backlog", "retryCount": 0}
        assert dumped["worktree"] == {}
