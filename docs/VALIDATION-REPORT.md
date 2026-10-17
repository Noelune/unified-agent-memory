# Validation report

Date: 2026-09-12

## Compatibility target

> **Superseded for the current release.** This report records the 2026-09-12
> validation against DSH `0.1.5-rc.2`. The current target line is recorded in
> [Re-validation (2026-10-18)](#re-validation-2026-10-18-dsh-021-rc2), with the
> earlier DSH `0.2.0-rc.2` pass in
> [Re-validation (2026-10-13)](#re-validation-2026-10-13) below.

- DSH: `0.1.5-rc.2` / npm `next`
- `@deepseek-ai/dsh-tools`: `0.1.5-rc.2`
- `@deepseek-ai/cordis`: `4.0.2`
- Node.js: `v24.12.0` (package engine remains `>=20`)
- Python: `3.13.14`

The stable npm `latest` line remains a separate compatibility boundary and was not
claimed as independently validated by this change.

## Tests and checks

| Check | Result |
| --- | --- |
| `python core/run_tests.py` | `Ran 92 tests in 10.333s`, `OK`, exit `0` |
| `python -m unittest discover -s core/tests -p test_promoter.py -t core/tests` | `Ran 21 tests`, `OK`, exit `0` |
| `python -m unittest discover -s setup/tests -p 'test*.py' -t setup/tests` | `Ran 5 tests`, `OK`, exit `0` |
| `npm run test:node` | 7 passed, 0 failed, exit `0` |
| `node --check` for plugin, client, and audit script | exit `0` |
| Python bytecode compilation for changed Python entry points | exit `0` |
| `npm ls --depth=0` | expected DSH dependency versions resolved |
| `npm run pack:audit` | `npm package audit ok: 49 entries`, exit `0` |
| `git diff --check` | exit `0` |

## Deployment black-box flow

A temporary home containing only an allowlisted Codex instruction file was used.
The following all passed:

- `detect` found only the existing allowlisted target.
- `preview` reported a change and did not modify the target.
- `apply` created a backup and wrote exactly one managed marker block.
- A second `apply` was a no-op and produced byte-identical content.
- `selfcheck` returned `ok`.
- `rollback` restored the original user content.
- A target outside the allowlist was rejected with exit code `2`.

The Windows concurrent conflict-write regression was also reproduced and fixed:
8/8 concurrent writers completed without exceptions and all 8 conflict entries were
preserved. The production fix uses an in-process per-vault lock in addition to the
existing cross-process lock file, and publishes the conflict queue atomically.

## Privacy audit

The final audit covered:

- 83 current tracked/non-ignored files.
- 152 Git blob objects, including reachable and locally unreachable objects.
- Absolute user paths, private tool paths, RFC1918 addresses, and common AWS/OpenAI
  key formats.

Result: `working_hits=0`, `history_hits=0`.

The npm package audit also excludes vault runtime data, session archives, SQLite/DB
files, credentials, environment files, backups, logs, local configuration, and test /
deployment-only material according to the package allowlist and ignore rules.

## History and recovery

Git history was rewritten because an old planning document contained local absolute
paths and a loopback Web URL. The old refs were removed from the repository after
verification and the unreachable-object cleanup. A complete pre-rewrite Git bundle
was retained in the session's temporary workspace as a recovery artifact; it is not
part of the repository or npm package.

The remote default branch still needs the authorized non-fast-forward update caused
by this history rewrite. No npm publish or external service configuration change was
performed.

## Remaining boundary

- Stable DSH `latest` was documented as a separate boundary, not asserted as tested.
- The live DSH GUI was not rebuilt or modified; validation covers the isolated plugin
  host contract and local deployment tooling only.

## Re-validation (2026-10-13)

Re-validated the plugin against the DSH version shipped with the Desktop client,
after weeks of upstream changes. Scope: the plugin host contract, the client
bundle, and the repo's own gates. The Desktop *application* was not modified and
the plugin was not installed into the Desktop profile as part of this pass — see
[docs/DESKTOP.md](DESKTOP.md) for that procedure.

### Compatibility target (current)

- DSH: `0.2.0-rc.2` (CLI/Web and Desktop) and `0.1.5-rc.2` (retained)
- `@deepseek-ai/dsh-tools`: `0.2.0-rc.2`
- `@deepseek-ai/dsh-host-webserver`: `0.2.0-rc.2`
- `@deepseek-ai/cordis`: `4.0.4`
- Node.js: `v24.12.0` (package engine remains `>=20`)
- Python: `3.11.9` and `3.13.14` (both green)

### Upstream API delta (0.1.5-rc.2 → 0.2.0-rc.2)

| Surface | Change | Effect on this plugin |
| --- | --- | --- |
| `dsh-tools` `register(ToolDefinition)` | unchanged | none |
| `dsh-tools` `DefineToolOptions` | added optional `deferLoading`, `projectContent` | none |
| `dsh-host-webserver` route types | byte-identical; `kind: 'exact'` still valid | none |
| `cordis` 4.0.2 → 4.0.4 | `isApplicable` / `inject` / `apply` unchanged; `Fiber.update()` return widened | none |
| Plugin compatibility check | **new in 0.2.0**: `@deepseek-ai/dsh*` peers are validated against the runtime before import | **required the peer-range change below** |
| `dsh.plugin.json` | no longer read anywhere in the 0.2.0 tree | kept for third-party marketplace readers; no longer the compatibility authority |

### Findings and fixes

1. **The committed peer range excluded 0.2.0.** `@deepseek-ai/dsh-tools: ^0.1.0-rc.6`
   does not satisfy `0.2.0-rc.2` (pre-releases do not match a caret range whose
   upper bound is `0.2.0`), so the bundle was skipped wholesale and neither the
   tools nor the HTTP routes registered. Fixed by declaring an explicit union:
   `^0.1.0-rc.6 || >=0.2.0-rc.1 <0.3.0-0`.
2. **Desktop never loaded the plugin.** The Desktop app runs the reserved
   `profiles/desktop` profile, not `profiles/web`, so the Web installation had no
   effect there. Documented the install path in `docs/DESKTOP.md`.
3. **Seven dead tests.** `test/*.test.mjs` were excluded from vitest and run by no
   script, and two of the three files asserted a pre-refactor API (`plugin.default`,
   an optional `webServer`, four tools, `contextPath`, `memoryUiStatus`). Rewritten
   against the current contract and wired into the gates as `npm run test:node`.
4. **`npm pack --json` was corrupted by the build's stdout.** Adding a `prepack`
   build made `audit:package` fail with a JSON parse error, because the build
   printed progress to stdout. Progress now goes to stderr.

### Tests and checks (current)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit `0` |
| `npm run test:js` | 18 files, 403 tests, all passed, exit `0` |
| `npm run test:node` | 19 tests, all passed, exit `0` (was 2 passed / 7 failed, ungated) |
| `npm run build` | bundles + type declarations emitted, exit `0` |
| `npm run drift:check` | 22 checks passed, exit `0` |
| `npm run audit:package` | `npm package audit ok: 92 entries`, exit `0` |
| `npm run test` (Python 3.11.9) | exit `0` |

Not green: `npm run sync:check`, which reports the registry's `0.5.2` against the
local `v0.6.0` tag. That is a release-state fact (the tag was never published),
not a defect; it clears on `npm publish`.

### Remaining boundary (current)

- The plugin was **not** installed into the Desktop profile during this pass. Doing
  so requires fully quitting the Desktop app, which was hosting the session.
- The `compatibility.json` exemption path was read from the upstream docs and CLI
  source, but no exemption was exercised.

## Re-validation (2026-10-18): DSH 0.2.1-rc.2

Trigger: the Desktop client moved to `dsh` `0.2.1-rc.2` (app version `44.7.0`).
Question asked: did the upgrade break the plugin, and if so where?

### Compatibility target (current)

- DSH: `0.2.1-rc.2` (CLI/Web, and the runtime the Desktop app loads)
- `@deepseek-ai/dsh-tools`: `0.2.1-rc.2`
- `@deepseek-ai/dsh-host-webserver`: `0.2.1-rc.2`
- `@deepseek-ai/cordis`: `4.0.5` (upstream moved `~4.0.4` → `~4.0.5`; the declared
  `^4.0.1` peer still covers it)
- Node.js `v24.12.0`, npm `11.6.2`, Python `3.11.9`

### Upstream API delta (0.2.0-rc.2 → 0.2.1-rc.2)

| Surface | Change | Effect on this plugin |
| --- | --- | --- |
| `dsh-host-webserver` | `match()` still resolves exact routes before prefixes; `register` / `registerFallback` signatures unchanged. The package grew for transport options, not routing | none |
| `dsh-tools` | `ToolPresentationMode` dropped `'both'`; `renderToolsSdk` gained `programFormat`; `createRunCodeTool` gained `ctx`; tool entries gained `meta?: JsonValue` | none — only `defineTool` and `ctx.tools.register` are used |
| `dsh-client-ui-slots` | `lib/index.js` is byte-identical to `0.2.0-rc.2` (sha256 `57E1314E…`); only typings and READMEs changed | none |
| Plugin compatibility gate | Mechanism unchanged: a bundle whose `@deepseek-ai/dsh*` peer ranges exclude the running runtime is skipped wholesale; per-pair grants live in the profile's `compatibility.json` | this plugin's ranges include `0.2.1-rc.2`, so it is not skipped |

### Findings and fixes

1. **No plugin code needed to change.** With devDependencies resolved to
   `0.2.1-rc.2`, `tsc --noEmit` is clean and all 421 vitest cases pass. The four
   API surfaces the plugin touches (`defineTool`, `ctx.tools.register`,
   `webServer.register({ kind: 'exact' })`, `slots.inject` / `slots.register`)
   are unchanged in 0.2.1.
2. **The declared support matrix was stale.** Neither `package.json` nor
   `dsh.plugin.json` listed `0.2.1-rc.2`. The gate reads peer ranges, so this did
   not break loading — but it told readers (and marketplace surfaces) that the
   newest tested version was `0.2.0-rc.2`. Both maps now list
   `"0.2.1-rc.2": "compatible"`; drift-check compares the two and would fail on
   a one-sided edit.
3. **The lockfile still pinned `0.2.0-rc.2`.** CI installs with `npm ci`, which
   refuses (or silently installs the wrong tree) when the lock disagrees with
   `package.json`. Regenerated; `npm ci` then succeeded from a clean
   `node_modules` and the full gate ran against that tree.
4. **The compatibility declaration was untested.** `test/version-sync.test.mjs`
   now asserts that the DSH version pinned in `devDependencies` appears as
   `"compatible"` in both manifests. It was written first and failed with
   `must list 0.2.1-rc.2 as "compatible"` before the fix.
5. **The client bundle was never executed.** `test/web-ui-contract.test.mjs`
   previously only pattern-matched the shipped bundle. It now runs
   `lib/client-ui.js` inside a `vm` host that emulates
   `window.__ModuleLoader__`, calls the factory, and drives `apply()` with a
   `slots` stand-in, asserting both seats (`sidebar.footer.action`,
   `shell.overlay`) are registered with their stable ids and a component.
6. **Out of scope, but visible on the same machine.** The Web profile now skips
   `@dsh-external/dsh-vision-toolkit@0.1.4` and `@anionex/dsh-turn-rewind@0.3.9`
   (their own `@deepseek-ai/dsh*` peer ranges exclude `0.2.1-rc.2`), and the
   `better-sidebar` patch target no longer exists. Those are other packages'
   declarations; nothing in this repository depends on them.

### Tests and checks (current)

| Check | Result |
| --- | --- |
| `npm ci` from the regenerated lock | 92 packages added, exit `0` |
| `npm run typecheck` | exit `0` |
| `npm run drift:check` | all JS-side drift checks passed, exit `0` |
| `npm run test:js` | 18 files, 421 tests, all passed, exit `0` |
| `npm test` (Python 3.11.9) | exit `0` |
| `npm run build` | bundles + declarations emitted, no diff against the committed bundles, exit `0` |
| `npm run test:node` | 21 tests, all passed, exit `0` (includes the new execution probe) |
| `npm run drift:python` | `No drift detected`, exit `0` |
| `npm run audit:package` | `npm package audit ok: 99 entries`, exit `0` |
| `dsh plugin --profile web version-exemptions` | `{}` — this profile needs no exemption for the plugin |

Not green: `npm run sync:check`, which reports the working tree as dirty while the
change is uncommitted. It clears once the change is committed and pushed; it is a
release-state gate, not a defect signal.

### Remaining boundary (current)

- The Desktop profile was still not modified; the plugin remains installed in the
  Web profile only. Moving it requires quitting the Desktop app.
- The Web profile server was not started, so the loopback routes were verified by
  contract tests and by `dsh --dump-config` (the bundle is not skipped), not by a
  live HTTP call. Route *matching* is unchanged in 0.2.1, and the exact-before-prefix
  rule is what keeps them reachable.


