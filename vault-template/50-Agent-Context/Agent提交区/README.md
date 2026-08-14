# Agent提交区 — write inbox

All agents write new facts here as individual files:

    <agent>-<YYYYMMDD>-<HHMMSS>-<nn>.md

Format: one fact per line, optional "- " prefix. Example:

    - the build server listens on 127.0.0.1:8080

Rules:
- Never write plaintext credentials — only a label/path reference.
- Never edit other agents' files or canonical notes here.
- The promoter (python -m unified_memory.promoter) classifies, dedups,
  detects conflicts and appends to canonical notes; files are then archived
  into 已处理/.
