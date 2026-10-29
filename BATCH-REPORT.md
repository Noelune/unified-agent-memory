# BATCH-REPORT — 批次 B 交付文档（滚动更新）

> 本文档是批次 B 的**唯一进度台账**，每完成一小步立即更新，防止中断后丢失进度。
>   
> 历史背景：`BATCH-A-REPORT.md`（批次 A）、`BATCH-B-HANDOVER.md`（B0–B4 交接与环境坑）、`TASKBOOK-B.md`（任务书）。
>   
> 工作区：`C:\Users\zhaowei\workspaces\unified-agent-memory-batch-b\repo`，分支 `refactor/batch-b`。
>   
> 验证命令：`bash ../verify.sh`（七道门：Python 测试 / JS 测试 / setup / typecheck / bench fixture / CLI 快照 42 例 / e2e 46 项）。

## 总览表

| 项    | 内容                                                                                | 状态                            | 提交                            |
| ---- | --------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- |
| B0   | 架构测试 + CLI 快照（42 case / 22 子命令）                                                   | ✅ 完成                          | `08623a7`                     |
| B1   | 拆 common.py → domain/ + infra/                                                    | ✅ 完成                          | `7ab2997`                     |
| B2   | 收口存储 infra/store                                                                  | ✅ 完成                          | `a369877`                     |
| B3   | Evidence 读模型 + envelope 唯一围栏                                                      | ✅ 完成                          | `9d95bbd`                     |
| B4   | ChangeSet + executor + journal                                                    | ✅ 完成                          | `0ad04f4`                     |
| B5.1 | domain/state.py 状态机 + decide/supersede 接线                                         | ✅ 完成                          | `72d7a9d`                     |
| B5.2 | 拆 memory.py → surface/cli.py + app 命令模块 + 119 行 shim                              | ✅ 完成（阻塞已解除，2026-10-29）        | `d247aa1`                     |
| B5.3 | legacy 实现模块迁入 layers（drift/digest/preview/stats/health/inbox 六件）                    | ✅ 完成（2026-10-29）              | `9f1fad2`、`3e38f78`、`699745a` |
| B5.4 | promoter/conflict/forgetter/maintenance 拆分；register_cron → infra/schedule            | ✅ 完成（分 a/b/c 三步，2026-10-29）    | `e5bd84c`、`8289874`、`e5fb47e` |
| B5.5 | 拆 12 个 >60 行函数 + claims 的 24 个 def；白名单清空；ENFORCE_BUDGETS=True                        | ⬜ 待做（接手说明见下，状态已实测）            | —                             |
| 维护轮  | 全量测试 + 测试隔离修复（journal / decide 集成 / bench）+ 真实 home 清理 + 46 项真功能 e2e（发现并修掉远端两处缺陷） | ✅ 完成（2026-10-29）              | `4a1a50a`、`c2de07c`、`00050f4` |
| 收尾   | BATCH-REPORT 定稿 + push origin                                                     | ⬜ 推送待用户确认（remote=GitHub 公共仓库） | —                             |

## 验证基线（B5.4c 后，全绿，2026-10-29 22:20 实测）

- Python **468**（skipped=1 预算门）/ JS 886（41 文件）/ setup 32 / node 24 / typecheck 0
- `bash ../verify.sh` 七道门全绿：Python / JS / setup / typecheck / bench fixture / CLI 快照 42 例逐字节 / e2e 46 项
- `npm run check` 全链退出 0（typecheck → drift:check → sync:check → vitest → python → setup → build → node test → drift:python）
- bench fixture：recall@5/10=0.9167、mrr/ndcg=0.9167、abstain=0.75、update_top1_ok=1.0、empty=0.25（与 after-a12 一致，B5.2–B5.4 未触碰检索路径）
- CLI 快照：42/42 逐字节一致；真实库副本迁移 164 memories / 130 embeddings / 752 access_log 守恒
- 隔离：Python 套件、vitest、bench 跑完后 `~/.unified-memory/` **零新增文件**
- 结构指标（B5.4c 后实测，67 个模块 / 10235 行）：**>600 行文件 0 个**（拆分前 2 个：promoter 1055、conflict 619）；>450 软限 1 个（`infra/store/search_index.py` 470）；memory.py 119、promoter.py shim 103、conflict.py shim 55、maintenance.py shim 17
- 剩余预算债：**12 个 >60 行函数 + 1 个 >20 def 文件**（清单见「B5.5 接手说明」）

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

### 维护轮（2026-10-29）：全量测试 + 测试隔离修复 + 真实 home 清理

- **起因**：用户要求"完整跑所有能跑的测试，全绿"。七道门里前六道本来就绿，但复跑时发现**绿了却在污染本机真实 home**——测试隔离漏了第三个出口。
- **全量矩阵（实测）**：Python 455 / JS 886（41 文件）/ setup 32 / node 24 / typecheck 0 / build 成功 / drift 双侧通过 / sync 通过 / 打包审计 146 entries / bench 与 after-a12 逐字段一致 / CLI 快照 42 例逐字节 / 真实库副本迁移 164·130·752 守恒 / figures-smoke 全 PASS / 8 个模块入口 `--help` 全 OK / **托管 Python 3.13.12 跑核心套件同样 455 OK** / Python 与 JS 套件各跑两轮结果一致（无偶发）。
- **修复 1（journal 泄漏）**：`infra/journal.py` 的 `JOURNAL_BASE` 是模块级常量，`test_common._arm_guard()` 只钉了 `CONFIG_PATH` 与 `INDEX_DB`，于是每个 promoting 测试往真实 `~/.unified-memory/journal/` 追加一个 jsonl（单日 183 个）。修复 = 新增 `UNIFIED_MEMORY_JOURNAL_DIR`（子进程可继承，与 `UNIFIED_MEMORY_INDEX_DB` 同构，默认路径不变）+ 守卫 rebind 全局并设 env + `assert_guard_intact()` 纳入检查 + 回归测试 `test_journal_is_never_written_under_the_real_home`（Python 454 → 455）。
- **修复 2（decide 集成测试泄漏）**：`test/route-decide-integration.test.ts` 的 `runCore` 继承真实 `process.env`，每次生成一个真实 `index-<hash>.db`。修复 = `beforeAll` 把 `UNIFIED_MEMORY_INDEX_DB` / `UNIFIED_MEMORY_JOURNAL_DIR` 指到 per-file 临时目录，`afterAll` 还原原值。
- **修复 3（bench 泄漏）**：`bench/run.py` 只把 vault 复制到 temp，`memory.INDEX_DB` 仍是真实默认值，于是每次 `--fixture-only`（verify.sh 第 5 道门）生成一个索引库。修复 = 新增 `_pin_state()`，fixture / real / latency 三趟各用独立临时索引库与 journal 目录；指标不变。
- **附带**：`scripts/figures-smoke.mjs` 自述"辅助文件已 gitignore"但实际没有，已补两条规则，跑 smoke 不再弄脏工作树。
- **验证方法学（踩坑，写下来给下一位）**：判断"是否污染真实 home"**不能用 mtime**——本机 dsh 插件常驻，会持续写自己的 `index-71a04777…db`，按时间戳会大量误报；正确做法是比对**文件名集合差**。`stat -c %Y` 只有秒精度会漏同一秒内的变化，要用 `%y`（纳秒）。
- **清理执行**：`~/.unified-memory/journal/` 487 个 jsonl（816 KB，全部指向 `%TEMP%\um-test-*`）+ `index-*.db` 44 个（0 记忆、仅一条 `decide:` 测试审计行，5.1 MB）**移入** `~/.unified-memory/_cleanup-backup-20261029-014758/`（531 文件 / 5.94 MB），不是直接删除，可整体还原。清理后 62 个库全部 `memories > 0`，真实库 164/130/752 完好；清理脚本 `../cleanup_home_artifacts.py`（判据：journal 的 change doc 必须落在 temp；db 必须 memories/embeddings/access_log 全 0 且 audit 仅 `decide:`）。
- **测试结果**：清理后七道门 + `npm run check` 复验全绿，`~/.unified-memory/` 零新增。

#### 真实功能测试（e2e，46 项断言，`../e2e_all_features.py`）

用户追问"是否做了所有功能的现实测试"后补做：不是快照比对，而是**真子进程 + 真文件 + 真 HTTP**，逐项断言效果（文件内容变了、事实能搜到、队列清空、哈希链验过、拒绝理由对）。

- **覆盖**：22 个 CLI 子命令（init/use/submit/note/preview×4/accept/dismiss/decide/advise/search/show/cite/status/sync/graph/stats/doctor/gc/audit/drift/embed/digest）+ 8 个入口（promoter 的 review/apply/auto/repair-existing、forgetter 的 dry-run/apply、catchup --check、sessiondb 的 status/show/export）。
- **新增能力的现实路径**：B3 的 `<memory-data>` 围栏（文本输出恰好一个）、B4 的 journal（写入落在 `UNIFIED_MEMORY_JOURNAL_DIR` 且记录真实 vault 路径）、B5.1 的 supersede 状态机（"已改为"把旧值移入 `## 已取代`）、远端检索走真实 loopback HTTP。
- **边界行为**：`accept --json` 业务拒绝退出 0 且 `data.reason="conflicts"`（有代码注释说明，是为了让宿主能读到原因）；`embed` 无密钥退出 1；`digest` 无密钥退出 0 并报 0 archive。
- **隔离自证**：整套跑完，`~/.unified-memory.yaml` 指纹不变、`~/.unified-memory/` 零新增。

**由真实测试发现的两个产品缺陷（已修，`00050f4`）**——单元测试与快照都没抓到：

1. **远端检索丢失引用 id**：`setup/remote_index_server.py` 对每个字符串字段都跑 `redact()`，64 位十六进制 id 命中 `HEX_SECRET` 规则变成 `<REDACTED_HEX_SECRET>`，所有远端结果渲染成 `[<REDACTED_] …`，模型回传的引用永远无法解析。修复 = 只脱敏内容字段，`id`/`doc` 原样通过（内容仍然脱敏，凭据测试照旧绿）。
2. **`search --remote --json` 忽略 `--json`**：remote 分支无条件走人类围栏文本，是唯一不遵守自身 JSON 契约的检索模式。修复 = 与 local/hybrid 同构输出 `{"mode":"remote"|"local", "count", "results"}`。

- 回归测试两条（`test_remote_search`：文本保留 10 位引用、JSON 携带 64 位 id 且 mode=remote），Python 455 → 457。

**仍未做真实验证的路径（如实记录）**：① SiliconFlow 向量与 LLM digest 的真实网络调用（无密钥，只验了降级路径）；② `--cron` / `--cron` 注册（会在本机 `schtasks` 建真实计划任务，属系统级副作用，未执行）；③ dsh 桌面端 UI 的真实浏览器渲染（只有契约测试 + 无 DOM 的组件 smoke）；④ 跨机远端（只跑 loopback）；⑤ 真实 vault 的写操作（按硬约束只用副本，迁移验证在副本上做）。

### B5.2 拆 memory.py → surface/cli.py + app/* 命令模块

- **调研**：`attic/b5.2-prepared.tar.gz` 里的拆分件（1395 行）是阻塞前准备的，**从未被执行过**。逐模块核对导入面后发现四类问题：① 四个子包命令模块的相对导入少一层（`..domain` → 应为 `...domain`，`from . import preview` 指向了 `app.ingest`）；② `emit_json` 与 `remote_config` 的落点与拆分件假设不一致（前者需进 `infra.console`，后者已在 `app.remote`）；③ 拆分件复制的是 `00050f4` 之前的 `cmd_search`，远端 `--json` 修复丢失；④ `CONFIG_PATH` 被写成模块级快照，`rebind` 失效。**选定方案**：修拆分件而不是重写——它已经是逐字迁移，问题都在导入与注入点。**放弃方案**：从 `memory.py` 重新拆一遍（会丢已有 docstring 与注释，且无收益）。
- **设计**：`surface/cli.py` 只留 grammar + dispatch + `plain_reason`（232 行）；命令体按域落 `app/{system,query,ingest,govern,maintain}/`；`memory.py` 收成 119 行 shim，**按任务要求原位保留** `INDEX_DB`（`infra.store.schema` 经 `sys.modules` 读、测试 rebind）与 `remote_search`（HTTP 客户端）。回滚方式：`git revert d247aa1`（纯搬迁，无数据格式变化）。
- **虚拟项目验证**：`e2e_all_features.py` 46 项（22 子命令 + 8 入口 + 真 HTTP）全过；`make_scratch_vault` 隔离跑完真实 `~/.unified-memory/` 零新增。
- **过程中抓到并修掉的真实回归**：
  1. **真实 `~/.unified-memory.yaml` 被测试写掉**：拆分件的 `app/system.py` 在模块级 `from ...infra.config import CONFIG_PATH`，把路径冻在导入时刻；测试 rebind `infra.config.CONFIG_PATH` 后写入仍指向真实 home。隔离守卫的指纹检查当场报红，配置已从它自己写的 `.bak-20261029-021449` **逐字节恢复**（现为 `vault: C:\Users\zhaowei\OneDrive\Desktop\Obsidian Vault`）。修复：`app/{system,ingest/commands,remote}.py` 全部改为调用时 `config_mod.default_path()`。
  2. **`--json` 远端修复在搬迁中丢失**：拆分件复制的是修复前的 `cmd_search`，`test_remote_json_mode_returns_a_json_envelope` 立刻红。修复：把 `00050f4` 的分支重新落进 `app/query/commands.py`。
  3. **surface 层 import infra**：`surface/cli.py` 为捕获 `VaultMissing` 直接 import `infra.config`，违反层规则。修复：`app.system` 再导出 `VaultMissing`，surface 从 app 拿（定义点仍在 `infra/vault.py`，raise 点不变）。
- **测试跟随（不弱化）**：`test_memory` 的两处 `patch("unified_memory.memory.time.strftime")` 改打新家（`app.ingest.commands` / `app.system`）；`test_config_vault`、`test_digest` 增加 `infra.config.CONFIG_PATH` 的 rebind（规范注入点）；`test/client-findings.test.ts` 扫描 `cmd_doctor` 的新文件。断言内容一字未改。
- **test_architecture 检查器修正**：`module_layer()` 原先把 `unified_memory.domain`（包本身）判成 legacy，导致 `from ...domain import envelope` 被误报；新增 `LAYER_PACKAGES` 映射。白名单：layers 从空集增加到 5 条（五个 app 模块仍调用待迁的 legacy 实现，每条注明由哪步迁移删除）；lazy 删 `memory`（导入已提到模块级）、加 `app.query.commands`（`memory` 是环，必须函数内导入，B5.3 把 HTTP 客户端搬进 `app.remote` 后删除）。
- **结构指标**：memory.py 1305 → 119；surface/cli.py 232（软限 450 / 硬限 600 内）；app/ 合计 1145；>600 行文件 3 → 2（剩 promoter 1055、conflict 619）。
- **测试结果**：七道门全绿（Python 457 / JS 886 / setup 32 / typecheck / bench 与 after-a12 一致 / **快照 42/42 逐字节** / e2e 46）。
- **遗留风险**：`memory.py` 119 行，未达任务书 §B5 的"≤20 行"——因为用户明确要求 `INDEX_DB` 与 `remote_search` 原位保留；B5.3 把 HTTP 客户端搬进 `app.remote` 后只剩 `INDEX_DB` + 显式 re-export（预计 ~70 行），"≤20 行"需在 B5.5 连同 shim 退场计划一起评估。

### B5.3 legacy 实现模块迁入 layers

- **调研**：七个候选模块的依赖面差别很大——`drift` 自包含、`graph` 被 app 与 hybrid 检索共用（任务书要求留 facade）、其余六个都只依赖 domain/infra 加少数 legacy 兄弟。**选定方案**：逐模块 `git mv` 到目标层，旧路径留**显式 re-export shim**（任务书 §0.7：shim 只活一个 minor），这样 `python -m unified_memory.{digest,drift}`、`integrations/hermes/daily_cron.py`、以及所有测试的 import 面都不用改。**放弃方案**：一次性把六个模块连同 import 面全改到新路径（改动面翻倍，且无法用现有测试证明没漏）。
- **设计**：`drift`→`app/maintain/`、`health`→`app/maintain/`、`digest`/`inbox`→`app/ingest/`、`preview`/`stats`→`app/query/`；`graph` 按任务书保持 legacy facade 不动。shim 只做显式列举（不用 `*`），并在 docstring 写明"一个 minor 后删除"。
- **虚拟项目验证**：每个模块迁完立刻跑 `python -m unittest discover -s core/tests`（457 例），再做七道门；`e2e_all_features.py` 覆盖 `python -m unified_memory.digest --dry-run`、`sessiondb`、`drift --template`。
- **过程中抓到的三类真实问题**：
  1. **`cmd_drift` 的 repo_root 层级**：`Path(drift_mod.__file__).parents[2]` 在文件下沉两层后指向 `unified_memory/` 而不是仓库根，`drift --template` 会找不到 `driftrc.yaml`。改为 `parents[4]` 并写清理由；快照 `drift-template` case 是把关者。
  2. **懒导入层级**：`digest` 里三处函数内 `from . import config/sessiondb` 在搬迁后指向 `app.ingest`，运行到才炸（`test_sessiondb` 的三个用例当场红）。全部改为 `...`。
  3. **patch 打在 shim 上等于没打**：`test_digest` / `test_sessiondb` / `test_health` 的 `patch("unified_memory.digest.chat_extract_facts")` 之类，迁完后 patch 的是 shim 的独立绑定，被测代码用的是实现模块的全局——用例会"绿得莫名其妙"或直接红。全部重定向到 `unified_memory.app.<layer>.<module>.<name>`；`test/client-findings.test.ts` 的 `HEALTH_PY` 源码扫描同理改指 `app/maintain/health.py`（它数 `_issue(` 调用点，shim 里是 0）。
- **白名单变化**：`app.maintain.commands` 因 health/drift 都变成本地兄弟而**退出 layers 集合**；`app.query.preview`、`app.maintain.health` 因仍读 legacy `conflict`/`index` facade 而加入（B5.4/B5.5 清除）；`subprocess`/`lazy_import`/`third_party` 里 drift 的条目跟着模块改名。
- **结构指标**：六个旧文件 812 行实现变成 6 个 shim 共 118 行；app/ 合计 1145 → 1962；`>600 行文件` 仍是 2 个（promoter 1055、conflict 619，B5.4 处理）。
- **测试结果**：每个子步七道门全绿（Python 457 / JS 886 / setup 32 / typecheck / bench / 快照 42 / e2e 46）。
- **遗留**：`index`/`embed`/`search`/`promoter`/`conflict`/`forgetter`/`maintenance`/`sessiondb` 仍平铺（B5.4/B5.5）；`app.query.commands` 的 `memory` 懒导入仍是环，等 HTTP 客户端搬进 `app.remote` 后清除。

### B5.4a 拆 conflict.py：纯规则下沉 domain，队列 I/O 进 app/govern

- **调研**：619 行里混着两件事——字符二元组相似度、主体抽取、冲突分类（纯函数，零 I/O）与「读写 `事实冲突待裁决.md`」的 Markdown 块增删（全是要落盘的操作）。**选定方案**：按"是否碰 vault"切两半，纯规则 → `domain/conflict.py`（344 行），队列 I/O → `app/govern/queue.py`（326 行），旧路径留 55 行 shim。**放弃方案**：按函数名逐个挑（同一批常量被两半共用，会撕成两份真相）。
- **设计**：先解决"障碍 1"（正则常量夹在 I/O 段内部）——把那 7 个常量跟着使用它们的那一半走，而不是上移到 `domain/markdown`：`describe`/`split_change` 是唯一使用者，放 domain 顶部即可，不必污染公共 markdown 模块。切分用 **AST 节点级切分器**（按 `ast.body` 逐节点取源码段，注释与空行原样保留），配一张"37 个顶层名 → 落哪一半"的映射表，切完 diff 断言每个名字**恰好**出现在一半里。
- **虚拟项目验证**：切完立刻 `python -c "import unified_memory.conflict"` + 现有 457 例；`test_conflict_formats`、`test_cross_doc_conflicts`、`test_occurrence_identity` 全绿（它们覆盖两种冲突块格式、跨文档命中、同一事实多次出现）。
- **过程中抓到的真实问题**：**第一次按行号区间切（45–242 / 420–523）直接产出 `IndentationError: unexpected indent`**——`return entry` 被切到函数外。行号切分对"函数体跨切点"毫无防护，换成 AST 节点切分后一次通过。这条写进"已知风险"给下一位。
- **顺带修掉的边界**：`queue.record_adjudication` 原本用 `open(path,"a")` 追加，是 `writes` 白名单里 conflict 的最后一条理由；改成 `read_maybe` + `atomic_write`（内容原样拼在末尾），语义不变、写入走唯一执行器，`writes` 白名单随之删掉 `conflict`。
- **测试结果**：七道门全绿（Python 463 / JS 886 / setup 32 / typecheck / bench / 快照 42 / e2e 46）。
- **遗留**：`app/govern/queue.py` 326 行、`domain/conflict.py` 344 行，均在软限内。

### B5.4b 一个调度器：register_job 取代两份 cron 实现

- **调研**：`promoter --cron` 与 `forgetter --cron` 各带一份平台对话（Windows 写 `.bat` + `schtasks`，POSIX 写 crontab），两处都要引号、都要烘 PYTHONPATH、都要幂等标记，改一处必忘另一处。**选定方案**：`infra/schedule.py` 收口成唯一会 shell out 的模块，业务侧只交一个 `JobSpec`。**放弃方案**：在 schedule 里 import forgetter/promoter（这正是"障碍 3"的反向依赖环）。
- **设计**：`JobSpec` 是 frozen dataclass（`job / module / flags / script_dir / script_name / log_name / windows_task / windows_when / cron_expr / banner / windows_desc / posix_desc`），**路径与调度参数全部由调用方传入**，schedule 不认识任何业务模块；`register_job(spec, vault)` 分派到 `_register_windows` / `_register_posix`；`run_command(args, *, cwd, timeout)` 是唯一的 subprocess 边界（失败返回 `None`，调用方降级）。Windows `.bat` 用 `atomic_write` 写，文本首字符是 `"\ufeff"`，保住 BOM 而不必开裸文件句柄。
- **虚拟项目验证**：新增 `core/tests/test_schedule_jobs.py`（6 例）——promoter 任务是 `0 3 * * *` + `--auto` + 烘进 PYTHONPATH + 重跑幂等；forgetter 是 `0 4 * * 1` + `--apply` + 幂等；两者共存于同一份 crontab；`.bat` 以 `b"\xef\xbb\xbf"` 开头、含 `--apply` 与 `exit /b %errorlevel%`、首调是 `schtasks`；`run_command` 对不存在的二进制返回 `None`、对真命令拿到 stdout。
- **过程中抓到的真实问题**：`test_forgetter` / `test_catchup` 两处 `patch("unified_memory.forgetter.subprocess.run")` 失效（`forgetter` 已经没有 `subprocess` 属性）——重定向到 `unified_memory.infra.schedule.subprocess.run`，**断言内容一字未改**。
- **白名单变化**：`subprocess` 集合**清空**（drift 的 git 探针也改走 `run_command`）；`writes` 删掉 `forgetter`、`promoter`。
- **测试结果**：七道门全绿（Python 457 → 463 / 其余同前）。
- **遗留**：drift 的 `--git-precommit` 仍保留在 `layers` 白名单（它读 PyYAML，属 third_party 例外，B5.5 处理）。

### B5.4c 拆 promoter.py：facts / review / promote / decide / cron 进层

- **调研**：1058 行里"障碍 2"说对了——`promote/review/decide/cron` 共享 `CATEGORY_RULES`、`DECISIONS`/`ADVISABLE`、`_pending_path`、`plan_promotion` 的返回结构，以及"apply 之后再刷索引"的时序。**选定方案**：按**职责**切五块，共享常量先找到它们真正的家——分类规则本就在 `domain/policy`、事实行读写是纯 domain 逻辑（新建 `domain/facts.py`）、裁决集合属 decide 自己。**放弃方案**：只做文件搬家（对 450/600 预算无帮助，障碍 2 已论证）。
- **设计**：
  - `domain/facts.py`（155）——哪些 bullet 是 active、事实追加到哪、被取代的值如何进 `## 已取代`；
  - `app/govern/review.py`（342）——扫 + 分类 + 生成待晋升清单；
  - `app/govern/promote.py`（279）——plan/apply/archive（`promote`/`apply_pending`/`accept`/`auto_promote`）；
  - `app/govern/decide.py`（195）——对单个冲突下裁决（`decide`/`adjudicate`）；
  - `app/govern/cli.py`（82）——argparse 入口 + 声明式 `--cron`（`JobSpec`，`module="unified_memory.promoter"`、`--auto`、`promote_daily.bat`、`UnifiedMemoryPromote`、`DAILY 03:00`）。
  - `maintenance.py` → `app/maintain/repair.py`（`git mv`）：修复是对 vault 的 app 级操作，不该和 memory 平级。
- **虚拟项目验证**：`test_promoter`、`test_accept`、`test_auto_promote_archive`、`test_conflict_formats`、`test_cross_doc_conflicts`、`test_repair_existing`、`test_state` 全绿；e2e 46 项（含 `promoter` 的 review/apply/auto/repair-existing 四个真入口）全过；CLI 快照 42 例逐字节一致。
- **过程中抓到的真实问题**：① AST 切分把 `index_mod.record_audit(...)` / `update_index(...)` / `lexical_search(...)` 的调用点搬到了新模块，但表头没跟着映射 → `NameError`；改为直接 `from ...infra.store import ...` 裸调用。② 新 `promote._refresh_index` 里残留一句函数内 `from . import index as index_mod`（层级已不对且调用已不需要）→ 删除。③ `app/ingest/commands.py` 里 `from ... import promoter` 是**死导入**（整个模块没调用过）→ 删除。④ `app/govern/commands.py` 仍在用 `promoter_mod` 门面 → 改成真名（`.promote.accept`、`.decide.{decide,ADVISABLE,DECISIONS}`），`conflict_mod` 别名正名为 `queue_mod`。
- **新增测试**：`core/tests/test_module_surface.py`（5 例）——把四个 shim（memory / conflict / promoter / maintenance）在基线 `805fad8` 的**公开面冻结成清单**，断言 ① 每个名字仍可从旧路径解析；② 有唯一实现归属的名字，shim 属性与实现模块**是同一个对象**（这才是"re-export"而非"会漂移的副本"）。两个例外写明理由：`shlex_quote` 用**行为一致**断言（它是 delegate）、`memory.INDEX_DB` 用**重绑定**断言（它整个存在的意义就是被隔离守卫 rebind）。第三条断言 shim 里不许长出新代码。
- **白名单变化**：`layers` 删 `app.govern.commands`、`app.ingest.commands`（改真名后自然退出）；`lazy_import` 删 `promoter`、`maintenance`（shim 不做懒导入）。**没有新增任何条目**。
- **测试结果**：七道门全绿（Python 463 → **468** / JS 886 / setup 32 / typecheck / bench / 快照 42 / e2e 46）。
- **遗留**：`review` 132 行、`decide` 83 行、`plan_promotion` 61 行超函数预算 → 归入 B5.5。

### 待修缺陷 D1：`memory doctor` 的"向量是否配置"恒为 False（2026-10-29 交棒前发现，已复现，**按主人指示未修**）

- **复现**：`python -c "from unified_memory.app.maintain import embed"` → `ImportError: cannot import name 'embed' from 'unified_memory.app.maintain'`。
- **根因**：B5.3 把 `health` 从 `unified_memory/health.py` 搬到 `app/maintain/health.py` 时，函数体内的 `from . import embed as embed_mod`（现第 151 行）少加了一层——`.` 现在指 `app.maintain`，那里没有 `embed`。外面套着 `except Exception: pass`（注释理由是"诊断永不崩"），于是 ImportError 被**静默吞掉**，`report["embeddings"]["configured"]` 永远是 `False`。
- **影响**：用户即使配了 `SILICONFLOW_API_KEY`，`memory doctor` 仍报告向量未配置——而"向量到底配没配"正是 doctor 存在的理由。属用户可见的诊断说谎，不是内部整洁问题。
- **为什么测试没抓到**：`test_health` 的三处 `patch("unified_memory.embed.configured", return_value=False)` 恰好与坏行为（永远 False）取值相同，且没有任何用例断言 `report["embeddings"]["configured"]` 这个字段。
- **建议修法（约 3 行 + 1 个测试，本喵已在本机验证可行后回退）**：
  1. 把 import 提到模块级 `from ... import embed as embed_mod`（与同文件 `index_mod` 的写法一致），`try` 只包住 `embed_mod.configured()` 调用——这样 import 坏了会在导入期炸，而不是变成一句谎话；
  2. 加 `test_embeddings_configured_reaches_the_report`：`patch(..., return_value=True)` 断言 `True`，`patch(..., return_value=False)` 断言 `False`（两个方向都钉，防止卡在任一值）；
  3. 修完 `lazy_import` 白名单里的 `app.maintain.health` 会变**过期**（实测：改成模块级后该条目仍在 = 测试红），必须同步删掉——即这一步同时清掉 1 条白名单债。

## B5.5 未完成：接手说明（2026-10-29 交棒点）

**一句话状态**：B5.2 / B5.3 / B5.4（a/b/c）已入库并全绿，`git status` 干净，HEAD = `e5fb47e`；**只剩 B5.5**——清空架构白名单 + 翻预算门。下面每条都是本轮实测数据，不需要重新探查。

### 已解除的三个障碍（别再重新论证，方案已入库）

| 原障碍 | 结论 | 落地提交 |
|---|---|---|
| 1. conflict.py 的正则常量夹在 I/O 段内部 | 按 **AST 节点级**切分 + 一张"顶层名 → 归属"映射表，常量跟使用者走（不必上移 `domain/markdown`）。**不要按行号区间切**——第一次这么做直接产出 `IndentationError` | `e5bd84c` |
| 2. promoter.py 的共享模块级状态 | 先给共享常量找真正的家：分类规则留 `domain/policy`、事实行逻辑新建 `domain/facts`、裁决集合归 `decide`，再按职责切五块 | `e5fb47e` |
| 3. register_cron 的反向依赖环 | `infra/schedule.JobSpec` + `register_job(spec, vault)`：路径与调度参数全由调用方传入，schedule 不认识任何业务模块 | `8289874` |

### 当前白名单（实测，6 类规则 / 15 个条目；`subprocess` 已空）

| 规则 | 剩余条目 | 清除条件（已核实） |
|---|---|---|
| sqlite3 | `sessiondb` | `git mv` 到 `infra/sessiondb.py`（`SQLITE3_OK_PREFIXES` 里已写好该前缀，只需删白名单条目）；改 `from .domain.markdown` → `from ..domain.markdown` |
| writes | `sessiondb` | 同上（`export_markdown` 故意写 markdown，`WRITES_OK_PREFIXES` 已含 `infra.sessiondb`） |
| lazy_import | `app.ingest.digest`（4 处）、`app.maintain.drift`（3 处）、`app.maintain.health`（1 处）、`app.query.commands`（1 处）、`embed`（1 处）、`search`（1 处） | 逐条判定，见下表。**`app.maintain.health` 那条随缺陷 D1 一起消失**（修 D1 时同步删，修完变 14 条） |
| third_party | `app.maintain.drift` | PyYAML 可选依赖，见"决策点 A" |
| layers | `app.ingest.digest`、`app.maintain.drift`、`app.maintain.health`、`app.query.commands`、`app.query.preview`、`app.system` | 把 `index`/`embed`/`search`/`graph` 的引用改成真名或迁进层，见"决策点 B" |

**lazy_import 逐条实测（file:line → 导入内容 → 性质 → 建议）**

| 位置 | 导入 | 性质 | 建议 |
|---|---|---|---|
| `app/ingest/digest.py:85` | `from ... import config as config_mod` | 函数内导入（`set_key` 低频写配置） | 提到模块级即可（`infra.config` 无环） |
| `app/ingest/digest.py:198`、`:219` | `from ... import sessiondb`（同一模块两次） | 可选数据源 | 提到模块级 `from ...infra import sessiondb`（B5.5a 之后） |
| `app/maintain/drift.py:106`、`:410` | `import yaml` | 可选第三方 | 决策点 A |
| `app/maintain/drift.py:362` | `import argparse` | 无理由懒加载 | 提到模块级（零风险） |
| `app/maintain/health.py:151` | `from . import embed as embed_mod` | 层级已错（`app/maintain` 下没有 embed） | 决策点 B 之后提到模块级 |
| `app/query/commands.py:74` | `from ... import memory as memory_mod` | 环：shim 导入 surface.cli | 把 `remote_search` 留在 shim 是 B5.2 的既定决策；此处可改为调用 `app.remote` 的真名（`remote_config` 已在 `app.remote`），但要确认 HTTP 客户端仍在 shim 里——**若搬不动，就在注释里写明"永久例外"并从白名单移入 `LAZY_IMPORT_OK_PREFIXES` 式的显式常量** |
| `embed.py:321` | `import argparse` | 无理由懒加载 | 提到模块级 |
| `search.py:115` | `from . import graph as graph_mod` | 环：`graph` 反向依赖 `search` | 拆环（把 `expand_search` 需要的 store 读取提到 `infra.store`）或把 graph 作为既定 facade 显式豁免 |

**决策点 A（PyYAML）**：`drift` 的 YAML 读取是可选依赖，B0 已批准。翻预算门时这条必须有个正式归属，二选一：① 把 YAML 读取搬进 `infra/config_yaml.py`，模块级 `try: import yaml / except ModuleNotFoundError: yaml = None`，并新增 `THIRD_PARTY_OK_PREFIXES = (PKG + ".infra.config_yaml",)`——**推荐**，把例外写成边界常量而不是模块白名单；② 保留 `app.maintain.drift` 白名单条目——**不推荐**，任务书要求 B5 结束时白名单为空。

**决策点 B（index / embed / search / graph）**：`index.py` 已是 `infra.store` 的 facade（B2），app 模块可以直接改成 `from ...infra.store import <真名>`，这条是机械活。`embed.py`(337)、`search.py`(294)、`graph.py`(140) 是真实实现，其中 `embed.py` 含 urllib——**Mimosa 扫描器对本仓库曾整文件拦截含 urlopen 的改写，`git mv` 也会被拦**。所以：能 `git mv` 就搬进 `infra/providers`（embed）与 `infra/store`（search 的检索原语）；**搬不动就按 `graph` 的先例留 facade，并在任务书 §0.7 意义上写明理由，不要用 getattr/字符串拼接绕过扫描器**（质量红线）。

### 预算门（`ENFORCE_BUDGETS = True` 前的全部债，实测 13 条）

文件行数已达标：**>600 行文件 0 个**（拆分前 2 个），>450 软限只剩 `infra/store/search_index.py` 470。剩余全是函数/定义数：

| 模块 | 项 | 行数 | 建议切法 |
|---|---|---|---|
| `app/maintain/health.py` | `doctor` | 207 | 按检查项切：`_check_vault` / `_check_index` / `_check_embeddings` / `_check_audit`，`doctor` 只做编排 |
| `surface/cli.py` | `build_parser` | 155 | 按子命令族拆 `_add_query_parsers` / `_add_ingest_parsers` / `_add_govern_parsers` / `_add_maintain_parsers` |
| `infra/store/search_index.py` | `update_memories` | 141 | 拆"解析 → 差异计算 → 落库"三段 |
| `app/govern/review.py` | `review` | 132 | 拆"扫描候选 → 分类 → 写待晋升清单"三段（B5.4c 已按此边界分组） |
| `search.py` | `hybrid_search` | 102 | 拆"候选池 → 融合 → 渲染"（与 B3 的 envelope 边界对齐） |
| `infra/lock.py` | `file_lock` | 94 | 拆"获取 → 等待/超时 → 释放"，或抽 `_LockHandle` 上下文对象 |
| `app/maintain/drift.py` | `main` | 86 | argparse 与执行分离（`build_parser` + `run`） |
| `app/govern/decide.py` | `decide` | 83 | 按"校验 → 状态机迁移 → 落盘 → 审计"四段拆 |
| `infra/store/schema.py` | `_ensure_schema` | 75 | 按表族拆 `_ensure_core` / `_ensure_fts` / `_ensure_vectors` |
| `app/maintain/commands.py` | `cmd_doctor` | 67 | 与 `doctor` 一起拆（它只是渲染层） |
| `app/query/commands.py` | `cmd_search` | 67 | 拆"参数归一 → 三种模式分派 → 输出" |
| `app/govern/promote.py` | `plan_promotion` | 61 | 拆"解析条目 → 解析目标 → 组装 ChangeSet" |
| `infra/store/claims.py` | 24 个顶层 def | 24（限 20） | 按"读 / 写 / 查询"拆成两三个模块 |

### 建议执行顺序（每步一个提交，每步 `bash ../verify.sh` 七道门全绿）

0. **先修缺陷 D1**（约 3 行 + 1 个测试，见上文）：它是用户可见的诊断说谎，且修完顺带清掉 1 条 `lazy_import` 白名单。放在最前面，后面的白名单数字才对得上。
1. **B5.5a** `sessiondb` → `infra/sessiondb.py` + 旧路径 shim（清 `sqlite3`、`writes` 两条白名单）。
2. **B5.5b** layers 六条 + lazy_import 六条（含决策点 A/B）。改完先跑 `test_architecture` 拿精确集合，再动白名单——**白名单必须与实测完全相等，多一条（过期）也会红**。
3. **B5.5c** 上表 13 条预算债，按行数从大到小逐个拆，每拆 2–3 个跑一次七道门。
4. **B5.5d** `ENFORCE_BUDGETS = True` + `WHITELIST` 删空 + 更新本文件"验证基线/白名单/预算"三节 + 收尾报告。

### 接手时的环境与流程坑（已踩过，别再踩）

- 验证一律 `bash ../verify.sh`（七道门）。本机默认 `python` 是 AutoClaw vendored 3.13（`._pth` 冻结 `sys.path`），直接跑会有假红。
- 单模块跑测试：`PYTHONPATH='core;core/tests' python -m unittest test_xxx`（Windows 用分号；用冒号会 `ModuleNotFoundError`）。全量：在 repo 根 `python -m unittest discover -s core/tests`。
- `npm run check` 里的 `sync:check` **要求工作树干净**，有未提交改动必红——要么先提交，要么只用 `../verify.sh`。
- **patch 必须打实现模块**（`unified_memory.app.<layer>.<module>.<name>`），打 shim 是独立绑定、到不了被测代码。
- 判断是否污染真实 home 用**文件名集合差**，不要用 mtime（dsh 插件常驻会持续写自己的 `index-*.db`）。
- 每个提交的说明里要写清**删掉了什么**（任务书要求）；本文件"删除清单"同步追加一行。

## 删除清单


- B3：三处重复的围栏拼装实现（render_hybrid / print_memory_data / cmd_show 各自的报头+标签常量），合并进 `domain/envelope.py`。
- B4：三个 canonical 写者各自的内联 `with file_lock` 写入块（promote/demote/repair），合并进 `infra/vault.apply` 唯一执行器；`atomic_write` 的无 fsync 版本。
- B5.1：`promoter.decide` 里的 DECISIONS 成员校验（改走状态机）。
- B5.2（阻塞回滚）：无删除——拆分件完整保存在 `../attic/b5.2-prepared.tar.gz`，解阻塞后解包即得。
- B5.2：`memory.py` 的 1305 行实现（argparse 语法、dispatch、22 个命令体、内置模板常量、vault 引导、`emit_json`）全部搬走；`emit_json` 的旧定义从 memory.py 删除（改由 `infra.console` 提供）；`surface/cli.py` 里对 `infra.config` 的直接依赖删除（`VaultMissing` 经 `app.system` 再导出）。
- B5.3：`drift.py`(445)、`digest.py`(314)、`health.py`(322)、`preview.py`(245)、`stats.py`(130)、`inbox.py`(115) 六份实现搬进 layers，旧路径只留显式 re-export shim（合计 118 行）；`graph.py` 按任务书保留 legacy facade，未动。
- B5.4a：`conflict.py` 的 619 行实现（37 个顶层名）切成 `domain/conflict.py`(344) + `app/govern/queue.py`(326)，旧路径只留 55 行 shim；`queue.record_adjudication` 里 `open(path,"a")` 的追加写删除（改 `read_maybe` + `atomic_write`）。
- B5.4b：`promoter.register_cron` 与 `forgetter.register_cron` 两份平台对话（各含 `.bat` 文本、`schtasks`/`crontab` 分支、PYTHONPATH 烘焙、幂等标记）删除，合并为 `infra/schedule.register_job(JobSpec, vault)`；`drift` 的 `subprocess.run` 直调删除，改走 `schedule.run_command`。`subprocess` 白名单随之清空。
- B5.4c：`promoter.py` 的 1058 行实现（81 个顶层名）切成 `domain/facts.py`(155) + `app/govern/{review 342, promote 279, decide 195, cli 82}`，旧路径只留 103 行 shim；`maintenance.py` 的 127 行实现搬为 `app/maintain/repair.py`(125)，旧路径留 17 行 shim；`app/ingest/commands.py` 里从未被调用的 `from ... import promoter` 删除；`app/govern/commands.py` 的 `promoter` 门面依赖删除（改真名）；新模块里一句残留的函数内 `from . import index as index_mod` 删除。
- 维护轮：`~/.unified-memory/journal/*.jsonl` 487 个（816 KB）+ `index-*.db` 44 个（5.1 MB）移入 `_cleanup-backup-20261029-014758/`（531 文件 / 5.94 MB，可整体还原）；备份确认无误后可删该目录。`scripts/` 下两个 smoke 辅助文件改为忽略，不再产生未跟踪文件。


## bench 前后对比

B5.2–B5.4 全部是**结构性搬迁与拆分**，没有触碰检索算法、索引 schema（停在 v10）或排序权重，因此指标必须逐字段不变——这是判断"拆分是否悄悄改了行为"的第二把尺子（第一把是 42 例 CLI 快照）。

| 指标 | after-a12（基线） | B5.4c 后实测 | 判定 |
|---|---|---|---|
| recall@5 / recall@10 | 0.9167 / 0.9167 | 0.9167 / 0.9167 | 一致 |
| mrr / ndcg | 0.9167 / 0.9167 | 0.9167 / 0.9167 | 一致 |
| abstain | 0.75 | 0.75 | 一致 |
| update_top1_ok | 1.0 | 1.0 | 一致 |
| empty | 0.25 | 0.25 | 一致 |

延迟（latency_p50/p95）在 verify.sh 第 5 道门里被显式跳过（机器负载相关，不可比），未做前后对比。真实库副本迁移守恒 164 memories / 130 embeddings / 752 access_log 在维护轮验证后未再变化（B5.2–B5.4 不改 schema）。

## 已知风险

- **拆分只能用 AST 节点级切分，不能用行号区间**：B5.4a 第一次按行号切 `conflict.py`（45–242 / 420–523）直接产出 `IndentationError: unexpected indent`——`return entry` 被切到函数外。行号切分对"函数体跨切点"零防护；AST 切分 + "顶层名 → 归属"映射 + 切完 diff 断言每个名字恰好出现一次，才是可复现的做法。
- **patch 打在 shim 上等于没打**：旧路径是 re-export，`patch("unified_memory.promoter.accept")` 改的是 shim 的独立绑定，被测代码用的是实现模块的全局。必须打 `unified_memory.app.<layer>.<module>.<name>`。`tests/test_module_surface.py` 用"同一对象"断言把这个约定钉住。
- **shim 有退场期**：`memory.py`(119)、`promoter.py`(103)、`conflict.py`(55)、`index.py`(66)、`maintenance.py`(17) 等按任务书 §0.7 只活一个 minor；下个 minor 要连同一批 patch 目标一起清理，不能只删文件。
- 本机 `python` 默认解析到 AutoClaw vendored Python（`._pth` 冻结 sys.path），验证必须用 `../verify.sh`（已封装 Python311 + UNIFIED_MEMORY_PYTHON）。
- `npm run check` 里的 `sync:check` 要求工作树干净：有未提交改动就会红，这是设计而非缺陷；要么先提交，要么只用 `../verify.sh`。
- `python bench/verify_live_migration.py` 读取本机真实索引库的**副本**；B5 不改 schema（停在 v10），无需执行 I4。
- 判断测试是否污染真实 home 时不要用 mtime：本机 dsh 插件常驻会持续写自己的 `index-71a04777…db`，会误报；用文件名集合差。

## ✅ 阻塞已解除：Mimosa SSRF 规则 vs memory.py 拆分（2026-10-29 复测）

**复测方法与结果**：按最小探针向 `core/unified_memory/infra/providers/` 写入一个含 `import urllib.request` 与 `urlopen(` 的临时 .py 文件 —— **写入成功，未被拦截**（探针随后删除）。阻塞解除后 `attic/b5.2-prepared.tar.gz` 已解包入库，B5.2 于 `d247aa1` 完成。

**以下是阻塞期间的原始记录，保留作为历史**：

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

解除后（**已于 2026-10-29 完成**）：`attic/b5.2-prepared.tar.gz` 已解包入库（`d247aa1`），B5.3（`9f1fad2`/`3e38f78`/`699745a`）与 B5.4（`e5bd84c`/`8289874`/`e5fb47e`）已按 §9 顺序做完，只剩 B5.5。本节保留作为历史记录。

## 待办发现

1. **Mimosa SSRF 规则与本项目迁移冲突**（本批次最大发现）：任何新建/改写的 .py 含 `urllib`/`urlopen`/动态 URL 即被整文件拦截，导致 embed/digest/memory 三个含出站调用的模块无法物理迁移。**2026-10-29 复测已解除**（探针写入成功），但 `embed.py` 的迁移仍未被验证过——B5.5 若要把 embed 搬进 `infra/providers`，先做同样的最小探针再动手。
2. `~/.unified-memory.yaml` 曾被某次 e2e 测试指到临时目录（`Temp\uam-e2e\vault`），2026-10-27 已改回真实 vault（索引哈希 `71a04777…` 核对确认）。建议测试框架避免测试直写用户全局配置。**2026-10-29 复检**：配置仍指向真实 vault、mtime 停在 2026-10-27，未复现；同期发现并修掉了 journal 与两处索引库的同类泄漏（见"维护轮"）。B5.2 期间同类问题又出现过一次（拆分件把 `CONFIG_PATH` 冻在导入时刻），已修并全量改为调用时 `config_mod.default_path()`。
3. 用户 vault 的 git 仓库有 **427 个未提交变更**、`.githooks` 为空——做任何"以 git 为记忆事务日志"类功能前必须先清基线。
4. `README.md` 被 canonical 索引收录（7 条事实行）——模板说明文件混进了事实库，可考虑在 indexed_files 里排除。
5. **shim 退场计划缺失**：B5.2–B5.4 留下 5 个 shim（memory/promoter/conflict/index/maintenance 等），任务书 §0.7 只写"活一个 minor"但没有到期清单。建议在下个 minor 开头做一次"shim 退场"提交，同时把测试里所有 `unified_memory.<旧路径>` 的 import 与 patch 目标清干净。
6. **`memory doctor` 的向量配置状态恒为 False（缺陷 D1，未修）**：B5.3 搬迁遗留的错误相对导入被 `except Exception` 吞掉，用户配了 key 也被告知未配置。复现、根因与建议修法见「逐项详情 → 待修缺陷 D1」，修它同时清掉 1 条 `lazy_import` 白名单。

## 建议的下一批次方向

1. **先做 B5.5**（唯一剩余项）：白名单清空 + 13 条预算债 + 翻 `ENFORCE_BUDGETS`。执行顺序与逐条诊断见上一节，数据全部实测过。
2. 之后进入批次 C：Claim Ledger（block ID + 双时间 + as-of）、abstain 置信下限、`PROTECTED_RE` 收敛为白名单（三项均在总方案 §7 缺陷清单）。
3. 收尾：B5.5 全绿后再定稿本文件并请主人决定是否 `git push -u origin refactor/batch-b`（remote 是 GitHub 公共仓库，不擅自推送）。
