# -*- coding: utf-8 -*-
"""3A provenance (P0-3): a digest-sourced fact stays traceable to its archive.

digest stamps every artifact with a machine-readable ``<!-- digest-source: … -->``
header; review reads it into the pending entry, the pending list carries the
溯源 field, and promotion writes it as a trailing ``（溯源：…）`` group — one
that strip_suffix removes again, so dedup and the search index never see it.
"""
import unittest

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import promoter
from unified_memory.app.ingest import digest as digest_mod
from unified_memory.common import canonical_dir, canonical_path, read_maybe, situation_dir
from unified_memory.domain.markdown import bare_fact_line, parse_stamp, write_provenance, write_stamp

ORIGIN = "会话归档/2026-11-05.md"


class ProvenanceTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def write_inbox(self, name, facts):
        path = canonical_dir(self.vault) / "Agent提交区" / name
        path.write_text("\n".join(f"- {f}" for f in facts) + "\n", encoding="utf-8")
        return path

    def test_write_provenance_rides_outside_the_stamp_and_strips_clean(self):
        line = (
            f"- 端口为 9443{write_stamp('dsh-x.md', '2026-11-06')}"
            f"{write_provenance(ORIGIN)} ^c-abc123def4567890"
        )
        self.assertIn(f"（溯源：{ORIGIN}）", line)
        # Dedup/index must see the bare fact only.
        self.assertEqual(bare_fact_line(line), "端口为 9443")
        # STAMP_RE's source group must not swallow the provenance group.
        created, source, _valid = parse_stamp(line)
        self.assertEqual(source, "Agent提交区/dsh-x.md")

    def test_digest_artifact_carries_its_source_header(self):
        written = digest_mod._write_digest_facts(
            self.vault, ["备份目录是 C:/backups"], origin=ORIGIN
        )
        self.assertEqual(written, 1)
        inbox = canonical_dir(self.vault) / "Agent提交区"
        artifact = next(p for p in inbox.glob("digest-*.md"))
        self.assertEqual(
            artifact.read_text(encoding="utf-8").splitlines()[0],
            f"<!-- digest-source: {ORIGIN} -->",
        )

    def test_digest_artifact_without_origin_has_no_header(self):
        digest_mod._write_digest_facts(self.vault, ["备份目录是 C:/backups"])
        inbox = canonical_dir(self.vault) / "Agent提交区"
        artifact = next(p for p in inbox.glob("digest-*.md"))
        self.assertNotIn("digest-source", artifact.read_text(encoding="utf-8"))

    def test_provenance_survives_review_to_promotion(self):
        digest_mod._write_digest_facts(self.vault, ["备份目录是 C:/backups"], origin=ORIGIN)
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(len(result["pending"]), 1)
        self.assertEqual(result["pending"][0].get("溯源"), ORIGIN)

        promoter.write_pending_list(self.vault, result)
        entries = promoter.parse_pending_list(self.vault)
        self.assertEqual(entries[0].get("溯源"), ORIGIN)

        promoter.apply_pending(self.vault)
        note = canonical_path(self.vault, entries[0]["分类"])
        text = note.read_text(encoding="utf-8")
        self.assertIn(f"（溯源：{ORIGIN}）", text)
        self.assertNotIn("digest-source", text, "the header form never reaches canonical")

        # Dedup stays exact-text: a resubmission of the same fact is a
        # duplicate even though the promoted line now carries provenance.
        self.write_inbox("dsh-20261106-120000-01.md", ["备份目录是 C:/backups"])
        again = promoter.review(self.vault, verbose=False)
        self.assertEqual(again["duplicates"], 1)
        self.assertEqual(again["pending"], [])


if __name__ == "__main__":
    unittest.main()
