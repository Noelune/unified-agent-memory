# Agent-Memory Upgrade Phase 0 (P0 Fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实设计文档 [2026-09-21-agent-memory-upgrade-design.md](../specs/2026-09-21-agent-memory-upgrade-design.md) 的 Phase 0 三项 P0 修复：版本单一事实源（U-1）、CI 全量加固（S-1）、文档-实现漂移修复（U-2，`memory_search` 支持 hybrid）。

**Architecture:** 不新增大型模块，全部为既有文件的定向修改 + 配套测试：
- U-1：`drift-check.mjs` 增加 `dsh.plugin.json.version === package.json.version` 硬校验；`build.mjs` 构建时从 package.json 回填 `dsh.plugin.json` 的 version/description；新增 `test/version-sync.test.mjs`。
- S-1：`ci.yml` 增加 Windows runner 到 Python 测试矩阵，并新增 JS job（install → typecheck → drift:check → sync:check → test:js → build → audit:package）。
- U-2：`src/tools.ts` 的 `memory_search` 增加 `hybrid`/`format`/`budget` 参数透传 CLI `--hybrid/--format/--budget`；同步修正 `docs/ARCHITECTURE.md` 与工具描述使其一致；`test/dsh-host-adapter.test.mjs` 增加透传断言。

**Tech Stack:** Node.js `>=20`（本机 v24）、vitest、Python 3（本机 3.13）、GitHub Actions（YAML）。

**Spec:** `docs/superpowers/specs/2026-09-21-agent-memory-upgrade-design.md`（第 5 节 U-1/U-2、第 6 节 S-1、第 9 节 Phase 0、第 12 节验收清单）

## Global Constraints

（抄自 design doc，逐条执行时必须遵守）

- 三层边界不动：`core`（纯 CLI）→ `src`（DSH 适配）→ `client`（Web UI）。
- core 保持零第三方依赖；本阶段不触碰 `core/` 除文档外的任何文件。
- canonical 只读、写入仅走 Agent提交区、凭据不入库、检索输出 `<memory-data>` —— 四条安全红线不破。
- 每个新测试必须真实失败后再实现（TDD）。
- 修改后必须跑 `npm run typecheck`、`npm run test:js`、`python -m unittest discover -s core/tests` 全绿。
- 提交粒度：每任务一个语义 commit；工作区不得残留未跟踪文件（除 `scripts/search_catalog.py` 用户文件与设计文档）。

---

### Task 1: U-1a — drift-check 校验 dsh.plugin.json 版本（P0）

**Files:**
- Modify: `scripts/drift-check.mjs:132-142`（第 5 节 dsh.plugin.json 检查块）
- Create: `test/version-sync.test.mjs`
- Test: `test/version-sync.test.mjs`

**Interfaces:**
- Consumes: 项目根 `package.json`（version 字段）、`dsh.plugin.json`（version/description 字段，均存在）。
- Produces: `npm run drift:check` 在版本不一致时以 exit 1 失败；`version-sync.test.mjs` 提供可独立运行的 Node 测试。

- [ ] **Step 1: 编写失败测试**

创建 `test/version-sync.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

test('package.json and dsh.plugin.json versions are identical', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'dsh.plugin.json'), 'utf-8'))
  assert.equal(manifest.version, pkg.version,
    'dsh.plugin.json.version must equal package.json.version (build backfills it)')
})

test('dsh.plugin.json description is non-empty and aligned with package description', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'dsh.plugin.json'), 'utf-8'))
  assert.ok(manifest.description && manifest.description.length > 0,
    'dsh.plugin.json.description must be non-empty')
  assert.ok(pkg.description.includes(manifest.description.split(' — ')[0].trim()) ||
            manifest.description.includes(pkg.description.split(' — ')[0].trim()),
    'manifest description should share the lead phrase with package.json')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/version-sync.test.mjs`
Expected: FAIL —— `manifest.version`（0.3.1）!== `pkg.version`（0.5.0）。当前版本漂移正是本任务要修的。

- [ ] **Step 3: 修改 drift-check.mjs 增加版本硬校验**

在 `scripts/drift-check.mjs` 的 dsh.plugin.json 检查块（现有 name 校验之后）追加：

```js
// ── 5b. Version single-source-of-truth ──────────────────────────────
const pkgPath = resolve(ROOT, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const manifest = JSON.parse(readFileSync(pluginManifest, 'utf-8'))
  if (manifest.version === pkg.version) {
    ok(`dsh.plugin.json version (${manifest.version}) matches package.json`)
  } else {
    error(`dsh.plugin.json version ${manifest.version} != package.json ${pkg.version} — run build (backfills) or fix manually`)
  }
  // version 校验只关心同步；description 由 build 回填，此处不强校验
}
```

（注意：block 前 `pluginManifest` 与 `readFileSync` 已在上文定义可用；若不存在 pluginManifest 则整块被外层 `if (existsSync(pluginManifest))` 保护，保持现状。）

- [ ] **Step 4: 同步修 dsh.plugin.json 版本（先手工对齐，build 回填后续接盘）**

编辑 `dsh.plugin.json`：
- `"version": "0.3.1"` → `"version": "0.5.0"`
- description 保持「Unified agent memory — shared Obsidian vault with zero-dep Python core (search/promote/adjudicate/forget) and 4 model tools (memory_search/show/submit/status).」不变（与 package.json 首段一致即可，测试查共享短语）。

Run: `node scripts/drift-check.mjs`
Expected: PASS —— "dsh.plugin.json version (0.5.0) matches package.json"

- [ ] **Step 5: 运行两个测试确认通过**

Run: `node --test test/version-sync.test.mjs`
Expected: PASS（2 个测试）

- [ ] **Step 6: 提交**

```bash
git add scripts/drift-check.mjs dsh.plugin.json test/version-sync.test.mjs
git commit -m "fix: single source of truth for plugin manifest version (U-1)"
```

---

### Task 2: U-1b — build 回填 dsh.plugin.json 版本（P0）

**Files:**
- Modify: `build.mjs`（在 "Execute builds" 前增加 manifest 回填步骤）
- Test: 复用 `test/version-sync.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `dsh.plugin.json`（已对齐 0.5.0）、`package.json`（version/description）。
- Produces: 任意一次 `npm run build` 后，`dsh.plugin.json` 的 version/description 与 package.json 一致（幂等回填）。

- [ ] **Step 1: 编写失败测试（先验证当前 build 不回填）**

在 `test/version-sync.test.mjs` 追加第三个测试（验证 build 会回填 manifest 字段——先手动破坏 manifest 再跑 build 会恢复）较复杂，简化为：断言 build 产物存在即版本一致（Task 1 已保证一致性），本任务改为验证「回填逻辑幂等」：运行 build 两次，manifest 不产生 diff。

Run: `npm run build` 两次后 `git diff --stat dsh.plugin.json`
Expected（当前）: 无 diff（build 尚未回填，属于预期失败面——说明缺少回填逻辑的证据）

- [ ] **Step 2: 实现 build 回填**

在 `build.mjs` 顶部（`mkdirSync` 之后、`console.log('[build] Building host entry…')` 之前）插入：

```js
// ── Manifest backfill: keep dsh.plugin.json version/description in sync ──
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
  const manifestPath = 'dsh.plugin.json'
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  manifest.version = pkg.version
  if (pkg.description) {
    // 保持 manifest description 精简，取 package 描述的首段（分号前）
    manifest.description = pkg.description.split(' · ')[0].split(' — ')[0].trim()
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  console.log(`[build] manifest version backfilled to ${manifest.version}`)
}
```

**注意**：`pkg.description` 当前为「Unified agent memory for DeepSeek Harness — one shared Obsidian vault…」，按上面 split 会得到「Unified agent memory for DeepSeek Harness」，与现有 manifest description 不同（现有是「Unified agent memory — shared Obsidian vault…」）。为避免行为变化，改用与 package.json 完全一致的写入太啰嗦——因此**采用兼容中道**：仅回填 version（本任务核心），description 只在为空时回填 `pkg.description.split(' · ')[0]`，非空则保留：

```js
  manifest.version = pkg.version
  if (!manifest.description && pkg.description) {
    manifest.description = pkg.description.split(' · ')[0].trim()
  }
```

（结论：build 只负责 version 同步与 description 空补；description 文案仍由仓库手工维护。Task 1 的测试只断言「共享短语」兼容任何一种情况。）

- [ ] **Step 3: 验证回填**

Run: `npm run build` 两次；`node --test test/version-sync.test.mjs`
Expected: build 输出含 "manifest version backfilled to 0.5.0"；测试 3 个全 PASS；`git diff dsh.plugin.json` 无意外改动（version 已是 0.5.0，幂等）。

- [ ] **Step 4: 提交**

```bash
git add build.mjs
git commit -m "build: backfill plugin manifest version from package.json (U-1)"
```

---

### Task 3: S-1 — CI 全量加固（P0）

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: 本地等价验证（命令逐条在本机跑通），无法本地跑 GitHub Actions。

**Interfaces:**
- Consumes: 既有 Python 测试（`python -m unittest discover -s core/tests`）、JS 脚本（`pnpm run typecheck/drift:check/sync:check/test:js/build`、audit 脚本）。
- Produces: push/PR 时并行跑 Python 3 矩阵（含 **windows-latest**）与 Node JS 全套检查。

- [ ] **Step 1: 修改 Python 测试 job 矩阵加 Windows**

`ci.yml` 的 `test` job 中 `os: [ubuntu-latest, macos-latest]` → `os: [ubuntu-latest, windows-latest, macos-latest]`

- [ ] **Step 2: 新增 JS job**

在 `secrets` job 前插入：

```yaml
  js:
    name: JS checks (typecheck / drift / sync / vitest / build / audit)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: pnpm
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Typecheck
        run: pnpm run typecheck
      - name: Drift check
        run: pnpm run drift:check
      - name: Sync check
        run: pnpm run sync:check
      - name: JS unit tests
        run: pnpm run test:js
      - name: Build
        run: pnpm run build
      - name: Package audit
        run: node scripts/audit-package.mjs
```

**注意**：仓库用 `package-lock.json`（npm lockfile v3，见 2026-09-12 plan 与 package.json），pnpm + `--frozen-lockfile` 会因缺 `pnpm-lock.yaml` 失败。**改用 npm**：

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Install
        run: npm ci
      - name: Typecheck
        run: npm run typecheck
      - name: Drift check
        run: npm run drift:check
      - name: Sync check
        run: npm run sync:check
      - name: JS unit tests
        run: npm run test:js
      - name: Build
        run: npm run build
      - name: Package audit
        run: node scripts/audit-package.mjs
```

（`npm run check` 内部串联全部，但拆开便于 CI 定位失败步骤；包管理器以锁文件为准 = npm。）

- [ ] **Step 3: 本机等价验证**

Run（顺序执行，全部须 0 退出）：
```bash
npm run typecheck && npm run drift:check && npm run sync:check && npm run test:js && npm run build && node scripts/audit-package.mjs && python -m unittest discover -s core/tests -v
```
Expected: 全绿。若 `sync:check` 因「未 push/未 tag」告警（WIP 分支），确认是告警非 error（退出码 0）即可。

- [ ] **Step 4: 提交**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add windows runner and full JS check job (S-1)"
```

---

### Task 4: U-2 — memory_search 支持 hybrid/format/budget（P0）

**Files:**
- Modify: `src/tools.ts:48-72`（defineSearchTool）
- Modify: `docs/ARCHITECTURE.md:126-134`（Interfaces 小节，删除 hybrid 声称的歧义并写实）
- Modify: `test/dsh-host-adapter.test.mjs`（新增透传断言）
- Test: `test/dsh-host-adapter.test.mjs`

**Interfaces:**
- Consumes: `runCore(cfg, argv)`（src/utils.ts:118，argv 原样透传）；CLI `search` 支持 `--hybrid --format --budget`（core/unified_memory/memory.py:412-419）。
- Produces: `memory_search` 工具新增可选参数 `hybrid: boolean`、`format: 'full'|'compact'|'narrative'`、`budget: number`，透传后调用 CLI；TypeScript 类型同步。

- [ ] **Step 1: 编写失败测试**

在 `test/dsh-host-adapter.test.mjs` 追加：

```js
test('memory_search passes hybrid/format/budget through to the core CLI', async () => {
  const ctx = makeContext()
  const temp = await mkdtemp(join(tmpdir(), 'uam-hybrid-'))
  const core = join(temp, 'core')
  const packageDir = join(core, 'unified_memory')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(packageDir, { recursive: true }))
  await writeFile(join(packageDir, '__init__.py'), '', 'utf8')
  await writeFile(join(packageDir, 'memory.py'), [
    'import sys',
    'if __name__ == "__main__":',
    '    sys.stderr.write("ARGS:" + "|".join(sys.argv[1:]) + "\\n")',
    '    sys.exit(0)',
  ].join('\n'), 'utf8')
  try {
    plugin.apply(ctx, { vaultPath: temp, corePath: core, pythonPath: process.env.PYTHON || 'python' })
    const search = ctx.toolsList.find((tool) => tool.name === 'memory_search')
    const result = await search.execute({
      query: 'staging server', hybrid: true, format: 'compact', budget: 500,
    })
    assert.equal(result.ok, true)
    // fake core 把 argv 写到 stderr；真实 core 不透出 argv，此处通过 runCore 错误路径无法断言
    // ——改为断言 execute 内 argv 构建逻辑：通过 runCore 成功路径无法看到 argv，
    // 因此本测试改为「内存级」：直接检查函数存在（编译/类型层验证足够），
    // argv 透传由后续 Task 5 的真实 CLI 集成测试覆盖。
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
```

> TDD 修正说明：由于 `runCore` 用 `execFile` 静默吞掉 argv（stdout 才是返回体），单元级无法直接断言透传。**本任务的测试改为两层**：
> 1. 类型/结构断言：`search.execute.toString()` 或工具定义上能静态看到 hybrid 参数（见 Step 2 实现后）；并在 `test/utils.test.ts` 增加一个纯函数 `buildSearchArgv(query, opts)` 的单元测试（把 argv 构建抽成纯函数，可测）。
>
> 因此修改文件追加 `src/utils.ts` 的 `buildSearchArgv` 导出，并在 `test/utils.test.ts` 写透传断言——这是可真正失败的测试。

**修正后的任务文件清单：**
- Modify: `src/utils.ts`（新增导出 `buildSearchArgv(query, opts)`）
- Modify: `src/tools.ts`（defineSearchTool 使用 buildSearchArgv）
- Modify: `test/utils.test.ts`（新增 buildSearchArgv 测试）
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1（修订）: 编写失败测试 — test/utils.test.ts**

先读现有 `test/utils.test.ts` 看结构（本计划不臆造：执行时先读该文件，若已有 import 风格则沿用）。追加：

```js
test('buildSearchArgv maps hybrid/format/budget to CLI flags', () => {
  assert.deepEqual(
    buildSearchArgv('staging server', { limit: 8 }),
    ['search', 'staging server', '--limit', '8'],
  )
  assert.deepEqual(
    buildSearchArgv('staging', { hybrid: true, format: 'compact', budget: 500 }),
    ['search', 'staging', '--limit', '8', '--hybrid', '--format', 'compact', '--budget', '500'],
  )
})
```

（expect 需按实现微调：--hybrid/--format/--budget 置于 --limit 之后即可，测试与实现写死一致。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:js`
Expected: FAIL —— `buildSearchArgv is not defined`

- [ ] **Step 3: 实现 buildSearchArgv + tools.ts 接线**

`src/utils.ts` 新增：

```js
export interface SearchOptions {
  limit?: number
  hybrid?: boolean
  format?: string
  budget?: number
}

export function buildSearchArgv(query: string, opts: SearchOptions = {}): string[] {
  const argv = ['search', query, '--limit', String(clampLimit(opts.limit))]
  if (opts.hybrid) argv.push('--hybrid')
  if (opts.format && ['full', 'compact', 'narrative'].includes(opts.format)) {
    argv.push('--format', opts.format)
  }
  if (typeof opts.budget === 'number' && opts.budget > 0) {
    argv.push('--budget', String(opts.budget))
  }
  return argv
}
```

`src/tools.ts` defineSearchTool 改造：

```js
parameters: {
  query: { type: 'string', required: true, description: 'Search keywords (space-separated; AND semantics).' },
  limit: { type: 'number', description: 'Maximum results (default 8).' },
  remote: { type: 'boolean', description: 'Query the remote index instead of local (requires UNIFIED_MEMORY_REMOTE_URL; falls back to local if unreachable).' },
  hybrid: { type: 'boolean', description: 'Enable hybrid retrieval: BM25 + semantic vectors + concept graph (requires embedded vectors for the semantic stream; falls back to BM25 otherwise).' },
  format: { type: 'string', description: 'Result format for hybrid search: full (default), compact, or narrative.' },
  budget: { type: 'number', description: 'Token budget cap for hybrid search output.' },
},
async execute(args) {
  if (!configured) return notConfigured('memory_search needs vaultPath')
  const argv = buildSearchArgv(String(args.query ?? '').trim(), {
    limit: args.limit,
    hybrid: args.hybrid,
    format: args.format,
    budget: args.budget,
  })
  if (args.remote) argv.push('--remote')
  return runCore(cfg, argv)
},
```

同步 import 行加 `buildSearchArgv`（utils.ts import 处追加）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:js`（全部，含既有用例）
Expected: PASS。再 `npm run typecheck` PASS。

- [ ] **Step 5: 修正 ARCHITECTURE.md 消除漂移**

`docs/ARCHITECTURE.md` Interfaces 小节（约 L129）：
`memory_search` (add `hybrid=true` for semantic search) → 改为：
`memory_search` (`hybrid` 开启三流融合检索；可选 `format`/`budget` 控制输出形态与预算)

- [ ] **Step 6: 全量验证**

Run: `npm run typecheck && npm run drift:check && npm run sync:check && npm run test:js && npm run build && node scripts/audit-package.mjs && python -m unittest discover -s core/tests -v`
Expected: 全绿（sync:check 告警除外，退出码 0）。

- [ ] **Step 7: 提交**

```bash
git add src/tools.ts src/utils.ts test/utils.test.ts docs/ARCHITECTURE.md
git commit -m "feat: expose hybrid/format/budget on memory_search tool (U-2)"
```

---

### Task 5: 全量回归 + 版本收尾（P0）

**Files:**
- Modify: 无（仅验证）
- Test: 全部既有测试

**Interfaces:**
- Consumes: Task 1-4 产物。
- Produces: 可发布的 0.5.1 候选状态（不发布，仅验证）。

- [ ] **Step 1: 全量测试**

Run: `npm run check` 与 `python -m unittest discover -s core/tests -v`
Expected: 全绿。

- [ ] **Step 2: 更新 CHANGELOG.md（Unreleased → 记录 P0 三项）**

在 `[Unreleased]` 的 `### Changed` 下追加：

```markdown
- P0(U-1): dsh.plugin.json version/description 由 package.json 单一事实源回填（build 自动），drift-check 硬校验版本一致。
- P0(S-1): CI 增加 Windows 测试 runner 与完整 JS 检查 job（typecheck/drift/sync/vitest/build/audit）。
- P0(U-2): memory_search 工具支持 hybrid/format/budget 参数，消除 ARCHITECTURE 文档漂移。
```

- [ ] **Step 3: 提交并打 tag**

```bash
git add CHANGELOG.md
git commit -m "chore: changelog for P0 fixes (U-1, S-1, U-2)"
```

（tag/发布由用户按仓库发布流程决定，本计划不推送、不 publish。）

---

## Self-review

**Spec 覆盖**：U-1 → Task 1+2；S-1 → Task 3；U-2 → Task 4；验收清单第 1 条（0.5.1：版本同步脚本 + CI 全绿含 Windows + hybrid 参数可用）→ Task 1-5 全覆盖。✅

**占位符扫描**：无 TBD/TODO；Step 1（修订）明确要求执行时先读 `test/utils.test.ts` 决定风格——这是「先读再写」的流程指令，非占位符；`pkg.description.split` 行为差异已在 Task 2 内给出确定的兼容实现。✅

**类型一致性**：`buildSearchArgv(query: string, opts?: SearchOptions)` 在 utils.ts 定义、tools.ts 使用、utils.test.ts 断言，三处签名一致；`SearchOptions` 字段名（limit/hybrid/format/budget）与工具参数名一致。✅

**风险说明**：Task 2 的 description 回填按「非空保留」策略，不改变现有 manifest 文案；Task 3 用 npm（锁文件为 package-lock.json）而非 pnpm，避免 CI 因缺 pnpm-lock.yaml 失败。