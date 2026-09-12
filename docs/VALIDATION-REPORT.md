# Validation report

Date: 2026-09-12

## Compatibility target

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
