# Validation report

Date: 2026-09-12

## Compatibility target

> **Superseded for the current release.** This report records the 2026-09-12
> validation against DSH `0.1.5-rc.2`. The plugin now also targets DSH
> `0.2.0-rc.2` (Web + Desktop); the re-validation is in
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

