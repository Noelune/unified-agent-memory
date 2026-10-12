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

### Option A — the Desktop plugin manager (recommended)

The Desktop app manages its own profile's packages from inside the app (its
plugin page, backed by `dsh-plugin-manager`). Install `dsh-unified-agent-memory`
from there, then add the vault configuration described in step 4.

This is the path the harness documents for Desktop: *"Desktop package operations
remain the responsibility of the Desktop shell."* Diagnostics for each operation
land in `profiles/desktop/.plugin-manager/logs/operation-*/pnpm.log`.

### Option B — the CLI, with the app fully quit

1. **Fully quit DeepSeek Harness Desktop.** Windows holds locks on the profile's
   `node_modules`, so an install attempted while the app runs will fail or hang.
2. Install into the desktop profile:

   ```sh
   dsh plugin --profile desktop add dsh-unified-agent-memory
   ```

   From a source checkout, use a local path instead of the registry name:

   ```sh
   dsh plugin --profile desktop add link:/absolute/path/to/unified-agent-memory
   ```

3. Restart the app.

Both options register the package in the profile's `dsh.profile.bundles` list,
which is what makes the harness apply the plugin's own `cordis.patch.yml` and
mount the tools.

---

## 4. Configure the vault (required)

Installing the bundle mounts the plugin but leaves `vaultPath` unset, so every
tool answers *"not configured"*. Add the configuration to the **desktop**
profile's `cordis.patch.yml`:

```yaml
# --- dsh-unified-agent-memory: shared memory tools and sidebar console ---
- id: dsh-unified-agent-memory
  config:
    vaultPath: 'C:/Users/<you>/path/to/Obsidian Vault'
```

A patch entry replaces the matched entry's whole config, so keep every field you
want to keep. Optional keys: `pythonPath` (default `python`), `corePath`
(defaults to the plugin's bundled `core/`, auto-added to `PYTHONPATH`) and
`remoteEnabled` (default `false`).

The same settings can be supplied by environment variables
(`UNIFIED_MEMORY_VAULT`, `UNIFIED_MEMORY_PYTHON`, `UNIFIED_MEMORY_COREPATH`)
instead of the patch file.

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

## 6. Desktop vs Web: what differs

| | Web (`profiles/web`) | Desktop (`profiles/desktop`) |
|---|---|---|
| Profile directory | `<harness home>/profiles/web` | `<harness home>/profiles/desktop` |
| Who manages packages | `dsh plugin --profile web` / the Web plugin page | The Desktop shell / `dsh plugin --profile desktop` (app must be quit) |
| Client half | sidebar footer action + overlay | identical — the plugin declares `platform: "web"`, which is what Desktop consumes |
| Host tools and HTTP routes | identical | identical |

The plugin does not need a separate Desktop build: Desktop runs the same web
client runtime, and there is no `desktop` client platform value to target.
