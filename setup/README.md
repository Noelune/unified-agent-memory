# setup/ — deterministic bootstrap and maintenance

These are the parts of the deployment that are safe to script. Everything that
requires judgement — writing each agent's global instruction file, deciding
whether a pending fact is worth promoting — is **agent work**, not script work;
that flow lives in [`docs/AGENT-DEPLOY.md`](../docs/AGENT-DEPLOY.md).

Run any of these from the installed package directory, or from a repository
checkout — the paths are identical.

## `setup.py`

| Command | What it does |
|---|---|
| `python setup/setup.py init --vault <path>` | Creates the vault from `vault-template/`, writes `~/.unified-memory.yaml`, and copies `AGENTS.md` / `CLAUDE.md` next to the vault. Idempotent with `--force` to overwrite. |
| `python setup/setup.py cron --vault <path>` | Registers the daily promotion job with the OS scheduler (crontab / Task Scheduler). A fallback for deployments where **no** agent has a scheduler. |
| `python setup/setup.py selfcheck` | Verifies the vault, the index and the plugin's view of both. |
| `python setup/setup.py agents` | **Deprecated and intentionally inert.** Prints guidance; global-instruction wiring is agent-driven. |

`init` is the one you need on a fresh install. It does not require `pip install`:
the core is importable straight from the package.

## `deploy.py`

The deployment helper behind `setup.py init`. It recognises only existing
allowlisted instruction files, writes exactly one marker-delimited section, takes
a backup, uses atomic replacement, and supports `rollback`. It never edits
canonical vault notes, sessions, credentials, or arbitrary runtime
configuration. `preview` before `apply`:

```sh
python setup/deploy.py preview
python setup/deploy.py apply
python setup/deploy.py rollback
```

## `selfcheck.py`

Standalone verification of an existing installation: vault layout, canonical
notes, index health and pending-inbox state. Useful in a cron job or after an
upgrade.

## `remote_index_server.py`

Optional. Serves read-only search over the vault to other machines **without
sharing the vault itself**:

```sh
python setup/remote_index_server.py --vault <path> --token <t> --host 127.0.0.1 --port 8437
```

The token stops forgery, not eavesdropping — terminate TLS in front of it for
anything beyond localhost. Clients point at it with `UNIFIED_MEMORY_REMOTE_URL`
and `UNIFIED_MEMORY_REMOTE_TOKEN`, then pass `--remote` to `memory search`. If it
is unreachable or the token is wrong, the client falls back to the local index
with a note on stderr.

## Note on Windows paths

Prefer a native path (`C:\Users\you\Documents\AgentMemory`) or the explicit
POSIX-style form (`C:/Users/you/Documents/AgentMemory`). A single leading slash
like `/tmp/...` is interpreted as drive-relative by Python on Windows.
