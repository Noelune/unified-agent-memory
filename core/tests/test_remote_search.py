# -*- coding: utf-8 -*-
import io
import os
import sys
import threading
import unittest
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


if __name__ == "__main__":
    unittest.main()
