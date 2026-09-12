# 安全升级 unified-agent-memory 的 DSH 适配与自动化部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将仓库更新为可在 Node.js `>=20`、DSH `0.1.5-rc.2` / npm `next` 下安全加载的公开版本，并提供可验证、幂等、可回滚的 Agent 自主部署参考。

**Architecture:** 保留现有 Python core 与 DSH host/UI 两层边界。DSH host 层增加输入归一化、输出截断/脱敏、可选宿主能力探测和清理句柄；部署层新增纯 Python 的目标探测、marker 替换、备份、dry-run、原子写入和锁保护入口，默认只触碰明确的全局指令目标，不触碰 vault canonical、会话或凭据。文档统一描述候选版目标与稳定版边界，公开 Agent 经验只保留抽象规则。

**Tech Stack:** Node.js ESM / `node:test`, `@deepseek-ai/dsh-tools@0.1.5-rc.2`, `@deepseek-ai/cordis@4.0.2`, Python 3 标准库 / `unittest`, npm lockfile v3, PowerShell 验证。

**Spec:** `.pi/goal/安全升级-unified-agent-memory-的-dsh-适配与自动化部署-20260912-1831.md`

## Global Constraints

- DSH 主要兼容目标固定为 `0.1.5-rc.2` / npm `next`，文档必须说明稳定标签 `latest` 与候选标签的边界。
- Node.js 要求保持 `>=20`；插件缺少 vault/core、可选宿主能力或 HTTP 路由时不得让宿主崩溃。
- canonical vault 只读；写入只能进入 `Agent提交区`；不修改本机 Agent 配置、Obsidian、会话、凭据或远程服务。
- 不发布 npm；npm 包清单不得包含 vault、SQLite、session/archive、credentials、`.env`、备份、日志或本地配置。
- 公开文档不得含本机用户名、绝对私有路径、IP、域名、账号、令牌、密码、Cookie、私有服务配置或会话原文。
- 只在历史审计发现真实敏感内容时重写 Git 历史；普通交付使用单个语义明确 commit 与非强制 push。

---

### Task 1: DSH host 适配回归测试

**Files:**
- Create: `test/dsh-host-adapter.test.mjs`
- Test fixture only: `test/fixtures/` 如确有必要，优先在测试文件内使用临时目录

**Interfaces:**
- Consumes: `lib/index.js` 的 `apply(ctx, config)` 与 default plugin export。
- Produces: 可在无真实 DSH 进程、无真实 vault 的隔离 fake host 上验证的行为契约。

- [ ] **Step 1: Write failing tests** for plugin import/default export, four tool registrations, missing configuration, `remoteEnabled` string parsing, path traversal rejection, output truncation/redaction, missing `webServer`, HTTP route cleanup, and configured tool execution through a fake Python executable.
- [ ] **Step 2: Run the focused Node test** with `node --test test/dsh-host-adapter.test.mjs`; confirm failures identify missing safety behavior rather than test harness errors.
- [ ] **Step 3: Keep tests isolated**: fake `ctx.tools.register`, fake `ctx.inject`/`ctx.effect`, a temporary vault containing only non-sensitive fixture text, and a temporary Python helper invoked through `pythonPath` without shell interpolation.

### Task 2: DSH host hardening

**Files:**
- Modify: `lib/index.js`
- Modify: `test/dsh-host-adapter.test.mjs`

**Interfaces:**
- Produces: `resolveConfig`, bounded rendering, safe core invocation, optional route registration, and the existing four tool names without changing their model-facing purpose.

- [ ] **Step 1: Implement only the minimum changes for the failing tests**: strict boolean parsing, bounded output with an explicit truncation marker, secret redaction before returning text, safe config/path normalization, and `ctx.tools`/`ctx.inject` capability checks.
- [ ] **Step 2: Ensure status route registration returns an effect disposer and uses `off`/`removeListener` when available; when no web server exists, skip silently and retain tools.
- [ ] **Step 3: Ensure all core errors become readable `{ ok: false, output: '', error }` results with no raw credential-shaped values or unbounded stderr.
- [ ] **Step 4: Run the focused test and the existing UI contract test; both must pass.

### Task 3: Candidate dependency and package boundary

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `.npmignore`
- Modify: `.github/workflows/ci.yml` only if its command is incompatible with the corrected npm/Python entrypoints

**Interfaces:**
- Produces: package metadata declaring DSH `0.1.5-rc.2` / Cordis `4.0.2` compatibility and a reproducible lockfile.

- [ ] **Step 1: Update peer dependency ranges to `@deepseek-ai/dsh-tools: ^0.1.5-rc.2` and `@deepseek-ai/cordis: ^4.0.2`; retain Node `>=20`.
- [ ] **Step 2: Regenerate the lockfile with npm using the repository’s existing registry configuration; verify root metadata and resolved DSH family versions.
- [ ] **Step 3: Add explicit ignore rules for vault directories, SQLite databases, session/archive data, credential files, local configs, backups, logs, and generated package archives.
- [ ] **Step 4: Add a package manifest audit test/script that runs `npm pack --dry-run --json` and fails if forbidden categories are present.

### Task 4: Safe, idempotent deployment entrypoint

**Files:**
- Create: `setup/deploy.py`
- Create: `setup/tests/test_deploy.py`
- Modify: `setup/setup.py`
- Modify: `docs/AGENT-DEPLOY.md`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Produces: `python setup/deploy.py detect|preview|apply|rollback|selfcheck` with explicit target paths, no arbitrary command execution, and JSON/text diagnostics.
- Consumes: existing marker conventions and the repository’s UTF-8 deployment rules.

- [ ] **Step 1: Write failing unit tests** for target detection, marker replacement without duplication, dry-run no-write behavior, UTF-8 round-trip, backup creation, atomic write, stale/active lock handling, failure-safe rollback, and rejection of paths outside explicit target files.
- [ ] **Step 2: Run `python -m unittest setup.tests.test_deploy -v` and confirm the new tests fail for missing entrypoint behavior.
- [ ] **Step 3: Implement an allowlisted deployment engine**: detect only existing known agent instruction files or explicitly supplied files; never interpret file contents as commands; use `Path` operations and UTF-8.
- [ ] **Step 4: Implement marker replacement first, legacy-section replacement second, append last; write one marker-delimited section and preserve all unrelated bytes/lines.
- [ ] **Step 5: Implement lock + timestamped backup + temporary sibling + `os.replace`; on write/verification failure restore from the backup and return nonzero diagnostics.
- [ ] **Step 6: Add `setup.py deploy ...` forwarding while keeping `setup.py agents` as a clearly deprecated, non-writing compatibility command.
- [ ] **Step 7: Run deployment unit tests twice against the same fixtures and assert byte-identical second output and no second section.

### Task 5: Python test entrypoint and lock reliability

**Files:**
- Modify: `package.json`
- Modify: `core/tests/test_promoter.py` or the smallest owning test helper only if root cause requires it
- Modify: `core/unified_memory/common.py` only if a focused regression proves a production lock bug
- Create: `docs/VALIDATION-REPORT.md`

**Interfaces:**
- Produces: a documented, reproducible Python test command that works from the repository root on Windows and POSIX.

- [ ] **Step 1: Reproduce the current command from the root and capture exit code, timeout/lock behavior, and the exact discovery failure mode.
- [ ] **Step 2: Fix the test invocation rather than weakening lock semantics: use a top-level test package/import path or an explicit runner that adds `core` to `sys.path` without changing user runtime files.
- [ ] **Step 3: Run the full Python suite with a bounded timeout and separately run the lock contention tests; only change `common.py` if the focused regression demonstrates a real race.
- [ ] **Step 4: Update npm scripts/CI to call the verified runner.

### Task 6: Public five-Agent experience and compatibility documentation

**Files:**
- Create: `docs/AGENT-EXPERIENCE.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/DSH-MEMORY-ADAPTERS.md`
- Modify: `CHANGELOG.md`
- Modify: `SECURITY.md`

**Interfaces:**
- Produces: consistent English/Chinese install and compatibility instructions plus abstract DSH, Codex, Claude Code, Hermes, and AtomCode deployment notes.

- [ ] **Step 1: Add a compatibility matrix covering DSH `0.1.5-rc.2` / `next`, stable `latest` as a separately validated boundary, Node `>=20`, and the package/checkout paths.
- [ ] **Step 2: Document read-only canonical, submission inbox prefixes/responsibility, promotion review/apply, common failure recovery, version drift, and low-token usage for all five Agents.
- [ ] **Step 3: State that deployment is previewable/idempotent/backup-protected and never edits canonical vault, sessions, credentials, or arbitrary runtime config.
- [ ] **Step 4: Run a repository-scoped privacy text scan over these files and remove any personal or infrastructure-specific material before staging.

### Task 7: Full verification, audit, commit, and push

**Files:**
- Modify: `docs/VALIDATION-REPORT.md`
- Modify: `CHANGELOG.md` if verification findings require a final note

**Interfaces:**
- Consumes: all previous tasks and the approved goal contract.
- Produces: one semantic commit on `main`, pushed to the verified GitHub default branch, with a clean worktree and remote SHA verification.

- [ ] **Step 1: Run Python core tests, deployment tests, Node tests, syntax/import checks, candidate-package smoke tests, npm pack dry-run, and package forbidden-file audit.
- [ ] **Step 2: Run current-tree and complete Git-history privacy scans; treat real secrets or personal infrastructure as blockers and retain a local recoverable backup before any history rewrite.
- [ ] **Step 3: Run `git_preflight.py` inspect, pre-commit, pre-push, and verify with exact allowed paths and the already authorized target repository.
- [ ] **Step 4: Review staged diff, diff check, package manifest, and validation report; create one semantic commit.
- [ ] **Step 5: Fetch/prune, verify remote owner/repository/default branch and non-force fast-forward conditions, run pre-push, then push normally.
- [ ] **Step 6: Run post-push remote SHA/worktree verification and report every acceptance criterion as met or unmet with fresh evidence.

---

## Self-review

- Spec coverage: Tasks 1–2 cover DSH loading, registration, degradation, routing, truncation, redaction, and current API; Task 3 covers versions/package limits; Task 4 covers deployment safety; Task 5 covers Python reliability; Task 6 covers five-Agent public guidance; Task 7 covers audit, report, commit, and push.
- No placeholder implementation steps are used; every task names files, interfaces, tests, and commands.
- The plan does not authorize changes outside the target checkout or Git history and keeps canonical memory and local runtime state read-only.
