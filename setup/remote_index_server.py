#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Minimal dependency-free remote semantic-index server.

Serves search over a unified-agent-memory vault so other machines can query
the same facts without sharing the whole vault. Requires a Bearer token; use
TLS (HTTPS) in front of it for anything beyond localhost — a token stops
forgery, not eavesdropping.

    python setup/remote_index_server.py --vault <path> --token <t> [--host 127.0.0.1 --port 8437]

Endpoints:
    GET  /health  -> {"ok": true, "protocol": "1.0"}
    POST /search  body {"query": "...", "limit": 8} -> {"ok": true, "results": [...]}
    Authorization: Bearer <token>
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from unified_memory import memory as mem_mod  # noqa: E402


class Handler(BaseHTTPRequestHandler):
    vault: Path = None
    token: str = ""

    def log_message(self, fmt, *args):
        sys.stderr.write("[remote-index] " + (fmt % args) + "\n")

    def _auth_ok(self) -> bool:
        expected = "Bearer " + self.token
        return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") != "/health":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        if not self._auth_ok():
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return
        self._send_json(200, {"ok": True, "protocol": "1.0"})

    def do_POST(self):
        if self.path.rstrip("/") != "/search":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        if not self._auth_ok():
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            query = str(payload.get("query", "")).strip()
            if not query:
                self._send_json(400, {"ok": False, "error": "empty query"})
                return
            limit = int(payload.get("limit", 8))
            result = mem_mod.search_index(query, limit, self.vault)
            self._send_json(200, {"ok": True, "results": result["results"]})
        except Exception as exc:  # noqa: BLE001
            self._send_json(500, {"ok": False, "error": str(exc)})


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="remote_index_server", description=__doc__)
    ap.add_argument("--vault", default=None)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8437)
    ap.add_argument("--token", default="")
    args = ap.parse_args(argv)
    vault = Path(args.vault) if args.vault else mem_mod.resolve_vault()
    Handler.vault = vault
    Handler.token = args.token or os.environ.get("UNIFIED_MEMORY_REMOTE_TOKEN", "")
    if not Handler.token:
        raise SystemExit("error: --token (or UNIFIED_MEMORY_REMOTE_TOKEN) is required")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("warning: serving beyond localhost — a token stops forgery, NOT eavesdropping. Terminate TLS in front of this port.")
    print(f"remote index server on {args.host}:{args.port} for vault {vault}")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
