<div align="center">

<a href="docs/images/logo.jpg"><img src="docs/images/logo.jpg" alt="unified-agent-memory logo" width="320"></a>

# 🧠 unified-agent-memory

### *Unified Fleet-Wide Agent Memory System for DeepSeek Harness & Multi-Agent Runtimes*

*跨 Agent 统一持久化记忆系统 — 基于 Obsidian Vault 存储规范与 SQLite FTS5 本地索引的知识生命周期管理基座*

[![npm version](https://img.shields.io/npm/v/dsh-unified-agent-memory?style=flat-square&color=c084fc)](https://www.npmjs.com/package/dsh-unified-agent-memory)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Python Stdlib](https://img.shields.io/badge/python-3.9+%20stdlib--only-green.svg?style=flat-square)](#)
[![Obsidian Native](https://img.shields.io/badge/storage-Obsidian%20Vault-purple.svg?style=flat-square)](#)
[![Search Engine](https://img.shields.io/badge/index-SQLite%20FTS5-blue.svg?style=flat-square)](#)

[产品定位](#-产品定位与问题定义) • [核心优势](#-核心技术优势) • [存储结构](#-obsidian-vault-存储结构规范) • [部署](#-agent-全流程自动部署流程) • [快速开始](#-命令行快速体验-manual-quick-start) • [Standalone](#-没有-hermes--任何-agent-运行时怎么办-standalone--no-hermes-required)

</div>

---

## 📌 产品定位与问题定义

传统 Agent 记忆插件多数绑定于特定的 Agent 运行时（Single-Agent Scope），存储空间与会话相互隔离，缺乏统一的状态持久化与跨代理知识共享能力。

**`unified-agent-memory` 为多 Agent 舰队提供统一的知识管理基座**：`dsh`、`Codex`、`Claude Code` 与 `Hermes` 等多个独立代理共享同一 Obsidian Vault 知识仓库，配合纯 Python 标准库核心与 SQLite FTS5 本地索引，构建涵盖**知识摄取 (Ingestion)、晋升 (Promotion)、冲突裁决 (Adjudication)、衰减遗忘 (Decay/Retention)** 的全闭环生命周期管理系统。核心与 DSH 适配层以单个包发布，职责与写入边界见 [docs/DSH-MEMORY-ADAPTERS.md](docs/DSH-MEMORY-ADAPTERS.md)。

---

## 🚀 核心技术优势

- **统一单一真理来源** — 全 Fleet 代理共享一套 Markdown 知识库，Obsidian 直接可读、可审、可改。
- **纯 Python 标准库核心** — `core/` 零第三方依赖，SQLite FTS5 本地索引按 Vault 隔离，毫秒级检索，数据不出本机。
- **五路混合检索** — BM25 + 中文 bigram + 语义向量 + 概念图谱 + trigram，加权 RRF 融合，按真实 Token 预算裁剪。
- **完整生命周期管线** — 收件箱暂存 → Promoter 审核晋升 → 冲突裁决 → 版本化取代 → Forgetter 衰减归档，全程可逆、原子锁并发安全。
- **自动召回（dsh 内置）** — 每轮对话开始前自动判断是否值得查记忆，命中就注入 `<memory-data>` 上下文，模型不必记得调工具。
- **提示词隔离与凭据脱敏** — 检索输出强制 `<memory-data>` 包装；摄取前自动掩码 API Key/Token；OneDrive 等同步冲突副本不入索引。
- **升级自愈** — 插件启动时自动核对 CLI shim、各 Agent 托管段与 vault 模版，只补不覆盖、改前备份、失败下次重试（见 [docs/DEPLOY.md › Upgrading](docs/DEPLOY.md#upgrading)）。

---

## ⚖️ 系统特性对比 (Feature Matrix)

| 特性维度 | 🧠 unified-agent-memory | ❌ 单 Agent 存储插件 (dsh-mnemon 等) | ❌ 外部向量桥接器 (sgme 等) |
|---|---|---|---|
| **跨 Agent 共享粒度** | 全 Fleet 共享 (dsh/Codex/Claude/Hermes) | 强绑定单一 Harness 运行时 | 依赖集中式向量数据库中转 |
| **核心组件依赖** | 纯 Python 标准库，无第三方依赖 | 依赖 Host 宿主插件环境 | 需要部署额外的数据库中间件 |
| **生命周期控制能力** | 包含 摄取/晋升/裁决/遗忘 全链路 | 通常仅具备 存储+召回 基础功能 | 仅实现向量空间映射 |
| **知识可视化与可介入性** | Obsidian 原生 Markdown，人类直接可读 | 数据库黑盒 / 私有 JSON 格式 | 向量数据结构不可直观校验 |
| **问题诊断与修复闭环** | 侧边栏体检页给出后果+命令，可一键交给 Agent 修 | 无诊断，或只有一行 `error` | 无 |
| **升级后的一致性** | 启动时自动核对 shim / 托管段 / vault 模版并修补 | 依赖用户重装或照文档手工补步骤 | 需重新索引 |
| **安全审计与防护机制** | 标签隔离包装 + 凭据正则自动脱敏 | 依赖上层应用手工干预 | 易在向量库中泄露明文凭据 |

---

## 📂 Obsidian Vault 存储结构规范

系统自动在指定目录生成标准化 Obsidian Vault 存储层级。事实总库位于 `50-Agent-Context/`：

```text
50-Agent-Context/
├── 上下文索引.md          # 话题 → 文件映射表（入口）
├── 我的偏好摘要.md         # L3 用户画像：偏好/风格/语言
├── 常用路径与环境.md       # L3 画像：路径/版本/环境/服务器
├── 工程执行规则.md         # L3 画像：工程规则/验证红线
├── UI审美准则.md           # L3 画像：界面与设计偏好
├── 工具可用性检查.md       # L3 画像：工具/服务状态
├── Codex-Claude-Hermes协作规则.md  # L3 画像：多 Agent 协作边界
├── Agent提交区/           # 写入口：<agent>-<时间戳>.md（唯一写入通道）
│   └── 已处理/            # 晋升后归档留痕
├── 情境信息/              # L2：待晋升清单 / 冲突待裁决 / 已裁决 / 未归类
├── 记忆遗忘区/            # 衰减降级（可逆，不删除）
├── 会话归档/              # L0：脱敏会话历史
└── Hermes会话自动归档/     # L0：Hermes 每日会话归档
```

> 记忆数据库（派生副本）在 `~/.unified-memory/index-<vault-hash>.db`：docs / FTS5 /
> memories（逐行记忆，带类型/重要性/版本/来源）/ embeddings（向量，可选）/ 图谱 / 审计。

---

## 🏗️ 知识生命周期控制流

提交 → 脱敏 → 收件箱 → 索引 → Promoter 审核 →（无冲突）晋升 canonical /（有冲突）裁决队列 → 衰减遗忘。完整流程图与逐步说明见 [docs/ARCHITECTURE.md › Lifecycle](docs/ARCHITECTURE.md#lifecycle)。

---

## 🤖 Agent 全流程自动部署流程 (Agent-Driven Automated Deployment)

**部署工作完全由 AI Agent (DSH) 主导并自动执行**，无需手动修改规则文件：

1. **挂载插件**：`dsh plugin --profile web add dsh-unified-agent-memory`
2. **状态感知**：新会话调用 `memory_status` / `memory_setup`——`memory_setup` 先返回部署计划（建/复用哪个 vault、改哪些指令文件），确认后才动手。
3. **全自动装配**：DSH 按 [docs/AGENT-DEPLOY.md](docs/AGENT-DEPLOY.md) 任务书完成 vault 初始化、core 安装、各 Agent 指令文件托管段注入（幂等 + 自动备份），并以 `selfcheck` 收尾。部署决策矩阵（主控 Agent / 索引模式 / 晋升模式 / 接入范围）见任务书 [Step 0](docs/AGENT-DEPLOY.md#5-部署流程按顺序执行一步一验)。

多 Agent 共享同一框架：其余运行时靠 vault 内的说明文件与 CLI shim `~/.unified-memory/bin/memory` 接入，不需要再装一份插件。桌面端部署见 [docs/DESKTOP.md](docs/DESKTOP.md)。

> **非 DSH 环境部署**：复制 [docs/AGENT-DEPLOY-PROMPT.md](docs/AGENT-DEPLOY-PROMPT.md) 中的 Prompt 发送给任意 AI 编码代理即可触发全自动部署。

---

## 💻 命令行快速体验 (Manual Quick Start)

```bash
# 1. 克隆仓库并安装 Core
git clone https://github.com/Noelune/unified-agent-memory.git && cd unified-agent-memory
pip install -e ./core

# 2. 初始化 Vault 模版结构
python setup/setup.py init --vault ~/Documents/AgentMemory

# 3. 提交与检索知识测试
memory submit "staging 服务器环境绑定在 127.0.0.1:8080" --agent alpha
memory search "staging 服务器"

# 4. 执行 Promoter 归纳与应用
python -m unified_memory.promoter --review
python -m unified_memory.promoter --apply
```

新事实与既有事实冲突时默认由 Agent 先裁决（`memory decide` / `memory advise`），判不了才轮到人——命令与四种裁决的含义见 [docs/DEPLOY.md › Conflicts](docs/DEPLOY.md#conflicts--the-agent-decides-first-you-get-asked-only-when-it-cant)。

完整指南：[docs/DEPLOY.md](docs/DEPLOY.md) · 系统架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 安全文档：[docs/SECURITY.md](docs/SECURITY.md)

---

## 🚫 没有 Hermes / 任何 Agent 运行时怎么办？(Standalone — no Hermes required)

**核心完全不依赖 Hermes 或任何 Agent 运行时**——vault、inbox、promoter、forgetter、SQLite FTS5 索引都是纯 Python 标准库，直接当命令行工具用即可：

```bash
# 一个完整的"人肉"工作流，无需任何 agent：
python setup/setup.py init --vault ~/Documents/AgentMemory   # 1. 初始化 vault
memory submit "the build server is at 127.0.0.1:8080" --agent you   # 2. 写一条事实
memory search "build server"                                # 3. 检索（FTS5 本地索引）
python -m unified_memory.promoter --review                   # 4. 生成待晋升清单
python -m unified_memory.promoter --apply                    # 5. 晋升进 canonical
python setup/setup.py cron --vault ~/Documents/AgentMemory   # 6. 定时：每日晋升+每周遗忘，错过自动补跑
```

对接你自己的运行时（不一定是 Hermes）只需要三件事：

1. **写**：调 `memory submit`（或 dsh 插件的 `memory_submit`）。
2. **定期晋升（dsh 默认主导，需要 Agent 参与，不是裸脚本）**：`setup.py cron` 一键注册每日晋升与每周遗忘的定时，dsh 插件在启动时/每小时自动补跑错过的任务；其他带调度的运行时可承担同一角色（`--review` → 裁决冲突 → `--apply`），错过就跑 `python -m unified_memory.catchup`。细节见 [docs/DEPLOY.md](docs/DEPLOY.md) 的 *Full mode* 章节。
3. **读/注入**：dsh 用户不需要自己做这一步——插件内置 `agent/pre-step` 自动召回（细节见 [docs/DSH-MEMORY-ADAPTERS.md](docs/DSH-MEMORY-ADAPTERS.md)）。其他运行时可参考 `integrations/hermes/README.md` 的 hook 草图，把 `memory search` / `memory show` 的输出包进 `<memory-data>` 注入到系统提示。

Hermes 集成（`integrations/hermes/`）只是"其中一个 Agent 接进来"的可选示例，不是前提条件。

---

## 📂 仓库目录结构 (Repository Layout)

| 路径 | 功能说明 |
|---|---|
| `core/` | 零第三方依赖 Python 包：`memory.py` (初始化/检索/提交), `promoter.py` (审核/应用/裁决), `forgetter.py` (衰减归档), `catchup.py` (错过补跑), `conflict.py` (冲突判定) |
| `vault-template/` | 即用型 Obsidian Vault 模版：7 份标准化 Canonical 笔记、提交区、情境信息与记忆遗忘区 |
| `src/` | DSH 宿主半边：工具注册、路由、`agent/pre-step` 自动召回、浏览器侧边栏面板、升级规划器（`upgrade.ts`）与唯一写入点（`upgrade-run.ts`） |
| `lib/` | 构建产物：插件入口与 `client-ui.js`（由 `build.mjs` 生成，不手改） |
| `integrations/` | `AGENTS.md` (Codex)、`CLAUDE.md` (Claude) 与 Hermes Hook 集成示例 |
| `setup/` | `setup.py` (init/cron/selfcheck)、`deploy.py` (托管段注入) 与 `selfcheck.py` |
| `docs/` | ARCHITECTURE / DEPLOY / DESKTOP / SECURITY / JSON-CONTRACT 等 |

---

## 🔧 环境要求 (Requirements)

- Python ≥ 3.10 (核心 Engine，仅需 Python 标准库)
- Node.js ≥ 20 + DSH `0.2.1-rc.2`（兼容 `0.2.0-rc.2`、`0.1.5-rc.2`）(仅 dsh 插件需要；桌面端见 [docs/DESKTOP.md](docs/DESKTOP.md))
- 推荐使用 Obsidian 浏览和查看 Vault 知识库，但非强制要求 — 所有文件均为标准 Markdown 与 SQLite 数据库。

---

## 📌 维护状态 (Maintenance Status)

- **Maintainer**: [Noelune](https://github.com/Noelune)
- **Community-maintained** — 欢迎提交 Issue 与 Pull Request。缺陷修复通常在 1–2 周内处理，安全问题优先解决。
- **Compatibility**: 验证目标为 DSH `0.2.1-rc.2` 与 `0.2.0-rc.2`（含桌面端）。升级 DSH 后若工具消失，先核对版本线——宿主会整体跳过 peer 范围不匹配的插件包（[docs/DEPLOY.md › Upgrading](docs/DEPLOY.md#upgrading)）。上游 API 变更说明记录于 [CHANGELOG.md](CHANGELOG.md)。
- **License**: **MIT License** — 允许商业化使用。

---

## 🛡️ 安全规范 (Security)

详细说明请参阅 [docs/SECURITY.md](docs/SECURITY.md)。

* 存储隔离：Vault 内部存储的所有内容均被视为纯文本数据（Data），绝不可直接作为推理指令执行。
* 凭据保护：敏感凭据在进入 Vault 存储前必须经过脱敏过滤，默认索引数据库仅在本地宿主机进行持久化。
* 审核机制：知识晋升过程默认采用人工确认模式，结合原子文件锁与原子写入确保并发控制安全。

---

## 🤝 贡献指南 (Contributing)

欢迎提交 Pull Request。提交前请确保运行核心测试套件（`python -m unittest discover -s core/tests`）。项目的 CI 流程会在每次 Push 时自动执行测试、代码密钥扫描（gitleaks）与开源许可证合规检查。
