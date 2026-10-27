# -*- coding: utf-8 -*-
"""Lifecycle state machines (batch B5, domain/state.py).

Covers the three tables (inbox / conflict / claim), the illegal-transition
contract, and the two wiring points: promoter's DECISIONS set must equal the
CONFLICT machine's legal events, and promoter.decide routes its validation
through the machine.
"""
from __future__ import annotations

import unittest

from unified_memory.domain import state
from unified_memory import promoter


class TransitionContractTests(unittest.TestCase):
    def test_inbox_happy_path_and_terminals(self) -> None:
        self.assertEqual(state.transition("inbox", "submitted", "triage"), "triaged")
        self.assertEqual(state.transition("inbox", "triaged", "review"), "pending_review")
        self.assertEqual(state.transition("inbox", "pending_review", "promote"), "promoted")
        self.assertEqual(state.transition("inbox", "pending_review", "conflict"), "conflict")
        self.assertEqual(state.transition("inbox", "pending_review", "reject"), "rejected")

    def test_conflict_accepts_exactly_the_four_rulings(self) -> None:
        for ruling in ("用新", "保留旧", "并存", "跳过"):
            self.assertEqual(state.transition("conflict", "open", ruling), "adjudicated")

    def test_claim_moves_and_terminals(self) -> None:
        self.assertEqual(state.transition("claim", "active", "superseded"), "superseded")
        self.assertEqual(state.transition("claim", "active", "retired"), "retired")
        self.assertEqual(state.transition("claim", "superseded", "retired"), "retired")

    def test_illegal_moves_raise(self) -> None:
        for machine, current, event in (
            ("claim", "superseded", "superseded"),   # 不可"再取代"
            ("claim", "retired", "superseded"),      # retired 是终态
            ("conflict", "adjudicated", "用新"),      # 已裁决不可再裁
            ("inbox", "submitted", "promote"),       # 不可跳过 triage/review
            ("inbox", "promoted", "reject"),         # promoted 是终态
        ):
            with self.assertRaises(ValueError, msg=f"{machine}/{current}/{event}"):
                state.transition(machine, current, event)

    def test_unknown_machine_state_or_event_raise(self) -> None:
        with self.assertRaises(ValueError):
            state.transition("nope", "submitted", "triage")
        with self.assertRaises(ValueError):
            state.transition("claim", "nope", "retired")
        with self.assertRaises(ValueError):
            state.transition("claim", "active", "nope")


class ConsistencyWithPromoterTests(unittest.TestCase):
    def test_decisions_set_matches_conflict_machine(self) -> None:
        # Order is promoter's (interactive surfaces iterate it); the SET and
        # the order of the four rulings are pinned to the machine.
        self.assertEqual(tuple(state.CONFLICT["open"]), promoter.DECISIONS)

    def test_decide_routes_through_the_machine(self) -> None:
        # An unknown choice is rejected with the same envelope as before; the
        # validation itself now lives in domain.state.
        result = promoter.decide(
            "C:\\nonexistent-vault", "whatever-key", "不存在的裁决"
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "unknown-choice")


if __name__ == "__main__":
    unittest.main()
