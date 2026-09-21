# dsh-unified-agent-memory 改进与升级设计

> 日期：2026-09-21 ｜ 状态：待审阅 ｜ 作者：DSH（基于项目源码逐模块审读 + 同类插件市场调研）

## 1. 背景与目标

`dsh-unified-agent-memory` v0.5.0 是一套「跨 Agent 统一持久化记忆系统」：Obsidian Vault 为单一真理来源，纯 Python 标准库核心（`core/`）负责摄取 / 晋升 / 裁决 / 遗忘全生命周期与混合检索，DSH 适配层（`src/`）暴露 4 个模型工具，浏览器侧（`src/client/`）提供侧边栏状态面板。

本文目标是：结合当前源码逐模块审读结论，与 DSH 插件市场中同类高下载量 Agent memory 项目（`dsh-mnemon`、`dsh-tdai-memory`、`@kiwifruit/dsh-memory`、`@modusensus/dsh-mneme`，以及通用参照 `agentmemory`、`mem0`、`Letta`、`TencentDB-Agent-Memory`）做横向对比，从**统一性、优美性、稳定性、功能性**四个维度给出改进点、优化点与升级点，并按「P0 快赢 / P1 增值 / P2 大升级」排定优先级。

**核心约束（防屎山）**：

- 保持三层边界不动：`core`（纯 CLI 引擎）→ `src`（DSH 适配）→ `client`（Web UI），各自单职责、可独立测试。
- 保持「核心零第三方依赖」卖点：所有大功能先按**可选功能 + 依赖探测 + 静默降级**模式实现（沿用 `embed.py` 的既有模式），默认关闭。
- canonical 只读、写入仅走 `Agent提交区`、凭据不入库、检索输出 `<memory-data>` 包裹——这四条安全边界任何升级不得突破。
- 每个新模块必须带测试；新增 CLI 子命令/工具必须同步 `driftrc.yaml`、`vault-template` 与文档，防止再引入漂移。

---

## 2. 现状盘点（审读结论）

### 2.1 架构与规模

| 层 | 位置 | 规模 | 职责 |
|---|---|---|---|
| Python 核心 | `core/unified_memory/` | 13 模块 ≈ 125 KB | init/search/show/submit/status/embed/digest/graph/drift + promoter/forgetter/conflict/schema/maintenance |
| DSH 适配 | `src/` | 6 文件 ≈ 35 KB | 4 工具注册、配置解析、子进程执行、更新检查、状态路由 |
| 浏览器侧 | `src/client/` | 3 文件 ≈ 10 KB | 侧边栏状态面板（只读，轮询 `/status`） |
| 集成与部署 | `integrations/` `setup/` `scripts/` | — | codex/claude/hermes 集成、部署器、漂移/同步/审计脚本 |
| 测试 | `core/tests/`（13 文件，双 Python 版本）`test/`（4 文件） | — | Python unittest + Node vitest |
| 文档 | `docs/`（8 篇 + 2 specs/plans） | — | 架构/部署/安全/经验/验证报告/适配边界 |

### 2.2 已具备的能力（优点，升级时保持）

1. **写入闭环**：唯一写入通道 `Agent提交区/<agent>-<时间戳>.md`，原子创建、凭据形状拒绝。
2. **晋升闭环保**：`--review` → （人工确认）→ `--apply`；`--auto` 显式 opt-in；冲突进 `情境信息/` 待裁决；取代信号移动旧行到 `已取代` 并索引标记。
3. **检索三流融合**：BM25 词法 + SiliconFlow 语义向量（可选）+ 概念共现图谱（可选），加权 RRF 融合、同文档多样化、token 预算裁剪、无向量自动回退。
4. **遗忘评分**：`重要性 × (持久地板 + 时间衰减) + 访问强化`，可逆降级到 `记忆遗忘区/`。
5. **加固到位**：DSH 适配层已有输入归一化、输出截断（1 MB）/超时（25 s）/脱敏、能力探测、路由清理；`sync-check`/`drift-check`/`audit-package` 三条防线。
6. **部署安全**：部署器 preview/apply/rollback、时间戳备份、锁保护、只动白名单目标。

### 2.3 审读中发现的真实问题（先修）

| # | 问题 | 证据 | 维度 |
|---|---|---|---|
| P-1 | **版本漂移**：`package.json` = `0.5.0`，而 `dsh.plugin.json` = `0.3.1`；`sync-check.mjs` 只对 package.json 与 npm 校验，`drift-check.mjs` 只校验 name 不校验 version | package.json:3 与 dsh.plugin.json:4 直接对比 | 统一性 |
| P-2 | **CI 缺口**：`ci.yml` 只有 Python unittest（ubuntu+macos）+ gitleaks + license；**无 Windows runner**（本项目主目标平台）、**JS 测试/vitest、drift-check、audit-package、build 均未进 CI** | ci.yml 全文 | 稳定性 |
| P-3 | **文档与实现漂移**：`docs/ARCHITECTURE.md` 写 `memory_search (add hybrid=true for semantic search)`，但 `src/tools.ts` 的 `memory_search` 没有 `hybrid` 参数（CLI 才有 `--hybrid`）；`remote=true` 参数存在但 `--format`/`--budget` 未暴露 | ARCHITECTURE.md:129 vs tools.ts:48-64 | 统一性 |
| P-4 | **FTS5 中文检索弱**：`fts MATCH` 对中文按整串/空格分词效果差（unicode61 对 CJK 退化为整串 token），fallback 是 `O(n)` 全表 substring 扫描——Vault 增长后检索质量与性能双降 | index.py:264-300 | 功能性 |
| P-5 | **客户端过薄**：浏览器侧只有一个只读状态面板，无搜索、无浏览、无待晋升/冲突可视化；2026-08-17 spec 计划的 `settings.section`（记忆系统设置页）**未落地** | src/client/index.ts 全文；grep `settings.section` 无结果 | 优美性 |
| P-6 | **无管理类工具**：DSH 侧只有 search/show/submit/status；promote 预览、forget 预览、graph 统计 Agent 完全不可见，只能靠人跑 CLI | tools.ts 工具清单 | 功能性 |
| P-7 | **启动期网络依赖**：`updater.ts` 每次插件启动查 `registry.npmjs.org`（5 s 超时、静默降级，可接受，但对中国网络默认链路不友好，且无 registry 配置项） | updater.ts:99 | 稳定性/体验 |
| P-8 | **子进程冷启动**：每次工具调用 spawn 一个 Python 进程（`execFile` ≈ 100–300 ms 冷启动）；量小可忍，量大时有感 | utils.ts:127-168 | 稳定性 |

---

## 3. 市场对标

> 数据来源：npm registry 检索、[Oh-My-DSH 插件生态列表](https://github.com/NoWint/Oh-My-DSH)、[agentmemory](https://newreleases.io/project/github/rohitg00/agentmemory)、[mem0 官方博客](https://mem0.ai/blog/how-to-create-ai-agents-with-long-term-memory)、[total-agent-memory 竞品对比](https://raw.githubusercontent.com/vbcherepanov/total-agent-memory/refs/tags/v12.1.0/docs/vs-competitors.md)。

| 项目 | 存储 | 生命周期 | 检索 | 客户端 | 生态接入 |
|---|---|---|---|---|---|
| **本项目** | Obsidian Vault + SQLite | 全闭环（摄取/晋升/裁决/遗忘/取代） | BM25+向量+图谱 RRF | 4 工具 + 状态面板 | CLI/DSH/AGENTS·MD/Hermes/远程索引 |
| dsh-mnemon `@jojoman2024` | 插件私有存储 | 存+召回 | 基础 | 单侧 | DSH 单运行时 |
| dsh-tdai-memory `Scorp1o117` | 跨会话持久记忆 | 存+召回 | 基础 | 工具 | DSH 单运行时 |
| `@kiwifruit/dsh-memory` | —（新进市场） | — | — | — | — |
| `@modusensus/dsh-mneme` | —（新进市场） | — | — | — | — |
| agentmemory（rohitg00） | 数据库+文件 | 有类型/版本 | BM25+向量+图谱，token 高效召回 | SDK | Python |
| mem0 | 向量库(托管/本地) | 增量学习+实体图 | 向量+图+时间混合 | API/SDK/UI | 多框架 MCP |
| Letta | DB + 记忆块 | 自我编辑记忆 | 混合 | 服务+UI | SDK/API |
| TencentDB-Agent-Memory | DB + 分层 | L0-L3 | BM25 为主 | SDK | 多框架 |

**结论**：本项目在「生命周期完整度」「本地优先 + 人类可审计（Obsidian）」「跨运行时广度」三项上领先；短板集中在**可视化客户端**（对标 mem0/Letta 的成熟 UI）、**生态协议接入**（mem0 已接 MCP，本项目无 MCP）与**中文检索精度**（同类多为英文优先）。

---

## 4. 改进点总览（四维度 × 优先级）

| 编号 | 维度 | 改进点 | 类型 | 优先级 | 规模 |
|---|---|---|---|---|---|
| U-1 | 统一性 | 版本元数据单一事实源 + 校验覆盖 dsh.plugin.json | 修复 | **P0** | S |
| U-2 | 统一性 | 文档-实现漂移修复（hybrid 参数、统一工具描述） | 修复 | **P0** | S |
| U-3 | 统一性 | 工具输出契约统一（ok/output/error + 结构化 JSON 可选） | 优化 | P1 | M |
| S-1 | 稳定性 | CI 补 Windows runner + JS/drift/audit/build 全量进 CI | 修复 | **P0** | S |
| S-2 | 稳定性 | updater 支持 registry 配置（默认 npmmirror 探测链） | 优化 | P1 | S |
| S-3 | 稳定性 | 子进程性能：`--json` 快速路径 + 可选常驻 daemon（opt-in） | 优化 | P2 | L |
| S-4 | 稳定性 | 错误信息本地化 + 退出码契约文档 | 优化 | P1 | S |
| F-1 | 功能性 | 管理类工具：`memory_preview`（promote/forget dry-run） | 新功能 | P1 | M |
| F-2 | 功能性 | `--json` 输出模式：UI/脚本统一消费 | 新功能 | P1 | M |
| F-3 | 功能性 | 中文检索升级：FTS5 trigram（SQLite≥3.34 原生） | 优化 | P1 | M |
| F-4 | 功能性 | **MCP Server（可选）**：把 search/submit/show 暴露为 MCP 工具 | 大升级 | P2 | L |
| F-5 | 功能性 | **记忆浏览器 Dashboard**：搜索/浏览/待晋升/冲突可视化 | 大升级 | P2 | L |
| F-6 | 功能性 | **知识图谱可视化**：graph 数据 → 前端力导向图 | 大升级 | P2 | M |
| F-7 | 功能性 | 多 Vault / Profile 切换 | 新功能 | P2 | M |
| F-8 | 功能性 | 可选本地嵌入引擎（依赖探测 + 降级到 SiliconFlow） | 新功能 | P2 | M |
| B-1 | 优美性 | 落地 `记忆系统` 设置页（settings.section） | 新功能 | P1 | M |
| B-2 | 优美性 | 状态面板 → 可交互 Dashboard 入口（空态/加载/错误态） | 优化 | P1 | M |
| B-3 | 优美性 | 图谱/统计可视化（承接 F-6，复用 dsw CSS 变量） | 互动 | P2 | M |

---

## 5. 统一性（Unity）

### U-1 版本元数据单一事实源（P0）

**现状**：三处版本：`package.json:3`（0.5.0）、`dsh.plugin.json:4`（0.3.1——已漂移）；`sync-check.mjs` 只比较 package.json ↔ npm，`drift-check.mjs` 只校验 name。

**方案**：
1. `drift-check.mjs` 增加：`dsh.plugin.json.version === package.json.version` 硬校验（失败即 exit 1）。
2. `build.mjs` 增加一步：构建时从 package.json 回填 `dsh.plugin.json` 的 version/description（源单一，产物派生），并打印 diff。
3. pre-commit hook（`scripts/install-hooks.mjs` 已建）追加调用 `pnpm run drift:check`。

**测试**：`test/` 加一个 `version-sync.test.mjs`：改 package.json 版本后运行脚本断言两文件一致，改回后恢复。

### U-2 文档-实现漂移修复（P0）

**现状**：ARCHITECTURE.md 声称 `memory_search` 支持 `hybrid=true`，实现没有；`README.zh.md` 的 Feature Matrix 与本项目实际能力大体一致但未列 MCP。漂移会直接误导接入方。

**方案**（二选一，推荐 A）：
- **A（推荐）**：给 `memory_search` 增加 `hybrid: boolean` + `format` + `budget` 参数透传 CLI `--hybrid/--format/--budget` —— 文档描述的能力全部落为真实能力，同时让 Agent 能用上高质量混合检索。
- B：改文档去掉 hybrid 声称。不做，因为能力已在 CLI，给 Agent 用上价值更高。

**测试**：`test/dsh-host-adapter.test.mjs` 增加 hybrid 参数透传断言。

### U-3 工具输出契约统一（P1）

**现状**：4 个工具 schema 相同（ok/output/error），但 `notConfigured` 把引导塞进 `output` 而非 `error`；`memory_status` 在 `output` 尾部追加 deploy 提示——消费方需特判。

**方案**：统一约定（写入 `docs/DSH-MEMORY-ADAPTERS.md`）：
- `ok:false` 的配置错误 → `error` 字段携带，`output` 只放建议操作的纯文本（保持现状结构，明确文档化，**不改字段语义破坏消费方**）。
- 所有成功结果统一为 `output`（现状已如此），新增可选 `data` 字段承载结构化结果（与 F-2 的 `--json` 配套）。

---

## 6. 稳定性（Stability）

### S-1 CI 全量加固（P0）

**现状**：`ci.yml` 只跑 Python 核心测试（ubuntu/macos），JS 测试、drift、audit、build 全靠本地 pre-push hook。

**方案**：
```yaml
# 新增 job: unit-js（node 22）
run: pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run drift:check && pnpm run test:js && pnpm run build && pnpm run audit:package
# Python job 增加 windows-latest 到 matrix（本项目主目标平台：Windows）
os: [ubuntu-latest, windows-latest, macos-latest]
```
Windows runner 同时验证中文路径/文件锁（`common.py` 的 `file_lock` 在 Windows 上的行为）——这是本项目实际主战场，当前 CI 完全没覆盖。

### S-2 updater registry 可配置（P1）

**现状**：硬编码 `registry.npmjs.org`（updater.ts:49）。

**方案**：新增配置 `npmRegistry`（默认 `https://registry.npmmirror.com/dsh-unified-agent-memory`，本机环境已有 npmmirror 基建），失败静默降级保持现状。检查逻辑与 CACHE_TTL 不变。

### S-3 子进程性能（P2，opt-in）

**现状**：每次工具调用 `execFile(python -m unified_memory.memory ...)`，冷启动 100–300 ms。

**方案（低投入版，推荐先做）**：
- CLI 增加 `--json` 全局开关：单次调用输出纯 JSON（成功 `{ok,data}` / 失败 `{ok:false,error,kind}`），省去 DSH 侧解析非结构化文本的脆弱性。
- `search` 优先走 `--json` 路径，工具侧不再做文本后处理。

**方案（高投入，P2 尾期）**：可选常驻 daemon（`memory serve`，stdio JSON-RPC），配置 `daemon:true` 时工具复用进程；进程消失自动回退单次模式。**默认关闭**，作为性能实验特性。

### S-4 错误契约文档化（P1）

**现状**：错误分类 `kind: timeout|crash|missing` 存在但未文档化，消费方不知道如何处理 `ok:false`。

**方案**：在 `docs/DSH-MEMORY-ADAPTERS.md` 增加「错误契约」小节：kind 含义、建议动作、退出码 → kind 映射表；`core` 侧增加可预测的退出码（0=ok，2=用户输入/配置错误，3=vault 缺失，4=索引不可用，5=内部错误）。

---

## 7. 功能性（Functionality）

### F-1 管理类工具 `memory_preview`（P1）

**动机**：Agent 目前「只读 + 只写」，对系统状态（待晋升清单、冲突数、遗忘候选、图谱统计）完全无感知，无法自我治理。

**方案**：新增工具 `memory_preview`，参数 `what ∈ {promotion, conflicts, forget, stats}`，**只读**，返回：
- `promotion`：`情境信息/待晋升.md` 解析结果（条数 + 前 N 条摘要）
- `conflicts`：冲突队列条目（新/旧/来源，脱敏）
- `forget`：forgetter 评分的候选列表（`--dry-run` 语义）
- `stats`：memory 数 / 向量数 / inbox 待处理 / 上周晋升数

**边界**：绝不执行晋升/裁决/遗忘，只预览；输出走 `<memory-data>` 包裹。

**测试**：core 侧给 `forgetter`/`promoter` 的 dry-run 已有测试基础；新增工具级测试断言预览内容脱敏。

### F-2 `--json` 输出模式（P1）

与 S-3 配套的接口能力：所有 CLI 子命令支持 `--json`（init/search/show/submit/status/embed/digest/graph/promoter--review/forgetter--dry-run）。JSON schema 收进 `docs/ARCHITECTURE.md`，供 UI 与脚本统一消费。此项是 F-5/Dashboard 的前置依赖。

### F-3 中文检索升级（P1）

**现状**：`fts`/`fts_mem` 用默认 unicode61 tokenizer，CJK 文本按整串分词，`MATCH` 中文几乎必失败 → 落到 O(n) substring fallback（index.py:288-297）。Vault 一旦上千行，检索即性能与质量双降。**这是当前最影响实际体验的检索缺陷。**

**方案（零依赖，推荐）**：
1. schema 探测 SQLite ≥ 3.34，若支持则用 **FTS5 trigram tokenizer** 建 `fts_mem`（`tokenize = 'trigram'`），中文子串/BIGRAM 匹配能力直接获得；`_fts_supported` 探测扩展为三态（none / unicode61 / trigram）。
2. 不支持的旧 SQLite 保持现状 substring fallback；迁移路径：`memory status` 自动重建索引（已有 update_index 增量重建机制承接）。
3. `bm25_memory_search` 的 trigram 查询需要对查询清洗（移除 <3 字符 token 与标点）。

**测试**：`core/tests/test_index.py` 增加中文查询用例：`记忆`、`服务器端口` 必须命中中文事实行；断言 trigram 路径与 fallback 路径结果一致。

### F-4 MCP Server（P2，可选模块，大升级）

**动机**：[mem0](https://docs.mem0.ai/) 等已提供 MCP；MCP 是当前 Agent 生态互操作事实标准。把本项目暴露为 MCP server 后，**任何支持 MCP 的客户端（Claude Desktop、Cursor、其他 harness）可直接接入同一共享 Vault**——完美契合「跨 Agent 统一记忆」的产品定位，且不依赖 DSH。

**方案（沿用 embed 模式）**：
- 新增 `setup/mcp_server.py`（可选依赖：`mcp` pip 包；未安装时 `memory status` 明确提示，不报错）。
- 暴露工具：`memory_search` / `memory_show` / `memory_submit` / `memory_preview`——与 DSH 工具一一对应，同一 core 后端。
- 安全边界不变：canonical 只读、inbox 写入、脱敏、`<memory-data>` 包裹。
- 文档：`docs/MCP.md` 写接入示例（Claude Desktop / 通用 MCP 客户端）。

**测试**：`setup/tests/test_mcp_server.py`（fake transport 断言工具名与参数契约；不依赖真实 mcp SDK 运行）。

### F-5 记忆浏览器 Dashboard（P2，大升级）

**动机**：对标 mem0/Letta 的成熟 UI，把当前只读状态面板升级为真正「可审计、可搜索」的记忆管理界面；同时落地 2026-08-17 spec 遗留的 settings.section。

**方案**：
- `client` 侧：侧边栏按钮 → 打开 Dashboard（标签页：搜索 / 浏览 / 待晋升 / 冲突 / 统计）。
- host 侧新增同源只读路由：
  - `GET /api/dsh-unified-agent-memory/search?q=...&limit=...`（走后端 `--json`）
  - `GET .../browse?doc=...`（show 语义）
  - `GET .../preview?what=...`（promotion/conflicts/stats，只读）
- 数据流复用 F-2 的 JSON 契约；所有内容渲染前再次脱敏；页面只读，写入仍走模型工具/CLI。
- 样式延续现有 `--dsw-alias-*` CSS 变量（styles.ts 已有先例），保证主题一致。

**测试**：`test/web-ui-contract.test.mjs` 扩展路由只读断言；`test/dsh-host-adapter.test.mjs` 扩展 `--json` 透传断言。

### F-6 知识图谱可视化（P2）

**动机**：`graph.py` 已产出概念共现图（`graph_nodes`/`graph_edges`），但无任何可视化出口——数据躺在库里，用户不可见。

**方案**：Dashboard 增加「图谱」标签：零依赖 canvas/SVG 力导向图（不引第三方库，跟随项目零依赖哲学——前端本身就是零依赖 React+h），节点=概念、边=共现权重；点击节点 → 联动检索该概念相关记忆。数据源：新增 `/graph` 路由调用 `memory graph --json`。

### F-7 多 Vault / Profile 切换（P2）

**动机**：当前 `vaultPath` 单一；工作/个人分离或迁移测试需要多 Vault。

**方案**：配置支持 `vaults: {work: path, personal: path}` + 默认 `vault`；工具/路由参数可选 `vault`；CLI 侧 env `UNIFIED_MEMORY_VAULT` 优先级不变。**保持向后兼容**：旧单值配置照常工作。此功能放 P2 尾期，避免过早抽象。

### F-8 可选本地嵌入引擎（P2）

**动机**：SiliconFlow 是外部 API（网络依赖 + 数据出机）；部分用户偏好纯本地。

**方案**：`embed.py` 增加 provider 抽象：`embedding.provider ∈ {siliconflow, local}`；`local` 优先探测已安装的轻量库（如 sentence-transformers 可选依赖，未装则降级 siliconflow→BM25）。与现有「失败静默降级」链一致。**默认仍 siliconflow**，不增加零依赖用户的负担。

---

## 8. 优美性（UI/UX）

### B-1 落地「记忆系统」设置页（P1）

**现状**：2026-08-17 spec 计划的 `settings.section` 未实现；用户无法在 GUI 里查看/调整 vault 路径、索引状态。

**方案**：`client` 注册 `settings.section`（标签「记忆系统」），内容与状态面板一致但更完整：vault 路径、python/core 路径、远程开关、索引健康、inbox 待处理数、一键跳转 Dashboard。只读 + 展示，不做写入（配置写入仍在设置面板由用户手改，避免越权）。

### B-2 面板 → Dashboard 入口（P1）

**现状**：面板只有一行版本 + JSON 文本 dump（Panel.tsx:121-125），无空态/加载/错误态区分。

**方案**：状态面板改为 Dashboard 的「路由入口」：健康概览卡片（vault/索引/inbox 三枚徽章） + 「打开 Dashboard」按钮；轮询失败显示重试态而非静默。样式跟随 `--dsw-alias-*`。

### B-3 可视化组件（P2）

承接 F-6 图谱力导向图；统计卡片（记忆数/向量数/每周晋升趋势——chart 用自绘 SVG，不引依赖）。

---

## 9. 优先级路线图

### Phase 0 — 巩固（P0，建议下一版 0.5.1 前完成）

1. U-1 版本单一事实源 + 校验入 CI/pre-commit
2. S-1 CI 全量加固（Windows runner + JS/drift/audit/build）
3. U-2 文档-实现漂移修复（`memory_search` 支持 hybrid）

> 交付：`version-sync.test.mjs`、ci.yml 扩展、tools.ts hybrid 参数 + 测试。全绿后发 0.5.1。

### Phase 1 — 增值（P1，0.6.x）

4. F-2 `--json` 输出模式（全子命令）
5. F-1 `memory_preview` 管理工具
6. F-3 中文检索 trigram 升级
7. B-1 设置页 + B-2 面板改版
8. S-2 updater registry 配置 + S-4 错误契约文档

> 交付：`--json` 契约文档、`memory_preview` 4 视图、trigram 索引迁移、设置页/Dashboard 入口。0.6.0 发布。

### Phase 2 — 大升级（P2，0.7+）

9. F-5 记忆浏览器 Dashboard（搜索/浏览/待晋升/冲突/统计）
10. F-4 MCP Server（可选模块）
11. F-6 图谱可视化
12. F-7 多 Vault / F-8 本地嵌入 / S-3 daemon（按需求择取）

> 每个大功能独立评审、独立版本小节、默认关闭。

---

## 10. 非目标（Non-Goals）

- **不破坏**：core 零依赖（F-4/F-8 的依赖全部是可选探测）；canonical 只读；凭据不入库；`<memory-data>` 包裹。
- **不加**：集中式向量数据库托管（保持 local-first 定位，remote index server 保留为可选）。
- **不合并**：不把 `dsh-memory-discipline` 能力并入本包核心（保持 DSH-MEMORY-ADAPTERS.md 定义的层边界）。
- **不改**：Obsidian 存储规范（7 份 canonical 笔记结构保持不变——改动会破坏既有用户 Vault 与 drift 契约）。

---

## 11. 风险与回滚

| 风险 | 缓解 |
|---|---|
| trigram 索引迁移影响现有库 | 依赖既有 update_index 增量重建；trigram 不可用时自动回退 unicode61/substring（三态探测） |
| `--json` 与文本输出并存引入双路径 | JSON schema 入文档；文本路径保持现状为新默认，`--json` 显式开启 |
| Dashboard 路由增大攻击面 | 全部只读 + 同源 + 脱敏；复用现有 status 路由的注册/清理模式 |
| hybrid 参数改变工具行为 | 默认 `hybrid=false` 保持现状，显式开启 |
| MCP 模块影响零依赖卖点 | 依赖探测，未安装 mcp 包时 status 提示 + 不加载 |

---

## 12. 验收清单

- [ ] 0.5.1：版本同步脚本 + CI 全绿（含 Windows）+ hybrid 参数可用
- [ ] 0.6.0：`--json` 全子命令 + `memory_preview` + 中文检索升级 + 设置页
- [ ] 0.7.0（任一满足即可发布大版本）：Dashboard / MCP / 图谱可视化
- [ ] 每阶段 `pnpm run check`（typecheck+drift+sync+test:js+test+build+drift:python）与 `python -m unittest discover -s core/tests -v` 全绿