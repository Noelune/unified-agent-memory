# 首次运行与多 Agent 铺路设计（A+B+C 范围）

- 日期：2026-10-19
- 状态：待评审
- 仓库：`dsh-unified-agent-memory` v0.8.0
- 前置提交：`c44c6ab`（提交前缀改为可配置，已修未推送）

## 1. 背景与问题

插件装完后，用户拿到的是 node_modules 里的一堆文件。要让记忆系统真正工作，还需要：一个 vault、一份指向它的配置、各 Agent 的全局指令段落、以及可选的每日晋升定时任务。现在这些都靠人读 `docs/AGENT-DEPLOY.md` 手工完成。

三个具体缺口：

1. **产物已在包里，但没人执行**。`npm pack --dry-run` 实测 100 files / 325 kB，含 `vault-template/`（12 文件）、`setup/*.py`（5）、`docs/AGENT-DEPLOY.md`、`integrations/{codex,claude,hermes}`、`core/` 全套。用户"还要去下 Obsidian Vault"是误解；缺的是执行者。
2. **配置只解析一次**。`apply()` 里 `resolveConfig(config)` 调用一次（`src/index.ts:143`），此后 `memory init` 即便写好 `~/.unified-memory.yaml`，本次会话仍认为未配置。
3. **同一 vault 上的多运行时无法区分**。已在 `c44c6ab` 修好前缀派生，但没有"谁是谁"的登记，且 `setup/deploy.py` 的前缀是另一份实现，会漂移。

另外两处既有矛盾：

- `docs/AGENT-EXPERIENCE.md` 写"npm-only 安装不含 setup 脚本"，与 `package.json` 的 `files` 直接冲突。
- 打包把 `docs/superpowers/**`（约 140 kB 内部 plan/spec/HTML 证据）也发了出去。

## 2. 目标与非目标

**目标**

1. 装完插件，第一次使用时：用户看到一句简短说明 → 同意 → 系统自动建好 vault、写好配置、给检测到的其它 Agent 铺好指令段落，全程幂等可回滚。
2. 不同意时有明确的降级路径，绝不静默写用户磁盘。
3. 一个插件装完，本机多个 Agent 能真正共享同一份记忆（含不需要该插件的 Codex / Claude / Hermes）。
4. 每份提交都能追出是哪个运行时写的。

**非目标**

- 不引入服务端、不做账号体系、不联网。
- 不改 canonical 笔记的单一写者（仍是 Hermes + 晋升 cron）。
- 不在本轮做自造 modal 弹窗 UI（侧边栏只显示状态卡片）。
- 不改动历史 `dsh-*` 文件命名。

## 3. 平台约束（决定方案形状，不可绕过）

来自 `@deepseek-ai/dsh-user-approval` 的实际契约：

- 授权请求**必须在进行中的回合内**发出，回合外调用会先抛错、不写审计。→ 加载时无回合，**平台没有 load-time modal**，弹窗只能发生在首次工具调用时。
- 只有一次性授权（`allowed-once` / `rejected` / `cancelled` / `unavailable`），**没有"永久允许"、没有授权存储**。→ "已同意"必须由插件自己持久化。
- 无 answerer（headless、未组合）时解析为 `unavailable`，服务本身从不弹窗。→ 必须 fail-closed 并给出可复制的计划文本。
- 请求只带工具名、原因文本、可选 callId，**不带工具参数**。→ 弹窗正文必须把关键信息压进 `reason` / `displayReason`。

实现注记（已核对代码）：

- `src/index.ts:75` 的 `inject` 是**硬依赖列表**，缺服务会导致整个插件加载失败。因此 `approval` **不得**加入该列表，改用 `ctx.inject(['approval'], …)` 可选挂载：服务出现时把 `ctx.approval` 存进闭包变量，消失时清空。服务不在时插件照常工作，`memory_setup` 只返回计划。
- 宿主可能全局关闭审批提示（本机当前会话即如此：`Approval prompts are disabled`）。此时请求直接解析为 `unavailable`。→ **`unavailable` 是一等公民路径，不是边缘情况**：第一次调用只返回计划文本，Agent 必须在用户明确同意后带 `apply: true` 再调一次才会落盘。

## 4. 同意模型

### 4.1 触发点

| 时机 | 行为 |
|---|---|
| 插件加载 | 不写盘、不弹窗；仅注册工具与路由。 |
| 首次调用 `memory_status` | 只读，返回"未初始化 + 需要时会做什么"的摘要，不发起授权。 |
| 首次调用 `memory_setup` | 在回合内发起授权请求，这就是用户看到的"弹窗"。 |

### 4.2 弹窗正文（压进 reason，四行以内）

```
将在 <vaultPath> 创建记忆库（若该路径已有 vault 则复用，不覆盖）
将写入这些文件的托管段落（带备份、可回滚）：<detected targets>
将写 ~/.unified-memory.yaml 指向该 vault，并生成 memory 命令包装器
全程本地：不上传、不联网、不改凭据
```

### 4.3 结果处理

| outcome | 行为 |
|---|---|
| `allowed-once` | 执行引导，完成后写 `~/.unified-memory/onboarding.json` |
| `rejected` | 不写任何文件，返回"已取消，你想改主意随时再让我初始化" |
| `cancelled` | 同 `rejected`，文案区分"已取消" |
| `unavailable` | 不猜：返回完整计划 + 明确指示"传 apply: true 才会执行" |

### 4.4 已同意状态的持久化

`~/.unified-memory/onboarding.json`：

```json
{
  "version": 1,
  "consent": "granted",
  "grantedAt": "2026-10-19T00:12:00+08:00",
  "vaultPath": "C:\\Users\\<you>\\UnifiedAgentMemory",
  "scope": ["vault", "config", "instructions", "shim"],
  "targets": ["~/.dsh/AGENTS.md", "~/.codex/AGENTS.md"]
}
```

复用条件：`vaultPath` 与 `scope` 均未变 → 跳过授权直接执行（可重入）。任一变化（换 vault、加新 Agent 目标）→ 重新询问。

## 5. 引导流程（happy path）

前置条件：本次调用已取得授权（4.3 的 `allowed-once`），或调用方显式传了 `apply: true`。**不满足时只返回计划，不执行下面任何一步。**

1. 解析 vault 路径：`memory_setup` 参数 `vaultPath` → `UNIFIED_MEMORY_VAULT` → `~/.unified-memory.yaml` 的 `vault:` → 默认 `~/UnifiedAgentMemory`。
2. 取授权（见 4.3）。
3. `python -m unified_memory.memory init --vault <p>`（`core/unified_memory/memory.py:126 init_vault()`，已有实现：`copytree(vault-template/50-Agent-Context)`，模板缺失时回退内置 `TEMPLATE_FILES`，目标已存在时带备份、受 `force` 控制）。
4. `Object.assign(cfg, resolveConfig(reloadConfig))` → 本次会话立即生效（解决缺口 2）。
5. 对检测到的 Agent 执行 `python setup/deploy.py apply --home <home> --agent <a> --vault <p>`：只写 `<!-- unified-agent-memory:begin/end -->` 标记段，幂等、带时间戳备份、支持 `rollback`（现有测试覆盖）。
6. 生成 CLI 包装器（见 6.2）。
7. 写 `Agent提交区/前缀登记.md`（见 6.3）。
8. `python setup/selfcheck.py` 校验，返回结构化报告：vault 路径、已写文件、跳过原因、后续可选项（cron）。

`cron` 只在显式 `cron: true` 时注册（调研结论：定时任务必须是 opt-in）。

## 6. 多 Agent 共享（一个插件带动全机）

### 6.1 指令段落

只对**检测到存在**的目标写入。`setup/deploy.py` 的 `AGENT_TARGETS` 目前只有三个：`dsh`(`.dsh/AGENTS.md`)、`codex`(`.codex/AGENTS.md`)、`claude`(`.claude/CLAUDE.md`)。未检测到的不创建目录、不臆造路径。

Hermes 不在该表白名单内（其行为由 SOUL/skills 承载，不是 `AGENTS.md` 形态），本轮**不为 Hermes 写指令段**，它通过 6.2 的 shim + 6.3 的登记表接入。扩展 Hermes 目标需另开一轮改 `deploy.py`。

每个段落写明：读 canonical、写提交区、自己前缀是哪个、canonical 只由主 Agent 晋升、凭据不入库。

### 6.2 稳定 CLI 包装器

没有 dsh 插件的 Agent 需要一个不依赖 `pip install` 的入口：

- 位置：`~/.unified-memory/bin/memory.cmd`（Windows）与 `~/.unified-memory/bin/memory`（POSIX）。
- 内容：设置 `PYTHONPATH=<插件 core 绝对路径>` 后转发 `python -m unified_memory.memory "$@"`。
- 已知上限：路径绑死当前安装位置；插件被移动到新 profile 后需重跑 `memory_setup` 刷新（`ponytail:` 标注，升级路径是让 shim 读取 `onboarding.json` 里的 corePath）。
- 幂等：内容相同则不动，不同则覆盖并回报。

### 6.3 前缀登记表

`<vault>/50-Agent-Context/Agent提交区/前缀登记.md`，由 `memory_setup` 生成（属提交区，允许 Agent 写）：

| 前缀 | 运行时 | 说明 |
|---|---|---|
| `dsh-desktop-` | dsh 桌面端 | `DSH_PROFILE=desktop` |
| `dsh-web-` | dsh 浏览器端 | `DSH_PROFILE=web` |
| `codex-` / `claude-` / `hermes-` | 其它 Agent | 各自指令段落内约定 |
| `dsh-` | 历史遗留 | 早于本方案的合并前缀，不改名 |

表内同时登记本机标识与 vault 路径，任何 Agent 进库先读这张表。

## 7. 身份与前缀（单一契约）

解析顺序不变：`config.agentName` → `UNIFIED_MEMORY_AGENT` → `dsh-<DSH_PROFILE>` → `dsh`。

为消除"静默默认"（调研中 mem0 的 null、CrewAI 的 LLM 推测都是被点名的反面教材），新增**可见性**而不是改变行为：

- `memory_status` 与 `/status` 载荷新增 `agentName` 与 `agentSource`（`config` / `env` / `profile` / `fallback`）。
- TS 端算好后以 `UNIFIED_MEMORY_AGENT` 传给 `deploy.py`；Python 端**不再自行推导**，缺失时报出并回落 `dsh`。两处实现由此变成一份契约 + 两条断言测试。

## 8. 接口变更

### 8.1 新工具 `memory_setup`

```
参数：
  vaultPath?: string     目标 vault（绝对路径）
  apply?: boolean        省略时只返回计划；true 才落盘（headless/拒绝授权时的显式通道）
  agents?: string[]      限定要铺路的 Agent，取值 dsh|codex|claude（默认自动检测）
  cron?: boolean         是否注册每日晋升（默认 false）
输出：{ ok, output }    人类可读报告 + 结构化明细
```

绝不写 canonical 笔记；绝不触碰凭据。

### 8.2 状态载荷

`buildStatusPayload` 增加 `agentName`、`agentSource`、`onboarding: { state: 'pending' | 'granted', vaultPath }`。JSON 契约文档同步更新。

`agentSource` 取值：`config`（显式配了 `agentName`）、`env`（`UNIFIED_MEMORY_AGENT`）、`profile`（`dsh-<DSH_PROFILE>`）、`fallback`（无 `DSH_PROFILE`，回落为 `dsh`，仅历史兼容）。

**拒绝不落盘**：`rejected` / `cancelled` 不写 `onboarding.json`，因此状态仍是 `pending`——"拒绝"是一次会话内的事实，不是持久状态，否则"拒绝后不写任何文件"就不成立。

### 8.3 既有工具

`memory_search` / `memory_show` / `memory_submit` / `memory_preview` 签名不变；`notConfigured()` 文案改为引导调用 `memory_setup`。

## 9. 错误处理

| 情况 | 行为 |
|---|---|
| Python 不可用 | 返回安装指引（已有 `kind: 'missing'` 路径），不写盘 |
| vault 路径不可写 | 报告具体路径与错误，降级到"自带 vault"建议，不留半成品 |
| 目标指令文件被锁/校验失败 | 停止，保留备份，明确提示已回滚 |
| `deploy.py` 不存在（只装了 SDK 的极端情况） | 报告"包不完整"并给出手工命令，不静默跳过 |
| 授权不可用 | 见 4.3 |

## 10. 打包与文档修正

- `.npmignore` 排除 `docs/superpowers/**`（内部 plan/spec/HTML 证据，非用户文档）。
- `docs/AGENT-EXPERIENCE.md` 修正"npm-only 不含 setup 脚本"的错误陈述。
- README 增补"装完插件后的首次运行"一节（含三条降级路径与 `apply: true` 的 headless 用法）。
- CHANGELOG 增补 Unreleased 段。

## 11. 测试策略

1. **单元（vitest）**：`buildSetupArgv`（纯函数）、vault 路径解析优先级、consent 计划文本生成、`onboarding.json` 复用/失效判定、`agentSource` 判定。
2. **契约（vitest）**：`memory_setup` 在四种授权结果下的分支（用注入的假 approval 替身，不启动 harness）。
3. **构建产物（node:test）**：`lib/` 中 `memory_setup` 已注册、`/status` 载荷含新字段。
4. **Python（unittest）**：`deploy.py` 在 `UNIFIED_MEMORY_AGENT` 存在/缺失时生成的前缀段落。
5. **端到端（临时目录）**：临时 vault 上跑一次 `memory init` + `selfcheck`，断言文件名前缀、登记表存在、shim 内容正确，跑完清理。

## 12. 验收标准

- [ ] 全新安装（无 vault、无配置）后，`memory_setup` 一次调用即得到可用系统；重复调用不再写任何东西。
- [ ] 拒绝授权后，`find` 不到任何新增文件。
- [ ] headless 下 `memory_setup` 返回计划且不发授权请求；加 `apply: true` 可执行。
- [ ] 桌面端与浏览器端各写一条，文件名前缀分别为 `dsh-desktop-` / `dsh-web-`，`memory_status` 的 `agentSource` 分别为 `profile`。
- [ ] `~/.codex/AGENTS.md`、`~/.claude/CLAUDE.md` 各出现一个标记段，重复执行不追加第二段。
- [ ] `memory search` 在 Codex 侧通过 shim 可用。
- [ ] `npm run check` 全绿（sync:check 的推送门禁除外，需用户确认）。
