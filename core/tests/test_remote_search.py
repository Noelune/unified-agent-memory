# -*- coding: utf-8 -*-
import io
import os
import sys
import threading
import unittest
import json
import socket
import urllib.error
import urllib.request
from argparse import Namespace
from contextlib import redirect_stderr, redirect_stdout
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from setup.remote_index_server import Handler  # noqa: E402

from test_common import destroy_scratch, make_scratch_vault  # noqa: E402
from unified_memory import memory as mem_mod  # noqa: E402
from unified_memory.common import canonical_path  # noqa: E402


class RemoteServer:
    def __init__(self, vault, token):
        Handler.vault = vault
        Handler.token = token
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class RemoteSearchTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(prefs.read_text(encoding="utf-8") + "\n- prefers indigo terminal prompts\n", encoding="utf-8")

    def tearDown(self):
        os.environ.pop("UNIFIED_MEMORY_REMOTE_URL", None)
        os.environ.pop("UNIFIED_MEMORY_REMOTE_TOKEN", None)
        destroy_scratch(self.vault)

    def test_remote_search_hits_server(self):
        server = RemoteServer(self.vault, "tok123")
        self.addCleanup(server.close)
        os.environ["UNIFIED_MEMORY_REMOTE_URL"] = server.url
        os.environ["UNIFIED_MEMORY_REMOTE_TOKEN"] = "tok123"
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.cmd_search(Namespace(query="indigo", limit=8, remote=True))
        out = buf.getvalue()
        self.assertIn("<memory-data>", out)
        self.assertIn("indigo", out)

    def test_bad_token_falls_back_to_local(self):
        server = RemoteServer(self.vault, "tok123")
        self.addCleanup(server.close)
        os.environ["UNIFIED_MEMORY_REMOTE_URL"] = server.url
        os.environ["UNIFIED_MEMORY_REMOTE_TOKEN"] = "wrong"
        err, buf = io.StringIO(), io.StringIO()
        with redirect_stdout(buf), redirect_stderr(err):
            mem_mod.cmd_search(Namespace(query="indigo", limit=8, remote=True))
        self.assertIn("fell back to local", err.getvalue())
        self.assertIn("indigo", buf.getvalue())

    def test_unreachable_falls_back_to_local(self):
        os.environ["UNIFIED_MEMORY_REMOTE_URL"] = "http://127.0.0.1:1"
        os.environ["UNIFIED_MEMORY_REMOTE_TOKEN"] = "tok"
        err, buf = io.StringIO(), io.StringIO()
        with redirect_stdout(buf), redirect_stderr(err):
            mem_mod.cmd_search(Namespace(query="indigo", limit=8, remote=True))
        self.assertIn("fell back to local", err.getvalue())
        self.assertIn("indigo", buf.getvalue())

    def test_unconfigured_reports_error(self):
        with self.assertRaises(SystemExit):
            mem_mod.cmd_search(Namespace(query="x", limit=8, remote=True))

    def test_remote_search_without_local_vault(self):
        # A pure remote client (no local vault at all) must still be able to
        # query the remote index — ensure_vault must not block the remote path.
        server = RemoteServer(self.vault, "tok123")
        self.addCleanup(server.close)
        os.environ["UNIFIED_MEMORY_REMOTE_URL"] = server.url
        os.environ["UNIFIED_MEMORY_REMOTE_TOKEN"] = "tok123"
        os.environ["UNIFIED_MEMORY_VAULT"] = str(Path(self.vault).parent / "does-not-exist")
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.cmd_search(Namespace(query="indigo", limit=8, remote=True))
        out = buf.getvalue()
        self.assertIn("<memory-data>", out)
        self.assertIn("indigo", out)

    def test_remote_search_redacts_canonical_credentials(self):
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text("# Preferences\n\n- api_key: remote-index-secret\n", encoding="utf-8")
        server = RemoteServer(self.vault, "tok123")
        self.addCleanup(server.close)
        request = urllib.request.Request(
            server.url + "/search",
            data=json.dumps({"query": "api_key", "limit": 8}).encode("utf-8"),
            headers={"Authorization": "Bearer tok123", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            body = response.read().decode("utf-8")
        self.assertNotIn("remote-index-secret", body)

    def test_remote_search_rejects_json_scalars_as_bad_requests(self):
        server = RemoteServer(self.vault, "tok123")
        self.addCleanup(server.close)
        for payload in (b"[]", b'"query"', b"null"):
            request = urllib.request.Request(
                server.url + "/search",
                data=payload,
                headers={"Authorization": "Bearer tok123", "Content-Type": "application/json"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request)
            self.assertEqual(raised.exception.code, 400)

    def test_remote_search_times_out_an_incomplete_request_body(self):
        server = RemoteServer(self.vault, "tok123")
        self.addCleanup(server.close)
        old_timeout = Handler.request_timeout_seconds
        Handler.request_timeout_seconds = 0.1
        self.addCleanup(setattr, Handler, "request_timeout_seconds", old_timeout)
        with socket.create_connection(("127.0.0.1", server.server.server_address[1])) as client:
            client.settimeout(1)
            client.sendall(
                b"POST /search HTTP/1.1\r\n"
                b"Host: localhost\r\n"
                b"Authorization: Bearer tok123\r\n"
                b"Content-Length: 8\r\n\r\n"
                b"{"
            )
            response = client.recv(4096)
        self.assertTrue(response.startswith(b"HTTP/1.0 408"))


if __name__ == "__main__":
    unittest.main()
