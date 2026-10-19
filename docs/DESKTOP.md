# Desktop deployment (DeepSeek Harness Desktop)

The Desktop app runs a **different DSH profile** from the CLI/Web one, so a
plugin installed for Web is invisible on Desktop. This page covers the gate that
decides whether the plugin loads at all, and the two supported ways to install
it into Desktop.

---

## 1. Desktop uses its own profile

Desktop launches the same Cordis host, but points it at an application-owned
profile directory:

```
<harness home>/profiles/desktop
```

`profiles/web` (used by `dsh web` and the CLI) and `profiles/desktop` are
separate npm projects with separate `package.json` bundle lists, separate
`cordis.patch.yml` files and separate `node_modules`. Installing into one has no
effect on the other.

The practical consequence: **`dsh plugin --profile web add dsh-unified-agent-memory`
does not enable the memory tools in the Desktop app.** You must install into the
`desktop` profile (below) or the app will show no `memory_*` tools and no memory
console.

> Desktop reserves its profile. The CLI refuses to initialize it: if
> `profiles/desktop/package.json` does not exist you get
> *"Open DeepSeek Harness Desktop once to initialize its profile, then fully quit
> it before running `dsh plugin --profile desktop`."* Launch the app once, then
> quit it completely before installing.

---

## 2. The compatibility gate (read this before upgrading DSH)

Since DSH `0.2.0`, the harness checks a plugin's **`peerDependencies`** before it
imports the plugin, and refuses to load it when any `@deepseek-ai/dsh` or
`@deepseek-ai/dsh-*` entry does not match the running DSH version:

- Only `peerDependencies` keys beginning with `@deepseek-ai/dsh` are checked.
  `@deepseek-ai/cordis` and other scopes are ignored.
- Pre-release versions participate in range matching, so `0.2.0-rc.2` must be
  covered explicitly — a caret range such as `^0.1.0-rc.6` does **not** match it.
- An undeclared DSH peer imposes no constraint; an *invalid* range counts as
  incompatible.
- A **bundle** whose peers do not match is skipped entirely and reported on
  stderr as `skipping profile bundle …`. Its tools and routes are simply absent —
  there is no partial load and no error in the UI.

This is why the plugin's peer ranges are written as an explicit union
(`^0.1.0-rc.6 || >=0.2.0-rc.1 <0.3.0-0`) rather than a single caret range: each
DSH release line is opted into deliberately, because the host API is only
verified against the lines named there.

### When a version is genuinely incompatible

If the plugin declares no matching range for your DSH build, the install is
rejected before anything is downloaded, with an `incompatible-version` error
naming the package, version, runtime version and unsatisfied peers. Two options:

1. **Upgrade the plugin** (preferred) to a release that declares your DSH line.
2. **Grant an exact-version exemption** — an explicit, per-package,
   per-DSH-version risk acceptance stored in the profile's `compatibility.json`:

   ```sh
   dsh plugin --profile desktop allow-version \
     dsh-unified-agent-memory@0.7.0 --dsh-version 0.2.0-rc.2 --accept-risk
   ```

   The exemption covers exactly that package version on exactly that DSH
   version; neither a plugin upgrade nor a DSH upgrade inherits it. Only grant
   one after confirming the plugin actually works on that build — an incompatible
   host plugin runs in-process and can crash the app or corrupt data.

---

## 3. Install into Desktop

### Option A — the Desktop plugin manager (the only supported way)

The Desktop app manages its own profile's packages from inside the app (its
plugin page, backed by `dsh-plugin-manager`). Install `dsh-unified-agent-memory`
from there, then add the vault configuration described in step 4.

This is not merely the recommended route — it is the **only** one. The `dsh`
CLI refuses the desktop profile outright:

```
$ dsh plugin --profile desktop add dsh-unified-agent-memory
error: profile "desktop" is managed exclusively by the Electron application
```

The refusal is deliberate and cannot be bypassed from the command line. The
check is `rejectElectronProfile()` in the CLI's argument parser, and the escape
hatch that skips it (`manageDesktopProfile`) is a programmatic option that only
the Desktop application itself passes — there is no flag, environment variable,
or config key that enables it.

**Install an exact version, not the bare name.** The desktop profile's `.npmrc`
may point at a mirror, and a mirror lags the canonical registry: its
`dist-tags` can still advertise an older `latest` long after the new version's
tarball is available. Requesting the bare name then resolves to the stale
version. Ask for the version explicitly:

```
dsh-unified-agent-memory@0.7.0
```

Check what a mirror currently serves before blaming the plugin:

```sh
curl -s https://registry.npmmirror.com/dsh-unified-agent-memory/dist-tags
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmmirror.com/dsh-unified-agent-memory/0.7.0
```

Diagnostics for each operation land in
`profiles/desktop/.plugin-manager/logs/operation-*/pnpm.log`.

> **If an install appears to hang with no output**, the profile write lock is
> stuck behind a pnpm process that never exited — not a problem with the plugin.
> See [Troubleshooting a stuck install](#6-troubleshooting-a-stuck-install).

### Option B — a local checkout (development only)

To iterate on the plugin source, link your checkout into the desktop profile
instead of publishing. This still has to go through the Desktop plugin manager;
from a local path it accepts the directory directly:

```
link:C:/path/to/unified-agent-memory
```

Because the profile is `patchReload`-capable, rebuild with `npm run build` after
each source change — never while an install is running (see the troubleshooting
section for why).

---

## 4. Configure the vault (required)

Installing the bundle mounts the plugin but leaves `vaultPath` unset, so every
tool answers *"not configured"*. There are three ways to fix that, and the
plugin honours them in this order (highest first):

1. **`vaultPath` in the plugin config** — the `cordis.patch.yml` entry below.
2. **`UNIFIED_MEMORY_VAULT`** in the environment the app starts with.
3. **`~/.unified-memory.yaml`** — the file `setup.py init` writes. **If you
   already initialized a vault from the repo, this is already set and you need
   to do nothing here.**

That third source matters: the plugin used to consult only its own config, so an
install relying on the file reported `configured: false` and made every tool
answer *"not configured"* while the sidebar console happily served live data
from the same vault — the console and the agent disagreed about the same
machine. 0.7.0 mirrors the core's precedence, so the two always agree. Check
what the plugin resolved:

```sh
curl -s http://127.0.0.1:19387/api/dsh-unified-agent-memory/status
```

`configured: true` and a real `vaultPath` mean you are done.

To set it explicitly instead, add the configuration to the **desktop** profile's
`cordis.patch.yml`:

```yaml
# --- dsh-unified-agent-memory: shared memory tools and sidebar console ---
- id: dsh-unified-agent-memory
  config:
    vaultPath: 'C:/Users/<you>/path/to/Obsidian Vault'
```

A patch entry replaces the matched entry's whole config, so keep every field you
want to keep. Optional keys: `pythonPath` (default `python`), `corePath`
(defaults to the plugin's bundled `core/`, auto-added to `PYTHONPATH`),
`remoteEnabled` (default `false`) and `agentName` — the submission prefix in
`Agent提交区/`. `agentName` defaults to `dsh-<profile>` (so desktop and web
runtimes sharing one vault stay distinguishable) and falls back to plain `dsh`
when the host publishes no profile; `UNIFIED_MEMORY_AGENT` overrides it when the
plugin config does not set it.

The profile name is read from the host's `profileContext` service, not from the
environment: `DSH_PROFILE` is injected into model shell commands and never into
the plugin's own process, so an env-only lookup always concluded "no profile".
Setting `agentName` explicitly in the patch layer still wins, and is the right
move if you want a fixed prefix regardless of which profile is running.

---

## 4b. What else ships with the plugin

The npm package is self-contained. After installing it you already have, inside
`<harness home>/profiles/desktop/node_modules/dsh-unified-agent-memory/`:

| Content | Path | What it is for |
|---|---|---|
| Python core | `core/unified_memory/` | The engine the tools call. Auto-added to `PYTHONPATH` — **no pip install needed**. |
| Vault template | `vault-template/` | A ready-to-use Obsidian vault skeleton. |
| Setup scripts | `setup/setup.py`, `setup/deploy.py`, `setup/selfcheck.py` | `init` / `cron` / `selfcheck`, and the deployment helper. |
| Agent templates | `integrations/codex/AGENTS.md`, `integrations/claude/CLAUDE.md` | Global-instruction starting points, copied next to a new vault. |
| Hermes hooks | `integrations/hermes/*.py` | Optional pre-turn injection, daily cron, session archiving. |
| Docs | `docs/` | Including `AGENT-DEPLOY.md`, the agent-driven wiring task book. |

To bootstrap a vault from the installed package (no clone required):

```sh
python "<harness home>/profiles/desktop/node_modules/dsh-unified-agent-memory/setup/setup.py" \
  init --vault "C:/Users/<you>/Documents/AgentMemory"
```

That creates the vault, writes `~/.unified-memory.yaml`, and drops
`AGENTS.md` / `CLAUDE.md` next to it. Then have the agent read
`docs/AGENT-DEPLOY.md` and follow it to wire each agent's global instruction
file.

> Releases before 0.7.0 shipped neither `setup/` nor the `integrations/{codex,claude}`
> templates, so an npm install could not initialize a vault at all. If you are on
> an older version, upgrade or use a git clone.

---

## 5. Verify

1. Restart the app and open a session.
2. Call `memory_status`. It should report the vault path, FTS5 availability and
   the pending-inbox count. On a fresh vault it prints a deployment notice
   pointing at `docs/AGENT-DEPLOY.md`.
3. Open the sidebar console: the memory entry sits in the sidebar footer beside
   Settings and opens a floating sheet with search and the four figures.

If step 2 answers *"not configured"*, the patch entry from step 4 is missing or
the app was not restarted. If the tools are missing entirely, check the app's
stderr log for `skipping profile bundle` — that is the compatibility gate from
section 2.

---

## 6. Troubleshooting a stuck install

**Symptom:** the plugin page shows an install "in progress" indefinitely, with
no output and no error.

This is not the plugin and not the compatibility gate. The profile has a write
lock (`profiles/desktop/package.json.lock`) plus a run record
(`profiles/desktop/.plugin-manager/run.json`). The manager refuses to start a
second pnpm while `run.json` names a live run, so if a pnpm process finished its
work but never exited, every later install waits on that lock forever.

Diagnose by comparing three things:

| Check | Healthy | Stuck |
|---|---|---|
| `package.json.lock` holder | absent, or a live *host* pid | present, unchanged for minutes |
| `.plugin-manager/run.json` | absent | present, naming a pid |
| A `pnpm` process actually running | yes, while installing | **none** |

If the lock names a pid that is alive but `run.json` points at a pnpm process
that is **not** consuming CPU, the recorded run is a zombie.

To confirm before acting, sample its CPU twice ~20 s apart: a genuinely working
process advances; a zombie reports an identical value.

**Recovery:** end the stuck pnpm child — not the Desktop host — then leave the
app alone. The host releases the lock and clears `run.json` by itself within
seconds, because it was only waiting on that child:

```powershell
Stop-Process -Id <pnpm-pid> -Force
```

Verify `package.json.lock` and `run.json` have both disappeared before retrying.
Do not delete them while the host is alive and waiting: the host legitimately
holds the lock for the duration of a run, and removing it mid-flight can let two
pnpm processes write the same profile concurrently.

**Avoiding it:** let an install finish before starting another, and never run a
build (`npm run build`) in a linked checkout while an install is in progress —
a `link:` profile rebuilds in place, and a half-written `lib/index.js` is exactly
what produces `invalid plugin, expect function or object with an "apply" method`.

---

## 7. Desktop vs Web: what differs

| | Web (`profiles/web`) | Desktop (`profiles/desktop`) |
|---|---|---|
| Profile directory | `<harness home>/profiles/web` | `<harness home>/profiles/desktop` |
| Who manages packages | `dsh plugin --profile web` / the Web plugin page | **The Desktop shell only** — the CLI refuses this profile |
| Client half | sidebar footer action + overlay | identical — the plugin declares `platform: "web"`, which is what Desktop consumes |
| Host tools and HTTP routes | identical | identical |

The plugin does not need a separate Desktop build: Desktop runs the same web
client runtime, and there is no `desktop` client platform value to target.
