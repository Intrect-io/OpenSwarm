"""Tests for task_state_model.py — confidence integer validation."""

import pytest
from src.task_state_model import ExecutionState


class TestConfidenceValidation:
    def test_accepts_integer_zero(self):
        state = ExecutionState(status="done", confidence=0)
        assert state.confidence == 0

    def test_accepts_integer_one_hundred(self):
        state = ExecutionState(status="done", confidence=100)
        assert state.confidence == 100

    def test_accepts_integer_midrange(self):
        state = ExecutionState(status="done", confidence=75)
        assert state.confidence == 75

    def test_accepts_none(self):
        state = ExecutionState(status="backlog", confidence=None)
        assert state.confidence is None

    def test_rejects_float(self):
        with pytest.raises(ValueError, match="confidence must be an integer"):
            ExecutionState(status="done", confidence=75.5)

    def test_rejects_float_zero(self):
        with pytest.raises(ValueError, match="confidence must be an integer"):
            ExecutionState(status="done", confidence=0.0)

    def test_rejects_out_of_range_negative(self):
        with pytest.raises(ValueError):
            ExecutionState(status="done", confidence=-1)

    def test_rejects_out_of_range_above_100(self):
        with pytest.raises(ValueError):
            ExecutionState(status="done", confidence=101)

    def test_rejects_string(self):
        with pytest.raises(ValueError):
            ExecutionState(status="done", confidence="high")