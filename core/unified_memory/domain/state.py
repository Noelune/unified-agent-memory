# -*- coding: utf-8 -*-
"""state — lifecycle transition tables for the three moving parts (batch B5).

One table per machine: ``{state: {event: next_state}}``. ``transition`` is the
only way code may move a lifecycle forward; an event that is not legal for the
current state raises ``ValueError`` instead of being silently ignored (Harel's
statecharts model; XState is the same contract with a runtime).

The tables describe the contract, not the storage. Inbox state today is
derived from file locations (inbox / 已处理 / the conflict queue) and claim
history lives under 已取代 headings — neither file format changes here; the
tables exist so the legal moves are explicit, tested and enforced at the two
wiring points that already hold a state in hand (promoter.decide's ruling and
plan_promotion's supersession).
"""
from __future__ import annotations

# submitted → triaged → pending_review → promoted | conflict | rejected.
# conflict hands ownership to the conflict queue (terminal for the inbox).
INBOX = {
    "submitted": {"triage": "triaged"},
    "triaged": {"review": "pending_review"},
    "pending_review": {"promote": "promoted", "conflict": "conflict", "reject": "rejected"},
}

# open --(用新 | 保留旧 | 并存 | 跳过)--> adjudicated. The four events are the
# same words promoter.DECISIONS carries; a consistency test pins them together.
CONFLICT = {
    "open": {
        "用新": "adjudicated",
        "保留旧": "adjudicated",
        "并存": "adjudicated",
        "跳过": "adjudicated",
    },
}

# active → superseded（被取代，历史保留）→ retired（合规删除，批次 C）。
# retired is terminal: GDPR-style deletion is the one move that ends a claim.
CLAIM = {
    "active": {"superseded": "superseded", "retired": "retired"},
    "superseded": {"retired": "retired"},
}

MACHINES = {"inbox": INBOX, "conflict": CONFLICT, "claim": CLAIM}


def transition(machine: str, current: str, event: str) -> str:
    """Move ``machine`` from ``current`` by ``event``; illegal moves raise.

    Raises ``ValueError`` for an unknown machine, an unknown state, or an event
    the current state does not accept — a caller who hits any of these is
    holding a lifecycle assumption the tables disagree with, and failing loudly
    is the contract (the old inline membership checks silently skipped).
    """
    table = MACHINES.get(machine)
    if table is None:
        raise ValueError(f"unknown state machine {machine!r}")
    events = table.get(current)
    if events is None:
        raise ValueError(f"{machine}: unknown state {current!r}")
    next_state = events.get(event)
    if next_state is None:
        raise ValueError(
            f"{machine}: illegal transition {current!r} --{event!r}--> "
            f"(legal events: {sorted(events)})"
        )
    return next_state
