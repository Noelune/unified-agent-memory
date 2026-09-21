# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- 记忆控制台：浏览器面板从「系统状态窗」改为四 Tab 控制台（搜索 / 待处理 / 库全貌 / 系统），
  全部数据来自真实 core 调用，命中词高亮，可切换 hybrid 混合检索，系统状态收进独立 Tab。
- 记忆控制台：新增五条宿主 HTTP 路由。读路由 `GET /search`（`q` 必填、`hybrid=1` 可选）、
  `GET /preview`（`view` ∈ pending/recent/forgetting/conflicts）、`GET /note`（`name` 为提交区内文件名），
  写路由 `POST /dismiss`（仅将提交区条目移入 `已处理/`，不删除、不改写）。
- 记忆控制台：core 新增 `note`（读单条提交正文）与 `dismiss`（唯一写命令，提交区条目移入 `已处理/`）
  子命令，新增 `core/unified_memory/inbox.py`；两者沿用统一信封 `{ok, command, data}`，
  并新增 `data.reason` 失败枚举（`invalid-name` / `not-found` / `outside-inbox` / `io-error:*`）。
- 记忆控制台：抽出宿主共享 HTTP 工具 `src/routes.ts`（loopback 判定、方法白名单、`no-store` 头、
  查询参数解码、带字节上限的请求体读取），五条路由复用同一基线。
- P0(U-2): `memory_search` 工具支持 hybrid/format/budget 参数，消除 ARCHITECTURE 文档漂移。
- Phase 1：`memory status/search/preview --json` 机器可读契约（统一信封 `{ok, command, data}`），
  JSON 模式下 vault 派生字段逐条打 `untrusted: true`，文本模式保留 `<memory-data>` 包裹。
  详见 `docs/JSON-CONTRACT.md`。
- Phase 1：`memory_preview` 工具与四个只读治理视图（pending / conflicts / forgetting / recent）。
- Phase 1：中文检索新增 trigram FTS 表（`tokenize='trigram'`，独立于既有 `fts`/`fts_mem`），
  作为 RRF 第四路召回；短于 3 字的 CJK 查询（如 `记忆`）回退到子串扫描。
- Phase 1：`/status` 路由新增只读 `index` 与 `stats` 字段（`memories`/`vectors`/`pending`）。

### Changed

- P0(U-1): `dsh.plugin.json` 的 version/description 由 package.json 单一事实源回填（build 自动完成），drift-check 硬校验版本一致。
- P0(S-1): CI 增加 Windows 测试 runner 与完整 JS 检查 job（typecheck/drift/sync/vitest/build/audit）。
- Phase 1：记忆面板客户端重构为分组卡片（黑灰白/银系、卡片层次、无裸 JSON）。
- 记忆控制台：`preview` 名字校验强化（提交区文件名白名单 + 解析后路径前缀双重校验），
  读单条提交与移入 `已处理/` 共用同一套校验，避免符号链接把内容带出提交区。

### Fixed

- 记忆控制台（安全加固）：`POST /dismiss` 的失败语义此前被压平成 `unavailable`——`shapeDismissResult`
  以外层 `ok` 为先决条件，而 core 信封的外层 `ok` 是 `data.ok` 的**副本**（业务拒绝时两层同为 `false`），
  于是「条目已被移走」与「core 不可用」在面板上不可区分。现改为：只要 `data` 存在就按其内容判定，
  仅 `data` 缺失（畸形/非 JSON 输出）才降级为 `unavailable`，失败原因分类得以保留。
- 记忆控制台（安全加固）：`POST /dismiss` 的 argv 曾把 `--json` 放在 `--` 终止符**之后**，
  argparse 把它当作第二个位置参数并以 exit 2 空 stdout 退出，宿主会误判为名字非法而拒绝所有合法提交；
  现改为 `dismiss --json -- <name>`，并保留 `--` 以阻止前导 `-` 的名字被当作 flag。
- 记忆控制台（安全加固）：`POST /dismiss` 的请求体上限按**字节**而非 UTF-16 码元计数
  （CJK 每字符最多 3 字节，用 `.length` 会放过 2–3 倍载荷），并拒绝前导 `-`/`~`、分隔符、`:`、NUL
  及路径穿越形状的名字。
- 修复 `audit-package.mjs` 在 Windows 上的 spawn 失败（经 `process.execPath` 调用 npm-cli.js，不依赖 shell），并豁免 vault-template 归档区 README 占位文档的违禁路径误报。
- Phase 1：`/status` 的 `pending` 计数此前把非有限值悄悄折成 `0`，使「读取损坏」与「确实没有待办」
  不可区分；现与 `memories`/`vectors` 兄弟字段一致——任一计数非有限即整体 `stats` 降级为 `null`。

## [0.5.2] — 2026-09-19

### Fixed

- **The host plugin never applied at all.** `apply` read `ctx.webServer` from
  inside a nested `ctx.inject(['webServer'], ...)` callback, but cordis resolves
  services against the plugin's own declared `inject`, so that read threw
  `cannot get property "webServer" without inject`. The loader failed the entry,
  and none of the four `memory_*` tools nor
  `/api/dsh-unified-agent-memory/status` ever registered. It was invisible from
  outside: the harness booted, no banner appeared, the sidebar button rendered —
  the panel just polled a route that had never existed. `webServer` is now
  declared statically and the route is registered directly, matching the other
  route-registering plugins in this profile.

### Added

- **Loopback-only status route.** The payload carries local filesystem paths
  (vault, python, core) and the harness may sit behind a reverse proxy, so
  non-loopback peers now get 403 and non-`GET`/`HEAD` methods 405.
- **`test/plugin.test.ts`** applies the entry against a context that enforces
  the same undeclared-service guard cordis uses, and covers the tool set, the
  route path, the payload and both guards. It fails against the 0.5.1 code with
  the original error and passes with the fix.

## [0.5.1] — 2026-09-18

### Fixed

- **The client entry is now a Cordis plugin.** `src/client/index.ts` exported
  no `apply`, so the DSH client loader rejected the bundle with
  `invalid plugin, expect function or object with an "apply" method, received
  object` and the harness booted into its "Failed to load plugins" screen. The
  module now declares `inject: ['slots']` and contributes UI from inside
  `apply(ctx)`, which is the shape the client runtime registers.
- **The sidebar trigger actually mounts.** It previously wrote to
  `window.__DSH_SIDEBAR_SEATS__` — a global the harness does not provide — so
  the button never appeared even when the module loaded. It now occupies the
  additive `sidebar.footer.action` seat beside Settings, and skips registration
  cleanly in hosts without a slot registry (headless, mobile shells).
- **Atomic build output.** esbuild results are buffered and published with
  temp file + rename. A profile that installs this package via `link:` with
  live patch reload can no longer observe a half-written `lib/index.js` and
  fail the entry for missing exports.
- **Self-referential `client.inject`.** `dsh.client.inject` listed this
  package's own module id; it now lists nothing, since the bundle loads its own
  client half.
- **Style tag ownership.** `adoptStyles()` gives each `<style>` its own
  instance token instead of removing the first matching tag, so two mounted
  instances (rail and wide sidebar) cannot dispose each other's CSS.
- **Uninstallable dev tree.** `@deepseek-ai/dsh-tools` and
  `@deepseek-ai/dsh-host-webserver` were ranged at `^0.1.0-rc.6`, which spans
  incompatible prereleases: `0.1.0-rc.8` requires peer
  `@deepseek-ai/dsh-llm@^0.1.0-rc.8`, colliding with `0.1.5-rc.2`. `npm install`
  failed with ERESOLVE. `devDependencies` now pin the harness release this
  plugin targets (`0.1.5-rc.2`); the `peerDependencies` ranges stay permissive
  so installs keep resolving against whatever harness the user runs.
- **Corrupt lockfile.** `package-lock.json` had been committed with unresolved
  git merge conflict markers (six blocks, since `0bed915`), so it was not valid
  JSON and `npm ci` refused to run at all. Regenerated from `package.json`.
- **Latent type errors in the tool handlers.** `CoreResult` and `ToolOutput`
  were `interface`s, and TypeScript only infers an implicit index signature for
  object type aliases, so all four `tools.register()` handlers failed
  assignment against the harness contract's `Record<string, JsonValue>`. These
  were never observed because `typescript` was not installed and the build
  swallowed the failure.
- **`sync:check` never checked npm.** It shelled out to `npm view`, which
  cannot be spawned that way on Windows (`npm` is `npm.cmd`, and Node 20+
  rejects a `.cmd` without a shell), and the throw landed in an empty `catch` —
  so the published-version gate always printed "All in sync" while doing
  nothing. It now reads the registry over HTTPS, and an unreachable registry is
  an error rather than a pass. It also no longer calls `process.exit()` after a
  top-level await, which aborted Node on Windows.

### Changed

- `npm run typecheck`, `npm run test:js` (32 tests) and declaration emit now
  actually run; the toolchain they need is installed from the lockfile.
- `exports.types` points at `lib/types/**` again, because those files are now
  genuinely emitted.
- `build.mjs` no longer prints "All checks passed" when declaration emit did
  not run. It reports the skip explicitly, fails under `--strict`/`CI`, and
  asserts that the built client bundle exports `apply`.

## [0.5.0] — 2026-09-15

### Added

- **Drift prevention system**: checks memory structure drift between vault
  template expectations and actual vault layout, with automated correction.
- **In-app update notification**: periodic npm registry check to alert users
  when a new plugin version is available.
- **TypeScript type declarations**: published `.d.ts` bundles alongside the
  compiled output for both host and client entry points.
- **Sync check / pre-push hooks**: prevent version drift between `package.json`
  and `dsh.plugin.json` on every commit and push.

### Changed

- **Migrated from plain JavaScript to TypeScript** — full type coverage across
  host entry (`src/index.ts`), tools (`src/tools.ts`), utilities (`src/utils.ts`),
  and client module (`src/client/`). Build pipeline uses esbuild for both host
  (Node ESM) and client (AMD with ModuleLoader wrapper).
- Hardened the DSH host adapter for DSH `0.1.5-rc.2` / npm `next`: strict
  boolean parsing, bounded and redacted core output, safe degradation when
  optional host capabilities are absent, and disposable HTTP status routes.
- Added a cross-platform, allowlisted deployment helper with preview, atomic
  apply, timestamped backup, rollback, self-check, and lock protection.
- Added public five-Agent experience guidance without local paths, credentials,
  infrastructure identifiers, or session content.
- Updated package boundaries and audit checks so npm dry-runs reject local
  vault, database, session archive, credentials, backup, and log content.
- Bumped `dsh.plugin.json` version to align with `package.json` at `0.5.0`.

### Fixed (DSH STORE compliance)

- Added `dsh.compatibility.dshReleases` with explicit declarations for DSH
  `0.1.5-alpha.2` (unknown), `0.1.5-rc.1` (compatible), and `0.1.5-rc.2`
  (compatible), resolving the "compatibility unlisted" status in the catalog.
- Added `dsh.compatibility.node` range (`>=20`) alongside the existing
  `engines.node` declaration.
- Removed protected `@deepseek-ai/*` package references from
  `dsh.client.inject` in both `package.json` and `dsh.plugin.json`; now uses
  the plugin-owned client module ID (`dsh-unified-agent-memory`) only.
- Versions bumped for DSH STORE fixed-Commit recheck.

### Compatibility

- Primary verification target: DSH `0.1.5-rc.2` / npm `next`, Cordis `4.0.1`,
  Node.js `>=20`. Stable `latest` remains a separately validated boundary.

## [0.3.0] — 2026-08-16

### Added — fused memory architecture (informed by rohitg00/agentmemory & TencentDB-Agent-Memory)

- **`index.py` — memory database (derived copy of the vault)**. Per-vault SQLite
  now holds `memories` (one record per canonical fact line: type / importance /
  status / version / superseded_by / source_agent / created / updated /
  access_count), `embeddings` (Float32 vectors), `access_log`, `graph_nodes` /
  `graph_edges` and `audit`, alongside the legacy `docs`/`fts` tables. Incremental
  rebuild by content digest.
- **`embed.py` — optional semantic vectors**. `memory embed` uses SiliconFlow
  `Qwen/Qwen3-Embedding-4B` (1024 dims) to embed every memory line; API key from
  `SILICONFLOW_API_KEY` or `~/.unified-memory/secrets.yaml`; graceful degradation
  to BM25 when unavailable.
- **`search.py` — hybrid retrieval**. `memory search --hybrid` fuses BM25 +
  vectors + concept graph with weighted RRF, diversifies per note, and caps
  output by a token budget (`--format`, `--budget`).
- **`digest.py` — session summarization (default on)**. Extracts durable facts
  from archived sessions via a lightweight LLM call into the submission inbox;
  cursor-idempotent, `--dry-run` preview, `--off` to disable.
- **`graph.py` — optional concept graph** (ASCII + CJK-bigram co-occurrence)
  feeding the third retrieval stream.
- **Supersession in the promoter**. Replacement cues (“改用/迁移到/instead of”)
  move the superseded old line under a `已取代` section instead of the conflict
  queue; the index marks it `superseded`.
- **Scored forgetting**. `forgetter.py` now uses `importance × (durable floor +
  decay) + access-reinforcement` instead of a plain 90-day rule.
- **Chinese-aware classification** in the promoter (偏好/路径/端口/服务器/规则 …)
  so non-English facts route to the correct canonical note.
- **Canonical filenames aligned to the live vault** (`工具可用性检查.md`,
  `UI审美准则.md`, `Codex-Claude-Hermes协作规则.md`) and the vault template /
  fallback template updated to match.

### Changed

- `core` index/search logic consolidated into `index.py`; `memory.py` delegates
  and keeps its public call shapes (`search_index`, `index_db_for`,
  `update_index`) so the remote server and existing tests keep working.
- **HKMemory SSH recall deprecated and removed.** The external Hermes semantic
  memory provider (`HKMEMORY_SSH_HOST`, `--hk`, the `_hkmemory` SSH bridge) is
  deleted. Its recall role is fully replaced by the fused local hybrid
  retrieval (`search.py`: BM25 + SiliconFlow vectors + concept graph) — the
  same capability the two reference projects provide, but local-first, faster
  and without an SSH/server dependency. The dsh plugin no longer passes
  `--hk`/`noHk`.

## [0.2.1] — 2026-08-15

### Fixed

- `memory search --remote` no longer requires a local vault: a pure remote
  client can query the remote index without any local vault (the local
  fallback still needs one). Reported by Codex review.
- `archive_session.py` appends under the vault file lock so concurrent
  post-turn hooks never drop each other's blocks on the same daily file.

## [0.2.0] — 2026-08-15

### Changed — deployment is now agent-driven (the only supported way)

- **New `docs/AGENT-DEPLOY.md`** — a self-contained deploy task book for DSH:
  full memory rules, per-agent global-instruction specs (dsh / Codex / Claude
  Code / Hermes), write conventions, step-by-step flow, verification checklist
  and pitfalls. On a fresh install DSH reads it and wires every agent itself.
- **`setup.py agents` is deprecated** — scripted writing of global instruction
  files was removed on purpose (each agent's prompt must be tailored to its own
  file format); the command now prints the agent-driven guidance only. The dead
  template/wiring code was deleted.
- **Plugin surfaces deployment guidance**: `memory_status` (and the
  not-configured message) now point DSH to `docs/AGENT-DEPLOY.md` and check the
  vault structure, so a fresh install is self-discoverable.

### Fixed

- **npm package now ships the Python core** (`core/` sources in the tarball).
  `corePath` already defaulted to `<plugin>/core`; previously the tarball did
  not include it, so the four tools failed on a bare npm install. No `pip
  install` is needed for the plugin tools (PYTHONPATH is injected). `.npmignore`
  and a glob-based `files` entry keep `__pycache__`/`.pyc` out of the tarball.
- **npm package ships the full deploy surface**: `vault-template/`,
  `integrations/hermes/` scripts and all docs are now in the tarball, so a bare
  npm install can create a complete vault (`memory init`), run the Hermes-style
  scripts, and resolve the doc links. The agent-driven task book documents the
  npm-only equivalents of `setup.py` (`memory init` / `memory status`).
- Removed stale `pip install unified-agent-memory-core` hints — that package is
  not on PyPI yet; the plugin-bundled core is the supported path.

### Added

- `memory search --remote`: real remote-index client — Bearer-token HTTP query
  against `setup/remote_index_server.py`; falls back to the local index (with a
  stderr note) when unconfigured, unreachable, or the token is rejected.
- `setup/remote_index_server.py`: dependency-free remote index server
  (`GET /health`, `POST /search`, Bearer token).
- `promoter --repair-existing`: conservative canonical hygiene (exact
  duplicates + template placeholders) with automatic backup and `--dry-run`.
- `memory show <doc>`: accept any canonical note under `50-Agent-Context`
  (structured-fact notes) in addition to the built-in ids.
- `integrations/hermes/`: runnable `inject_context.py`, `daily_cron.py`,
  `archive_session.py` scripts (context injection, full daily lifecycle,
  session archiving into `会话归档/`).
- Vault template: `50-Agent-Context/会话归档/` session-archive folder.
- dsh plugin `memory_search`: optional `remote` parameter.

## [0.1.1] — 2026-08-15

### Fixed

- **`file_lock` now prints a one-time "waiting for lock …" notice to stderr**
  while another writer holds the lock, instead of waiting silently for up to
  30 s (the timeout error itself was already clear; the wait in between was not).

### Docs

- **DEPLOY.md: Windows vault-path note** — paths like `/tmp/...` are
  drive-relative on Windows (`C:\tmp\...`); use `C:/...` or `$HOME/...` forms.

## [0.1.0] — 2026-08-14

### Added

- **Dependency-free Python core** (core/): memory init/search/show/submit (local SQLite FTS5 index with <memory-data> output markers), promoter review/apply/auto/adjudicate (classification, dedup, char-bigram conflict detection, file lock + atomic writes, inbox archiving), forgetter (90-day decay, reversible).
- **Vault template** (vault-template/): 7 canonical notes, 提交区 inbox, 情境信息 (pending/conflicts), 记忆遗忘区.
- **dsh plugin** (repo root): memory_search / memory_show / memory_submit / memory_status model tools; graceful degradation when unconfigured; optional sidebar status panel.
- **Integrations**: AGENTS.md (Codex), CLAUDE.md (Claude Code), Hermes hook examples.
- **Setup**: setup.py init/cron/selfcheck; standalone deployment documented (no Hermes required; Hermes dream-cron is just one optional scheduler).
- **Docs**: ARCHITECTURE / DEPLOY (standalone + full mode) / SECURITY; bilingual README.
- **CI**: core unit tests (unittest), gitleaks secrets scan, license check on every push.
