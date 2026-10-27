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
| B5.1 | domain/state.py 状态机 + decide/supersede 接线 | 🔜 进行中 | — |
| B5.2 | 拆 memory.py → surface/cli.py + app 命令模块 + shim | ⬜ 未开始 | — |
| B5.3 | legacy 实现模块逐个迁入 layers（preview/stats/inbox/digest/health/drift/sessiondb/catchup/graph/embed/search） | ⬜ 未开始 | — |
| B5.4 | promoter/conflict/forgetter/maintenance 拆分到 ≤600 行；register_cron → infra/schedule | ⬜ 未开始 | — |
| B5.5 | 拆 8 个 >60 行函数；ENFORCE_BUDGETS=True；白名单清空 | ⬜ 未开始 | — |
| 收尾 | BATCH-REPORT 定稿 + push origin | ⬜ 未开始 | — |

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

- 调研：Harel statecharts（1987）与 XState（30.4k★，见证据矩阵）确立"状态 + 事件 → 迁移表，非法迁移显式拒绝"的建模；repo 内既有先例是 `promoter.DECISIONS/ADVISABLE` 集合校验。选定方案：纯表 + `transition(table, current, event)`，非法迁移抛 `ValueError`；放弃方案：不引入有限状态机库（零依赖红线）、不改任何文件格式（快照锁字节）。
- 接线点：`promoter.decide` 的 choice 校验改走 CONFLICT 迁移表（行为等价：DECISIONS 集合 = 表中 open 态的合法事件）；`plan_promotion` 的 supersede 路径走 CLAIM 表（active→superseded）。
- 验证：新增 `core/tests/test_state.py`（三表合法/非法迁移）；全六道门。

（B5.2 起逐项填充）

## 删除清单

（随进度填充）

## bench 前后对比

见"验证基线"；每项若影响检索路径则附前后数据。

## 已知风险

- 本机 `python` 默认解析到 AutoClaw vendored Python（`._pth` 冻结 sys.path），验证必须用 `../verify.sh`（已封装 Python311 + UNIFIED_MEMORY_PYTHON）。
- `python bench/verify_live_migration.py` 读取本机真实索引库的**副本**；B5 不改 schema（停在 v10），无需执行 I4。

## 待办发现

（随进度填充）

## 建议的下一批次方向

（收尾时填充）
