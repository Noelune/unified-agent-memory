# unified-agent-memory

> 统一 Agent 记忆系统（DeepSeek Harness 插件）：**多 Agent 共享一个 Obsidian vault**（dsh / Codex / Claude Code / Hermes…），配零依赖 Python core 完成检索/晋升/冲突裁决/遗忘生命周期。本地优先、零云依赖、5 分钟跑通闭环。

[![npm version](https://img.shields.io/npm/v/dsh-unified-agent-memory)](https://www.npmjs.com/package/dsh-unified-agent-memory)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 为什么需要它——与同类记忆插件的区别

大多数记忆插件是单 Agent 的：只记得*你自己*在*你的 harness* 里的会话。本项目是一个**供一群 Agent 共享的完整自托管记忆系统**：

| 能力 | unified-agent-memory | 典型单 Agent 记忆插件（dsh-mnemon、dsh-memory…） |
|---|---|---|
| dsh + Codex + Claude + Hermes 共享 | ✅ 同一 vault、同一份事实 | ❌ 仅限单一 harness |
| 独立 core（不依赖任何 Agent 运行时） | ✅ 纯 Python 标准库，纯 CLI 可用 | ❌ 依赖插件宿主 |
| 完整生命周期：晋升/去重/冲突裁决/遗忘 | ✅ 内置 | ⚠️ 通常只有存+取 |
| 本地优先索引（SQLite FTS5，无云） | ✅ 默认 | 不一 |
| 人工确认晋升 | ✅ review → apply（auto 需显式开启） | 无 |

对比 **sgme**（外部记忆引擎的桥接层）：本仓库是**自带全套的 starter-kit**——vault 模板 + core + 各 Agent 接入 + setup，无服务器也能完整部署。对比 **nowledge-mem**（prompt 召回 MCP 层）：本项目拥有包括晋升与遗忘在内的完整生命周期。

## 包含什么

- **一个 Obsidian vault = 所有 Agent 的最高事实源**（canonical 笔记、写入口提交区、冲突队列、遗忘区）。
- **零依赖 Python core**（core/）：memory init|search|show|submit、promoter --review/--apply/--auto/adjudicate、forgetter。零第三方包；不依赖任何 Agent 运行时。
- **本地优先语义索引**：本机 SQLite FTS5（~/.unified-memory/index.db）——隐私不出本机；远端索引为可选进阶。
- **安全默认**：凭据样式的行在提交时拒绝、输出时脱敏；检索结果包在 <memory-data> 标记内（数据而非指令）；晋升默认人工确认；文件锁 + 原子写保证多 Agent 并发安全。
- **dsh 一等公民**：cordis 插件注册 memory_search / memory_show / memory_submit / memory_status 模型工具，未配置时优雅降级。
- **Codex / Claude / Hermes 接入**：现成的 AGENTS.md / CLAUDE.md 模板与 hooks 示例。
- **Hermes 风格自动化**：`integrations/hermes/` 可运行脚本——每轮上下文注入、每日晋升 cron（含整理 + 每周遗忘）、会话归档；另附可选**零依赖远端索引服务器**（多设备检索）。

## 快速开始（5 步，无服务器、无 Hermes）

    # 1. 获取代码并安装零依赖 core
    git clone https://github.com/Noelune/unified-agent-memory.git && cd unified-agent-memory
    pip install -e ./core

    # 2. 一键初始化 vault（完整模板 + 配置）
    python setup/setup.py init --vault ~/Documents/AgentMemory

    # 3. 接入你的 Agent —— Agent 驱动（推荐方式，见下节「用 Agent 部署」）
    dsh plugin --profile web add dsh-unified-agent-memory   # + 配置 vaultPath/UNIFIED_MEMORY_VAULT

    # 4. 写一条、查一条
    memory submit "the staging server runs on 127.0.0.1:8080" --agent alpha
    memory search "staging server"

    # 5. 晋升到 canonical（默认人工确认）
    python -m unified_memory.promoter --review
    python -m unified_memory.promoter --apply

完整部署：docs/DEPLOY.md · 架构：docs/ARCHITECTURE.md · 安全：docs/SECURITY.md

## 用 Agent 部署（DSH 驱动 —— 推荐方式）

把各 Agent 接进共享记忆**不是复制粘贴**：每个 Agent 的全局指令文件格式与约定都不同，所以部署由 **Agent 亲自完成**。本项目是 DeepSeek Harness 插件，默认部署者就是 **DSH 自己**：

1. `dsh plugin --profile web add dsh-unified-agent-memory`
2. 下一个 DSH 会话里调用 `memory_status`——全新安装会打印部署提示，指向
   [docs/AGENT-DEPLOY.md](docs/AGENT-DEPLOY.md)。
3. 让 DSH 完整阅读该任务书并端到端执行：检查/创建 vault、安装 core，然后把共享记忆规则写入**每个**检测到的 Agent 的全局指令文件（`~/.dsh/AGENTS.md`、`~/.codex/AGENTS.md`、`~/.claude/CLAUDE.md` 及 Hermes 风格运行时的行为文件）——逐个定制、幂等、带备份、`selfcheck` 验证。

任务书自含（规则、逐 Agent 规格、写入规范、分步流程、验证清单、防坑），DSH 几乎不用提问，只在无法从环境推断时才确认几个部署决策：

| # | 决策 | 默认 |
|---|------|------|
| 1 | **主 Agent**（负责每日晋升 cron）是谁？ | 有 Hermes 则 Hermes，否则部署者自己 |
| 2 | 索引放**本机还是远端服务器**？ | 本机 |
| 3 | 晋升**人工确认还是全自动**？ | 人工确认 |
| 4 | 接入**哪些 Agent**（dsh / Codex / Claude / Hermes）？ | 检测到的全部 |

> 不用 DSH？通用 AI 编程 Agent 也能部署——把 [docs/AGENT-DEPLOY-PROMPT.md](docs/AGENT-DEPLOY-PROMPT.md) 里的 prompt 连同本仓库地址丢给任意 Agent，回答它问的 4 个问题即可。

## 仓库结构

| 路径 | 内容 |
|---|---|
| core/ | 零依赖 Python 包：memory.py（init/search/show/submit）、promoter.py（review/apply/adjudicate/repair-existing）、forgetter.py、conflict.py |
| vault-template/ | 可整体复制的 Obsidian vault：7 个 canonical 笔记 + 提交区 + 情境信息 + 记忆遗忘区 + 会话归档 |
| lib/ | dsh 插件：memory_search / memory_show / memory_submit / memory_status 工具 |
| integrations/ | AGENTS.md（Codex）、CLAUDE.md（Claude）、Hermes 可运行脚本（inject_context/daily_cron/archive_session）与 hooks 示例 |
| setup/ | setup.py（init/cron/selfcheck）、remote_index_server.py（零依赖远端索引服务） |
| docs/ | ARCHITECTURE / DEPLOY / SECURITY / AGENT-DEPLOY / AGENT-DEPLOY-PROMPT |

## 环境要求

- Python ≥ 3.10（core；仅标准库）
- Node.js ≥ 20 + dsh 0.1.0-rc.6（仅 dsh 插件需要）
- 推荐用 Obsidian 浏览 vault，但非必需——一切皆纯 Markdown + SQLite。

## 维护状态

- 维护者：[Noelune](https://github.com/Noelune)
- **社区维护**：接受 issue/PR，不承诺 SLA；缺陷修复通常 1–2 周内响应，安全漏洞优先。
- 兼容性：针对 **dsh 0.1.0-rc.6** 测试；dsh API 变动在 CHANGELOG.md 记录升级说明。
- 许可：**MIT**，允许商用。

## 安全

详见 docs/SECURITY.md。要点：vault 内容一律视为数据而非指令；明文凭据永不进 vault；默认索引不出本机；晋升人工确认 + 文件锁 + 原子写。

## 贡献

欢迎 PR。提交前请运行 python -m unittest discover -s core/tests（core）；CI 每次 push 自动跑 core 单测、gitleaks 密钥扫描与许可证检查。
