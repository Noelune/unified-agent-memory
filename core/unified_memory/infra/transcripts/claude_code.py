# -*- coding: utf-8 -*-
"""infra.transcripts — platform transcript adapters (batch E3).

digest's main loop only knows the ``(label, date, transcript-text)`` triple;
this package turns platform-specific session transcripts into exactly that
text form. Tolerance contract: bad lines skipped, non-conversation lines
skipped, array content joined from its text blocks, and every produced line
passes redact() before leaving the adapter (the redaction red line).
"""
from __future__ import annotations

import json
from pathlib import Path

from ...domain.markdown import redact


def _content_text(content) -> str:
    """Flatten message content: str stays; list joins its text blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts)
    return ""


def claude_code_transcript(path: Path) -> str:
    """Parse one Claude Code session transcript (JSONL) into digest's text form.

    Tolerant by contract: bad lines skipped, non-conversation lines skipped,
    array content joined from its text blocks. Every produced line passes
    redact() before leaving the adapter.
    """
    lines: list[str] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        kind = entry.get("type")
        if kind not in ("user", "assistant"):
            continue
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        text = _content_text(content)
        if not text:
            continue
        role = "用户" if kind == "user" else "助手"
        for chunk in text.splitlines():
            chunk = chunk.strip()
            if chunk:
                lines.append(f"{role}: {redact(chunk)}")
    return "\n".join(lines) + ("\n" if lines else "")
