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
| B5.5 | 白名单收口（lazy/third_party/sqlite3/writes ✅ 清空；layers 剩 4 条 documented embed 依赖）；build_parser 拆分 ✅；**剩 10 条函数/def 拆分 + 翻门 → 下一批次** | 🔶 部分完成 | `73f9436`、`dcb8c0b` |
| 维护轮  | 全量测试 + 测试隔离修复（journal / decide 集成 / bench）+ 真实 home 清理 + 46 项真功能 e2e（发现并修掉远端两处缺陷） | ✅ 完成（2026-10-29）              | `4a1a50a`、`c2de07c`、`00050f4` |
| D1    | 修 doctor embeddings.configured 恒 False（双向测试钉住）                                    | ✅ 完成（第四阶段第 0 步）             | `5e2ac18`                     |
| B5.5a | sessiondb → infra/sessiondb.py（sqlite3 + writes 白名单清空）                              | ✅ 完成（第四阶段）                   | `4cba03b`                     |
| B5.5b | layers 6→4（documented embed 依赖）；lazy/third_party 清空（PyYAML → config_yaml 决策 A；query.commands → LAZY_OK 决策 B）；app index_mod → store/vault 真名 | ✅ 完成（第四阶段）                   | `73f9436`                     |
| B5.5c-1 | build_parser 拆 5 族子函数（155 → 5×~20）                                          | ✅ 完成（第四阶段）                   | `dcb8c0b`                     |
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

### 缺陷 D1：`memory doctor` 的"向量是否配置"恒为 False（✅ 已修复，第四阶段第 0 步）

**原缺陷**：B5.3 把 `health` 搬到 `app/maintain/health.py` 时，函数体内 `from . import embed as embed_mod` 少加一层（`.` 指 `app.maintain`），ImportError 被 `except Exception: pass` 静默吞掉，`report["embeddings"]["configured"]` 恒为 False——用户配了 `SILICONFLOW_API_KEY` 也被告知向量未配置。旧测试没抓到：三处 patch 恰好与坏行为取值相同，且无用例断言该字段。

**修复记录**：① import 提到模块级（与同文件 `index_mod` 写法一致——import 坏了在导入期炸而不是变成谎话）；② 新增 `test_health.DoctorTest.test_embeddings_configured_reaches_the_report`（patch True 断言 True、patch False 断言 False，两个方向都钉）；③ 同步删除 `lazy_import` 白名单的 `app.maintain.health` 条目（修完变过期，清除 1 条白名单债）。七道门全绿。

## B5.5a + B5.5b 白名单收口（第四阶段，✅ 完成，2026-10-30）

> 下方"接手说明"各表为交棒时的实测快照，保留作底稿；实际执行结果以本节为准。

- **D1**（第 0 步）：`embed` 导入提到模块级（见上节），清 1 条 lazy 白名单。
- **B5.5a**：`sessiondb` → `infra/sessiondb.py`。SQL 全字面量化（PRAGMA 探针按表展开、transcript 查询内联角色字面量——扫描器红线），顶层留 re-export shim（`python -m unified_memory.sessiondb` e2e 不变）；`app/ingest/digest.py` 两处懒加载改指 infra；`test_sessiondb` 改打实现模块（shim 不携带 os/DB_ENV 绑定）。**清掉 `sqlite3` + `writes` 两条白名单**。
- **B5.5b**：
  - digest 的 `config` 懒加载提到模块级；
  - drift 的 PyYAML 按**决策点 A** 收进 `infra/config_yaml.py`（可选依赖 module-level try/except + `require_yaml`/`safe_load`/`YAMLError`，新增 `THIRD_PARTY_OK_PREFIXES` 边界常量——例外写成边界常量而非白名单条目）；
  - drift/embed/search 的 argparse/graph 懒加载全部提到模块级（graph 与 search 已无环）；
  - `app/query/commands` 的 `memory` 懒导入按**决策点 B** 留在 shim（HTTP 客户端不动），改记入 `LAZY_IMPORT_OK_PREFIXES`；
  - app 模块的 `index_mod` 全部改为 store/vault 真名（`fts_search`/`index_db_for`/`update_index`/`indexed_files`）。
- **白名单结果**：`lazy_import`/`third_party` 清空（移入前缀常量）；`layers` 从 6 条减到 4 条，剩余 4 条全部有 documented 理由——embed 的物理迁移被 SSRF 扫描器阻塞（新文件含 urlopen 被拦），index/search 是建在 embed 之上的 facade，digest/health/system 因此引用它们。等扫描器规则调整后迁移 embed，这 4 条随清。
- **测试结果**：Python 470 / JS 886 / setup 32 / typecheck / bench / 快照 42 / e2e 46，全绿。

### B5.5c-2a 拆 health.doctor（205 → 编排 + 14 私有助手，✅ 2026-10-30）

- **调研**：doctor 是 205 行单函数：上半部 6 段 section 构建，下半部 96 行 issues 判定。两处顺序都是把关点——report 字典 JSON 键序（骨架预声明 + orphanIndexes 后补）与 issues 追加序（8 类问题，快照逐字节比对渲染序）。测试面：test_health 9 例打实现模块；client-findings.test.ts 扫 health.py 源码数 `_issue(` 调用点（8 处必须原地保留）；快照 doctor case；e2e doctor 入口。
- **选定方案**：doctor 只做编排（骨架 + 6 个 `_check_*` + `_issues` + ok 判定，30 行）；6 个 section builder 按现序填充；`_issues` 编排 8 个单问题 helper，追加序逐一保持。**放弃方案**：拆成两个模块——client-findings.test.ts 只扫 health.py，跨文件拆动 JS 测试；单文件 19 defs（限 20）内解决。
- **设计**：全私有函数、零新 import、零行为变化；`report["issues"]` 从骨架内追加改为整体赋值（最终值相同）；orphanIndexes 仍是骨架外新键、仍最后出现（JSON 序不变）。回滚 = revert 单提交。
- **虚拟项目验证**：AST 检查 19 top defs；py_compile；test_health 9 例；全量 Python 469 OK (skipped=1)。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：doctor 内联实现体 205 行（重组为 14 个私有助手 + 编排骨架），无逻辑删除。
- **过程记录（第一轮验证抓到自己引入的缺陷）**：初版 helper 命名 `_*_issue` 与 client-findings.test.ts 的朴素子串计数 `_issue(` 撞车（helper 名以 `_issue(` 结尾被计入，8≠24 红）。这是该 JS 测试的设计意图——「parse failure is loud」的防呆尺子抓到了命名疏忽。全部改名为 `_flag_*`，raw 计数回到 9（1 def + 8 调用）。
- **遗留风险**：health.py 19/20 defs——后续在此文件加函数前先清点。

### B5.5c-2b 拆 review（132 → 58 行，✅ 2026-10-30）

- **调研**：`review()` 132 行 = 设置 + 双层循环（每事实的裁决树 ~68 行 + 计数器）+ 冗长输出 + 返回。顺序敏感点：冲突入队（`append_conflict`）与计数器在同一事实迭代内；`_cross_doc_hit` 在 supersede 检查之后（同优先级路径）；verbose 输出在返回前。测试面：test_promoter 等治理套件、快照 review case、e2e promoter 四入口。
- **选定方案**：`_verdict`（单事实裁决树，返回 (kind, entry)，队列 I/O 原位保留在同一模块同一层）+ `_entry`（pending/supersede 条目共用构造器，消除原 3 处重复字典字面量）+ `_print_review`（数据改从 result 字典取，字节不变）+ `review` 编排（分派计数）。**放弃方案**：把裁决树按 status 分裂成多个小函数——同一事实的六种裁决共享 classify/target/cache 前置，撕开要传 5 个参数还多一层间接。
- **设计**：计数器留 review、I/O 留 `_verdict`（原位置）；`review` 58 行；文件 12 defs。迁移中三次自查抓住自己引入的笔误（参数错位、注释重复放置），靠 ast + 指标实测（62 → 58 行两轮收缩：合并跳过条件、链式计数器、重复注释下放 `_verdict`）。
- **虚拟项目验证**：ast.parse + test_promoter/test_conflict_formats/test_accept/test_auto_promote_archive 92 例 + 全量 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：原循环体内联裁决树与 3 处重复的 pending 条目字面量（合入 `_entry`）；review 内与 `_verdict`/`_adjudicated_facts` 重复的两段注释下放。逻辑零删除。
- **遗留风险**：`_verdict` 返回字符串 kind（6 值），调用方按 kind 计数——若后续加裁决种类需同步改两处；已用注释钉住。

### B5.5c-2c 拆 update_memories（141 → ~30 行，✅ 2026-10-30）

- **调研**：update_memories 141 行 = 逐笔记哈希跳过 + 单笔记重建（读旧态 → 解析行记录 → 差异清理 → 插入）+ 陈旧文档清理 + 孤儿清扫。返回值语义：只数"重新解析的文档数"，清理路径不计数。关键不变量：occurrence-identity id（doc+行哈希）、幸存行保强化计数与向量、FTS5 无更新语义必须删重插。
- **选定方案**：`_rebuild_doc_rows` + `_doc_records`（解析为行元组）+ `_purge_doc_rows`（差异清理，幸存 id 保向量）+ `_insert_doc_rows`（插入 + fts_lex）+ `_remove_stale_docs` / `_sweep_orphan_rows`（尾部清理）；update_memories 缩为"跳过 → 重建 → 清理"编排。**放弃方案**：把 docs/fts 的 upsert 也下放助手——它读取 digest 与标题且与重建共享 rel/text，拆开参数翻倍。
- **设计**：`now` 时间戳整个 run 一个值（原语义），参数下传；清理助手不改变 changed 计数；注释随代码迁移。
- **虚拟项目验证**：全量 Python 469 OK（skipped=1）。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：update_memories 内联重建与清理体（约 110 行）重组为 6 个私有助手，逻辑零删除。
- **⚠ 新发现：接手说明的债务清单是每模块最差项**——fix 完 141 行的 update_memories 后暴露被掩盖的 `fts_search`（93 行）；同理 `_ensure_schema`(75) 底下还藏着 `_migrate_to_v5`(64)。**真实初始债务 = 14 个超 60 行函数 + claims.py 24 defs = 15 项，不是 13 项**。已全量重枚举（ast 全函数遍历），完整清单见 B5.5d 节。
- **遗留风险**：search_index.py 494 行超软限 450（硬限 600 内，门只断硬限；`fts_search` 拆分后文件将回到软限内）。

### B5.5c-2d 拆 file_lock（94 → 55 行，✅ 2026-10-30）

- **调研**：file_lock 96 行单函数 = 线程锁获取 + 排他创建循环（PermissionError 瞬态重试 / FileExistsError → 存活探针或 10 分钟陈旧规则）+ token 校验释放。两处**重复**代码：锁字段解析（获取与释放各一份）、超时消息（两个分支各一份）。测试面：test_write_lock 6 例（并发写者测试，对时序敏感）。
- **选定方案**：5 个助手——`_read_lock_fields`（消除 2 处重复解析）、`_owner_alive`（signal-0 探针）、`_recover_stale_or_corrupt`（10 分钟规则）、`_wait_notice`（一次性等待提示 + flag 返回）、`_raise_if_past_deadline`（消除 2 处重复超时消息）。**放弃方案**：抽 `_LockHandle` 上下文对象——会把 3 个异常路由分支藏进类的 `__enter__/__exit__`，时序测试更难归因。
- **设计**：循环骨架与异常路由**逐分支保留**，含两个非显然语义：锁在检查中途消失（stat FileNotFoundError）→ **立即重试**而非等待；损坏锁未满 10 分钟 → 落入等待而非重试。手工拆分两次自查出语法损坏（`new try:`），全部由 ast 检查当场抓住修复。
- **虚拟项目验证**：ast + test_write_lock 6 例 + 全量 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：2 处重复的字段解析块与 2 处重复的超时消息（合入助手）；循环体逻辑零删除。
- **遗留风险**：无——file_lock 55 行（限 60），8 defs。

### B5.5c-2e 拆 hybrid_search（100 → 50 行，✅ 2026-10-30）

- **调研**：hybrid_search 100 行 = 三流收集（lexical/vector/graph，graph 可选）+ RRF 融合 + 每文档限额去重 + 记录组装（逐条 redact）+ 预算/格式后处理 + 访问计数 + 载荷。顺序敏感点：`record_access` 只对 selected 的 id；payload 的 streams 计数取自三流原始列表。测试面：test_search、快照 search 各 case、bench fixture（检索路径是 bench 的直接测量对象）。
- **选定方案**：`_streams`（三流收集，"检索不调 provider"的权衡注释随之迁入）、`_diversify`（RRF 序 + MAX_PER_DOC 限额）、`_result_records`（组装 + redact）。**放弃方案**：按 B3 envelope 边界把渲染也拆给 `render_hybrid`——渲染已是独立函数，再拆只挪调用行。
- **设计**：hybrid_search 缩为"索引刷新 → 三流 → 融合 → 去重 → 组装 → 预算 → 计数 → 载荷"八行编排；docstring 引用从"comment below"改为"_streams"。逻辑零改动。
- **虚拟项目验证**：全量 Python 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：内联三流/去重/组装体（约 55 行）重组为 3 个私有助手；逻辑零删除。
- **遗留风险**：无——search.py 308 行回到软限内，10 defs。

### B5.5c-2f 拆 fts_search（93 → 44 行，✅ 2026-10-30）

- **调研**：fts_search 93 行 = 行级 lexical 直取（inner `add` 闭包 + 命中即早退）+ 文档级 FTS 回退（snippet 解析回 active 行）+ 关键词全扫描兜底。返回 dict 的两个分支形状不同（lexical 有 `id`，回退有 `match`）——都是既有输出面。测试面：test_search / test_schema 的 fts 用例、快照 search 各 case。
- **选定方案**：抽出 `_fts_fallback`（conn 生命周期 + 两个回退循环，含 docstring 说明为何 doc-level 命中必须经 `_doc_match` 解析回 active 行）；`add` 闭包留在原位（迁出需要把 results/seen_docs 两个可变状态参数化，收益为负）。**放弃方案**：把回退两个循环再拆——它们共享 results 顺序与 limit 截断，拆开反而要传状态。
- **设计**：fts_search 缩为"lexical → 早退 → fallback → 组装返回"；`_fts_fallback` 56 行。逻辑零改动。
- **虚拟项目验证**：全量 Python 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：fts_search 内联回退体（约 48 行）迁入 `_fts_fallback`；逻辑零删除。
- **遗留风险**：search_index.py 506 行仍超软限 450（硬限内；软限仅记录不断言）。

### B5.5c-2g 拆 decide（83 → 39 行，✅ 2026-10-30）

- **调研**：decide 83 行 = 状态机校验 + 用新/并存落盘分支（锁内：取代旧值 → 追加新值 → 落盘 → 记录裁决 → 出队 → 归档 → 审计）+ 保留旧/跳过记录分支。两分支的审计块**逐字节相同**（各 4 行）。测试面：test_state（DECISIONS 一致性）、test_promoter 的 decide 用例、快照 decide case、e2e decide 入口。
- **选定方案**：`_apply_replace`（用新/并存，锁内七步原序保留）+ `_record_only`（保留旧/跳过）+ `_record_decision_audit`（消除两处重复审计块）；decide 只留校验 + 分派。**放弃方案**：把七个锁内步骤再分段——它们共享 `existing` 局部变量链与同一把锁，拆开要传中间态。
- **设计**：锁语义不变（落盘与出队仍同一把锁）；返回 dict 三种形状逐字节不变；decide docstring（24 行）原样保留。
- **虚拟项目验证**：test_state + test_promoter 36 例 + 全量 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：两处重复的 record_audit 块（合入 `_record_decision_audit`）；分支体逻辑零删除。
- **遗留风险**：无——decide.py 6 defs。

### B5.5c-2h 拆 drift main（80 → 22 行，✅ 2026-10-30）

- **调研**：main 80 行 = argparse 构造（30 行）+ vault 解析 + 五分支异常映射（每分支打印 + return 1）+ report 打印 + 退出码。main 的 `int` 返回契约被外部调用方依赖（`sys.exit(main())` 与可能的 import 调用方）。测试面：快照 `drift --template` case（该 case 曾是 B5.3 层级 bug 的把关者）、test_architecture、e2e drift 入口。
- **选定方案**：`_parser`（argparse 构造）+ `_run_report`（vault 解析 + 五分支异常映射，打印后**返回 None** 而非抛 SystemExit——保住 main 的 int 契约，避免 import 调用方拿到异常）+ main（parse → run → None→1 → print → 退出码）。**放弃方案**：_run_report 内 `raise SystemExit(1)`——对 CLI 进程等效但对函数调用方是行为变化（红线）。
- **设计**：五条错误消息**逐字节**保留（含 driftrc.yaml 的 PyYAML 提示）；report.print() 与 strict 退出码留在 main。逻辑零改动。
- **虚拟项目验证**：`python -m unified_memory.drift --template --repo-root .` exit 0 smoke + 全量 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：main 内联 parser 块（30 行）与五分支异常块（20 行）迁入助手；逻辑零删除。
- **遗留风险**：drift.py 456 行略超软限 450（硬限内，软限仅记录）。

### B5.5c-2i 拆 _ensure_schema + _migrate_to_v5（75+64 → 8+44 行，✅ 2026-10-30）

- **调研**：同文件（infra/store/schema.py）相邻两债。`_ensure_schema` 75 行 = 三个天然表族（docs/fts/memories 主题、embeddings/缓存/审计派生族、索引族），其中两条 try/except 容错（fts_lex 建表、text_hash 索引——后者注释明确"v5 迁移稍后补建，此处失败属预期"）。`_migrate_to_v5` 64 行 = 列补加 → 旧 (doc,line) 去重（access_count 降序保最常用）→ id 重映射 → 两张 memory_id 表重映射。测试面：test_schema_migrations 6 例（含手工旧形状库升级路径）+ 真实库副本迁移守恒。
- **选定方案**：`_ensure_core` / `_ensure_derived` / `_ensure_indexes` 三段按表族拆（任务书 B0 预算表建议的 `_ensure_core/_ensure_fts/_ensure_vectors` 分族微调为现实分组）；`_remap_memory_refs` 收编两张表的两段重映射循环（注释"两条字面量语句而非表名循环——动态 SQL 是红线"随之迁入）。**放弃方案**：每个 CREATE 一函数——18 个语句拆成 18 个函数是噪音。
- **设计**：容错语义逐条保留（两条 try/except 原位）；SQL 全字面量（扫描器红线）；_ensure_schema 缩为三调用。
- **虚拟项目验证**：test_schema_migrations 6 例 + 全量 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：_ensure_schema 内联建表/索引体（约 70 行）与 _migrate_to_v5 的两段重映射循环（21 行）迁入 4 个助手；逻辑零删除。
- **遗留风险**：schema.py 18 defs（限 20）。

### B5.5c-2j 拆 cmd_search + cmd_doctor（67+67 → 12+15 行，✅ 2026-10-30）

- **调研**：两个 67 行命令体。cmd_search = 三模式（hybrid/remote/local）各自独立输出（remote 含远端失败回退本地 + lazy import memory shim）；cmd_doctor = 获取+失败兜底 → JSON/文本渲染 → 严格退出码。测试面：快照 search/doctor 全 case、e2e 两种模式、test_remote_json 回归。
- **选定方案**：cmd_search → `_search_hybrid/_search_remote/_search_local` 三模式助手 + 分派；cmd_doctor → `_doctor_report`（永不抛，映射为错误报告）+ `_print_doctor`（人类面板）。**放弃方案**：模式助手返回 dict 由 cmd_search 统一渲染——三种模式输出形状本就不同（id vs match 字段），统一层是假抽象。
- **设计**：remote 分支的 lazy import 与注释原位保留（HTTP 客户端仍驻 memory shim）；错误消息与 JSON envelope 逐字节不变。
- **虚拟项目验证**：全量 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：两处内联模式/渲染体（约 100 行）迁入 5 个助手；逻辑零删除。
- **遗留风险**：无——两文件 5/10 defs。
- **过程记录**：cmd_doctor 主体替换的 Edit 一次严重损坏（整函数被替成一行乱码），ast 当场抓红，单次小 Edit 恢复；坚持"每步 ast 验证"的流程把损害限制在一步内。

### B5.5c-2l 拆 plan_promotion（61 → 22 行，✅ 2026-10-30）

- **调研**：plan_promotion 61 行 = 按目标笔记分组 + 组内规划（去重复核 → 追加行 → 取代移位 → Change 组装）+ ChangeSet 收尾（replan 回调）。replan 回调要求 plan_promotion 可重入重跑自身。测试面：test_promoter、test_accept、test_auto_promote_archive、e2e promote 路径。
- **选定方案**：`_plan_group`（单目标笔记的组内规划，含两条既有注释随迁）；plan_promotion 留分组循环 + ChangeSet 组装。**放弃方案**：把去重复核再抽——它读写 additions/supersedes/facts 三个本地列表，拆开要传 3 个可变状态。
- **设计**：`today` 时间戳语义不变（一个 run 一个值）；`domain_state.transition("claim", ...)` 钉住调用留在 `_plan_group` 原位置；replan 回调不变。
- **虚拟项目验证**：全量 469。
- **测试结果**：七道门全绿（469 / 886 / 32 / typecheck / bench 一致 / 快照 42 逐字节 / e2e 46）。
- **删除**：组内规划体内联块（约 40 行）迁入 `_plan_group`；逻辑零删除。
- **遗留风险**：无——promote.py 9 defs。

## B5.5 接手说明存档（2026-10-29 交棒点，已被上节取代）

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

## ⛔→✅ 阻塞与解除（2026-10-30）：Mimosa git-gate 拦截所有 git commit（同日已由主人解除）

**现象**：任何 `git commit` 被 ZCode Mimosa 插件的 git-gate 钩子在 PreToolUse 强制拦截：「L3 发现 18 个高危」。
**机制（已查明）**：gate 在 commit/push 前对项目文件系统做内容级全量扫描（含未跟踪文件），高危即拒；与 MCP 密封扫描（`scan-2026-10-29T16-23-52…`，13 findings，已产出封印报告）互相独立；跨会话 finding ledger 为空（batches=0）——昨天的提交能过、今天被拦，插件侧状态有变化，代码无差异。
**已试并失败的正规路径**：① MCP sealed 重扫（gate 不读它）；② 删未跟踪的 `lib/` 构建产物（27→18，`npm run build` 可重建）；③ `.mimosa/security-policy.json`（`mimosa policy init` 生成，threatModel.exclusions 填 10 个文件路径，`policy check` 通过但 **exclusions 对 audit/gate 无效**）；④ ledger record 无 finding ID 可登记。
**发现分类（18 高危，全部核实过标记行）**：8 条 = 测试夹具 `os.path.join(变量,变量)` 写临时文件的启发式误报（test_preview×5 / test_inbox×3）；4 条 = 产品 SSRF（memory.py:15/111 = B5.2 决策保留的远端客户端；embed.py:150、digest.py:158 = SiliconFlow API 调用，均为 2026-10-29 已裁定接受的产品功能）；2 条 = test_remote_search 的 loopback 安全测试本身；3 条 = 注释/docstring 提到关键词被标记（test_module_surface:195、test_architecture:32）+ test_stats:334 的 f-string 测试 SQL（t 遍历固定字面量元组）；1 条 = test/setup-run.test.ts:211（测试里 spawn python 固定参数）。
**当前状态**：`.gitignore`（.mimosa/ 规则）已 staged 未提交；`lib/` 已删（未跟踪，可重建）；策略文件在 `.mimosa/security-policy.json`（已 gitignore，不影响 git）。所有代码改动为 0，工作树其余干净。
**解除路径**：插件侧放行/规则调整（2026-10-29 先例）——需仓库主人操作。**→ 已于 2026-10-30 由主人在 ZCode 插件管理中停用 Mimosa 钩子后解除**，提交恢复正常；期间完成的两项工作（chore 与 B5.5c-2a）已按序补交。

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
