# 会话归档 — session archive

Raw / curated session history, one dated file per day. Written by
`integrations/hermes/archive_session.py` (or your runtime's post-turn hook).

Format per entry:

    ## HH:MM [agent name] [optional title]

    - one line per fact / note
    - ...

Rules:
- Never write plaintext credentials — only a label/path reference.
- Archived sessions are raw history, NOT canonical facts. Durable facts
  still get promoted only through the inbox → promoter.
