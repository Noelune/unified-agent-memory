# -*- coding: utf-8 -*-
"""app — use-case layer: the commands' bodies (batch B5).

May import domain + infra + app siblings; never surface (the parser owns that)
and never the flat legacy modules except through the architecture test's
documented whitelist entries (embed/digest migrations are blocked by the
security scanner's SSRF rule — see BATCH-REPORT.md).
"""
