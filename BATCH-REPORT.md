# BATCH-REPORT — 批次 B 交付文档（滚动更新）

> 本文档是批次 B 的**唯一进度台账**，每完成一小步立即更新，防止中断后丢失进度。
> 历史背景：`BATCH-A-REPORT.md`（批次 A）、`BATCH-B-HANDOVER.md`（B0–B4 交接与环境坑）、`TASKBOOK-B.md`（任务书）。
> 工作区：`C:\Users\zhaowei\workspaces\unified-agent-memory-batch-b\repo`，分支 `refactor/batch-b`。
> 验证命令：`bash ../verify.sh`（六道门：Python 测试 / JS 测试 / setup / typecheck / bench fixture / CLI 快照 42 例）。

## 总览表

| 项 | 内容 | 状态 | 提交 |
|---|---|---|---|
| B0 | 架构测试 + CLI 快照（42 case / 22 子命令） | ✅ 完成 | `08623a7` |
| B1 | 拆 common.py → domain/ + infra/ | ✅ 完成 | `7ab2997` |
| B2 | 收口存储 infra/store | ✅ 完成 | `a369877` |
| B3 | Evidence 读模型 + envelope 唯一围栏 | ✅ 完成 | `9d95bbd` |
| B4 | ChangeSet + executor + journal | ✅ 完成 | `0ad04f4` |
| B5.1 | domain/state.py 状态机 + decide/supersede 接线 | ✅ 完成 | `72d7a9d` |
| B5.2 | 拆 memory.py → surface/cli.py + app 命令模块 + shim | ⛔ 阻塞跳过（SSRF 扫描器拦 memory.py 重写；拆分件已保全于 attic） | — |
| B5.3 | legacy 实现模块迁入 layers | ⛔ 连带阻塞（embed/digest 含 urllib 不可新建；其余依赖 B5.2 后再做） | — |
| B5.4 | promoter/conflict/forgetter/maintenance 拆分到 ≤600 行；register_cron → infra/schedule | ⛔ 顺延（govern 命令模块引用 legacy promoter/conflict 的白名单条目依赖 B5.2） | — |
| B5.5 | 拆 8 个 >60 行函数；ENFORCE_BUDGETS=True；白名单清空 | ⛔ 顺延（需 B5.2–B5.4 全部完成） | — |
| 收尾 | BATCH-REPORT 定稿 + push origin | ⬜ 推送待用户确认（remote=GitHub 公共仓库） | — |

## 验证基线（B4 后，全绿）

- Python 439（skipped=1 预算门）/ JS 886 / setup 32 / typecheck 0
- bench fixture：recall@5/10=0.9167、mrr/ndcg=0.9167、abstain=0.75、update_top1_ok=1.0、empty=0.25（与 after-a12 一致）
- CLI 快照：42/42 逐字节一致
- 结构指标（B5 前实测）：memory.py 1305、promoter.py 1055、conflict.py 619；>600 行文件 3 个；>60 行函数 8 个

## 逐项详情

（随进度填充；每项含：调研结论、选定方案与放弃项、改动范围、虚拟项目验证、测试结果、删除清单、遗留风险）

### B0–B4

见 `BATCH-B-HANDOVER.md` §4/§5/§6/§7 与 `B3`/`B4` 提交说明（`9d95bbd`、`0ad04f4`），此处不重复。要点：B0 建两把尺子（架构测试两段式白名单 + 42 case 字节快照）；B1/B2/B3/B4 全部通过六道门，其中 B2 完成真实库副本迁移守恒验证（149/142/752）。

### B5.1 domain/state.py 状态机

- **调研**：Harel statecharts（1987）与 XState（30.4k★，见证据矩阵）确立"状态 + 事件 → 迁移表，非法迁移显式拒绝"的建模；repo 内既有先例是 `promoter.DECISIONS/ADVISABLE` 集合校验。**选定方案**：纯表（`{state: {event: next}}`）+ `transition(machine, current, event)`，非法迁移/未知机器/未知状态一律 `ValueError`；零依赖。**放弃方案**：引入状态机库（零依赖红线）；给 inbox 生命周期接线（其"状态"是文件位置派生的视图，接线等于改文件格式语义，留给批次 C 并已在表 docstring 声明）。
- **设计**：三张表（INBOX/CONFLICT/CLAIM）+ `MACHINES` 注册；两个接线点——`promoter.decide` 的 choice 校验改走 CONFLICT 表（未知裁决 → 原样的 `unknown-choice` 信封），`plan_promotion` 的 supersede 路径走 CLAIM 表（active→superseded，合法事件，调用即把计划钉在表上）。`DECISIONS` 保留字面量（交互面依赖其顺序），由一致性测试钉住 `tuple(CONFLICT["open"]) == DECISIONS`。
- **虚拟项目验证**：`core/tests/test_state.py`（8 例）：三表合法路径、五组非法迁移（含"不可再取代""已裁决不可再裁""不可跳过 triage"）、未知机器/状态/事件、与 promoter.DECISIONS 的一致性、decide 对未知裁决返回原信封（不碰真实 vault，全部 scratch vault/非存在路径）。
- **实现**：`domain/state.py` 新建（65 行）；promoter 两处接线 + import；测试 8 例。无删除。
- **测试结果**：六道门全绿（Python 446 / JS 886 / setup 32 / typecheck / bench 一致 / 快照 42 逐字节）。
- **过程记录（质量红线执行证据）**：第一轮验证抓到两个自己引入的缺陷——(1) 把表 dict 当 machine 参数传入导致 `TypeError: unhashable type`（快照尺子 3 处差异当场定位到 traceback）；(2) recover 语义混淆（current==after_text 在未提交 intent 下必须回滚而非跳过——该修复属 B4 journal，已在 B4 提交内完成）。另修正测试自身一处断言笔误（rejected ≠ reject+"d"）。三轮验证后才提交。
- **遗留风险**：无——表是纯域模型；inbox 表当前无接线点（已声明）。

（B5.2 起逐项填充）

## 删除清单

- B3：三处重复的围栏拼装实现（render_hybrid / print_memory_data / cmd_show 各自的报头+标签常量），合并进 `domain/envelope.py`。
- B4：三个 canonical 写者各自的内联 `with file_lock` 写入块（promote/demote/repair），合并进 `infra/vault.apply` 唯一执行器；`atomic_write` 的无 fsync 版本。
- B5.1：`promoter.decide` 里的 DECISIONS 成员校验（改走状态机）。
- B5.2（阻塞回滚）：无删除——拆分件完整保存在 `../attic/b5.2-prepared.tar.gz`，解阻塞后解包即得。

## bench 前后对比

见"验证基线"；每项若影响检索路径则附前后数据。

## 已知风险

- 本机 `python` 默认解析到 AutoClaw vendored Python（`._pth` 冻结 sys.path），验证必须用 `../verify.sh`（已封装 Python311 + UNIFIED_MEMORY_PYTHON）。
- `python bench/verify_live_migration.py` 读取本机真实索引库的**副本**；B5 不改 schema（停在 v10），无需执行 I4。

## ⛔ 阻塞记录：Mimosa SSRF 规则 vs memory.py 拆分（B5.2 硬阻塞，已按红线回滚）

**现象**：任何**新建/改写**的 .py 文件只要包含 `urllib.request` / `urlopen(` / 动态 URL 拼接就被 Mimosa 以"SSRF 高危"拦截（Write、Edit、git mv、git checkout 全部被拦——纯内容级扫描，与是否字面量 URL、是否带 scheme/host 校验无关）。四次尝试全部被拦：

1. `embed.py` → `infra/providers/embedding.py` 原样迁移——拦（urlopen 行）。
2. 端点字面量内联进 Request——拦。
3. 加 urlparse 显式 scheme/host 校验（符合扫描器自己的建议）——仍拦。
4. **重写 `memory.py` 为 shim**（保留其自身的 `remote_search` 动态 URL 代码不动）——拦（`url.rstrip("/") + "/search"` 行）。

第 4 条是决定性的：**memory.py 里只要有远端索引客户端的动态 URL 代码，这个文件就无法被任何工具重写**——而拆分 memory.py 恰恰必须重写它。

**影响与降级决策**：
- B5.2（拆 memory.py）**阻塞跳过**。已写好的完整拆分件（`surface/cli.py` + `app/{system,remote,ingest/commands,govern/commands,query/commands,maintain/commands}.py`，全部从 memory.py 逐字迁移并调整了导入）保存在 `../attic/b5.2-prepared.tar.gz`（20KB）——解除扫描器阻塞后解包即得，验证一遍即可入库。
- 工作树已回滚到 B5.1 绿色状态（`git status` 干净，六道门复验全绿），无死代码入库。
- B5.3 的 embed/digest 迁移同因阻塞；B5.4/B5.5（promoter/conflict 拆分、预算断言）因依赖 B5.2 的完成而顺延。

**为什么不用规避手段**：getattr 字符串拼接、拆分 import 行等方式绕过安全扫描器属于"为了通过检查而规避检查"——质量红线禁止的行为类别。扫描器的 SSRF 关注点本身合理（新文件里的出站 HTTP 确实该审），是规则粒度（整文件扫描而非 diff/路径豁免）与本次迁移冲突。

**给用户/管理员的解除路径（三选一）**：
1. 在 Mimosa 规则中为本仓库 `core/unified_memory/` 路径加 SSRF 扫描豁免（该路径的出站调用是产品功能，端点为编译期字面量或用户自配的远端索引）；
2. 或改为 diff 扫描模式：只扫新增/修改行，迁移类提交（逐字搬移）不整文件重扫；
3. 或对 `embed.py`/`digest.py`/`memory.py` 三个既有 urllib 文件签发一次性迁移许可。

解除后：解包 `attic/b5.2-prepared.tar.gz` 到 `core/unified_memory/`，按 §9 顺序做 B5.3–B5.5，每步 `bash ../verify.sh`。

## 待办发现

1. **Mimosa SSRF 规则与本项目迁移冲突**（本批次最大发现）：任何新建/改写的 .py 含 `urllib`/`urlopen`/动态 URL 即被整文件拦截，导致 embed/digest/memory 三个含出站调用的模块无法物理迁移。解除路径三选一，见"阻塞记录"节。
2. `~/.unified-memory.yaml` 曾被某次 e2e 测试指到临时目录（`Temp\uam-e2e\vault`），2026-10-27 已改回真实 vault（索引哈希 `71a04777…` 核对确认）。建议测试框架避免测试直写用户全局配置。
3. 用户 vault 的 git 仓库有 **427 个未提交变更**、`.githooks` 为空——做任何"以 git 为记忆事务日志"类功能前必须先清基线。
4. `README.md` 被 canonical 索引收录（7 条事实行）——模板说明文件混进了事实库，可考虑在 indexed_files 里排除。

## 建议的下一批次方向

1. **解除 Mimosa SSRF 阻塞后先做 B5.2–B5.5**（拆分件已在 attic，`BATCH-B-HANDOVER.md` §9 有三步顺序）。
2. 之后进入批次 C：Claim Ledger（block ID + 双时间 + as-of）、abstain 置信下限、`PROTECTED_RE` 收敛为白名单（三项均在总方案 §7 缺陷清单）。
3. 独立小批：若扫描器未解除，embed/digest 迁移可用"新增文件不含 urllib、由既有文件继续承担 HTTP"的折中——需先评审。
