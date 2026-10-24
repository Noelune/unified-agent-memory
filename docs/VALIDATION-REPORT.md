# Validation report

Date: 2026-09-12

## Compatibility target

> **Superseded for the current release.** This report records the 2026-09-12
> validation against DSH `0.1.5-rc.2`. The current target line is recorded in
> [Re-validation (2026-10-18)](#re-validation-2026-10-18-dsh-021-rc2), with the
> earlier DSH `0.2.0-rc.2` pass in
> [Re-validation (2026-10-13)](#re-validation-2026-10-13) below.
>
> The 0.8.1 release itself was re-validated on 2026-10-20
> ([below](#re-validation-2026-10-20-081--three-versions-that-never-shipped));
> that pass is the one that covers the currently published package.

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

---

## Re-validation (2026-10-20): 0.8.1 — three versions that never shipped

Trigger: preparing the 0.8.1 release. `npm` still served `0.7.1` while the
CHANGELOG had been carrying 0.7.2, 0.8.0 and 0.8.1 for weeks. Three releases'
worth of change therefore reach users in a single update — the case where a
regression has the most room to hide, and the reason this pass drives the CLI
directly instead of only re-reading the unit tests.

### What was run

| Check | Result |
| --- | --- |
| `npm run check` | exit `0` (all nine stages, on a clean tree) |
| `npm run typecheck` | exit `0` |
| `npm run test:js` | 37 files, 867 tests, all passed |
| `npm test` (Python 3.13, `core/tests`) | 364 tests, all passed |
| `npm run test:setup` | 32 tests, all passed |
| `npm run test:node` | 21 tests, all passed |
| `npm run drift:check` / `npm run drift:python` | no drift, exit `0` |
| `npm run build` | bundles regenerated, no diff against the committed ones |
| `npm run audit:package` | `npm package audit ok: 103 entries` |
| `npm pack --dry-run --json` | 103 files, 514.7 kB packed / 1.68 MB unpacked; all 22 `core/**` files present |
| Behavioural probe, 35 cases over a scratch vault | 35 passed |
| Mutation probe, 5 hand-applied defects | 5 caught, 0 survived |
| Version consistency | `package.json` = `dsh.plugin.json` = `package-lock.json` = `0.8.1` |
| Real vault smoke (`memory status --json`) | `structure: ok`, 478 memories / 377 vectors |

The 35-case probe is the part worth describing: it lives in `%TEMP%`, drives the
CLI as a subprocess exactly as the panel and an agent do, and covers eight
groups — "a reason is a requirement, not a flag", "what `advise` writes comes
back readable", "the queue was changed by someone else mid-flight",
"uninitialized vault answers in one clean line", "each of the four rulings lands
as specified", "a reason cannot poison the log", "housekeeping with nothing to
clean", and "the stdout contract". Every case runs against its own temporary
vault with `HOME`/`USERPROFILE` redirected.

The mutation probe applies one defect at a time and requires the suite to go
red: (1) the parser stops validating the value, (2) `cmd_advise` stops refusing
an empty reason, (3) `collapse_whitespace` stops collapsing, (4) `main()` stops
translating `VaultMissing`, (5) `VaultMissing` stops deriving from
`RuntimeError`. Each was restored byte-for-byte afterwards.

### Findings and fixes

1. **`advise --why ""` was accepted and wrote an empty explanation.** The option
   was declared `required=True`, which only asks whether the *flag* was given,
   so `--why ""` and `--why "   "` both reached `record_advice` and produced a
   `- 解释：` line with nothing after it: advice with no reason, which is the
   exact failure this command exists to prevent. Refused in two places that
   must agree — `type=plain_reason` in the parser (exit 2, nothing written) and
   an explicit check in `cmd_advise` (which is importable API, so the parser is
   not on every path). Both are pinned by tests, including a byte-for-byte
   assertion that the queue is unchanged after a refusal.
2. **An uninitialized vault produced a four-frame traceback.** Every command
   that calls `ensure_vault` — including `memory gc --apply`, the very command
   `doctor` recommends — died with a stack trace instead of a sentence.
   `common.VaultMissing(RuntimeError)` is now raised there and translated in
   `main()` into a one-line `SystemExit`, so the process prints one line to
   stderr and exits 1 with no envelope. `status` and `doctor` still receive it
   as an ordinary runtime error, because reporting "this is broken" is their job
   (see `docs/JSON-CONTRACT.md` §1.3).
3. **The lockfile still said `0.8.0`** while both manifests said `0.8.1`.
   `npm install --package-lock-only` would have regenerated it but also churned
   seven unrelated `peer` fields, so the two version strings were replaced
   literally and the diff kept to 2 lines.
4. **A redundant normalisation made one test blind.** `cmd_advise` collapsed the
   reason and `record_advice` collapsed it again, so a mutation that removed
   collapsing *anywhere* changed nothing observable and the test stayed green.
   The three copies became `common.collapse_whitespace`; the mutation is now
   caught. A second candidate mutation — passing the raw `why` instead of the
   collapsed `note` — remained invisible for the same reason (the caller had
   already normalised), so it was **deleted** instead of kept as a test that
   cannot fail.
5. **Three of the probe's first six failures were the probe's own fault.** It
   created a queue file without creating a vault, so several cases were really
   testing "vault missing"; and two cases asserted `applied: true` for
   `保留旧` / `跳过`, which by design do not touch canonical notes. The
   expectations were wrong, not the code. The probe now states each contract
   above the case, before it runs.
6. **The probe rewrote this machine's real config — for the third time.**
   `memory init` resolves `~/.unified-memory.yaml` from the *child* process's
   `HOME`, so a probe that ran `init` in a subprocess repointed the real file at
   a scratch directory that was deleted moments later. Restored byte-for-byte
   (`vault: C:\Users\zhaowei\OneDrive\Desktop\Obsidian Vault`, 57 bytes) and
   confirmed with `memory status --json` (478 memories, `structure: ok`). Every
   probe now sets `HOME` and `USERPROFILE`, and `init()` asserts that the config
   it wrote landed inside the scratch root before the case is allowed to run.

### Remaining boundary (current)

- The panel's advice row was verified through `preview conflicts --json` (the
  exact payload the browser half consumes) and through the built bundle
  (`lib/client-ui.js` contains `dsh-memory-advice`, `dsh-memory-action-suggested`,
  `CONFLICT_ADVICE_LABEL` and `modeSteps`), not by clicking the buttons in a live
  Desktop window. The Desktop profile keeps running the previously installed
  build until it installs the published 0.8.1.
- `advise` has no HTTP route by design: the agent that read the queue writes the
  advice through the CLI, and the browser half only reads it back. Its contract
  is therefore CLI-only, and `docs/JSON-CONTRACT.md` §5.3.3 says so explicitly.
- The "every orphan index is newer than 30 days" branch of the doctor message is
  exercised in `test_health.py` against a scratch `~/.unified-memory`, not
  against the real one — manufacturing old orphans in a live user's index
  directory to read a log line was not worth the risk.



---

## Re-validation (2026-10-24): DSH 0.2.1-rc.3 — version-aligned re-release, zero delta

Trigger: the Desktop client moved to `dsh` `0.2.1-rc.3` (published on the npm
`next` dist-tag; `latest` remains `0.2.1-rc.2`).
Question asked: does the plugin need adaptation, and what must be re-declared?

### Method

Tarball-level diff of every package the plugin touches at runtime, rc.2 vs rc.3:

| Package | Diff |
| --- | --- |
| `@deepseek-ai/dsh` | `package.json` only (all intra-monorepo deps bumped rc.2 → rc.3); `lib/` byte-identical |
| `@deepseek-ai/dsh-tools` | byte-identical |
| `@deepseek-ai/dsh-host-webserver` | byte-identical |
| `@deepseek-ai/dsh-plugin-manager` | `package.json` version strings only; `lib/` byte-identical |
| `@deepseek-ai/dsh-user-approval` | `package.json` version strings only; `lib/` byte-identical |

`0.2.1-rc.3` is a lockstep re-release of the monorepo, not an API or behaviour
change: no adaptation is required, and the plugin's peer range
(`>=0.2.0-rc.1 <0.3.0-0`) already covers it, so the host compatibility gate
admits it without edits.

### Declaration changes

- `package.json` `dshReleases` (regenerated into `dsh.plugin.json` by the build):
  `"0.2.1-rc.3": "compatible"` added.
- DevDependencies stay pinned at `0.2.1-rc.2`: the tarballs are byte-identical,
  so the type baseline cannot drift, and upgrading them would require pinning
  the whole `dsh-tools` peer chain (ten exact-version packages) into
  `devDependencies` — cost without a correctness benefit while the bytes match.

### Checks run for this pass

| Check | Result |
| --- | --- |
| `npm run build` | manifest regenerated with the rc.3 row, bundles unchanged |
| `npm run drift:check` | all JS-side drift checks passed |
| `npm run test:js` | 39 files, 879 tests, all passed |
| `npm run typecheck` | exit `0` |
