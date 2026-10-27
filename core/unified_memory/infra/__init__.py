# -*- coding: utf-8 -*-
"""infra — process and storage plumbing: standard library + domain only.

vault (paths, atomic writes) · lock (file_lock) · config (~/.unified-memory.yaml)
· schedule (schedule state) · console (encoding guard) · store (SQL, from B2)
· sessiondb (the one external-DB adapter).
"""
