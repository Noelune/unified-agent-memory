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
| B5.3 | legacy 实现模块迁入 layers                                                              | ⬜ 待做（阻塞已解除）                   | —                             |
| B5.4 | promoter/conflict/forgetter/maintenance 拆分到 ≤600 行；register_cron → infra/schedule | ⬜ 待做                          | —                             |
| B5.5 | 拆 8 个 >60 行函数；ENFORCE_BUDGETS=True；白名单清空                                          | ⬜ 待做                          | —                             |
| 维护轮  | 全量测试 + 测试隔离修复（journal / decide 集成 / bench）+ 真实 home 清理 + 46 项真功能 e2e（发现并修掉远端两处缺陷） | ✅ 完成（2026-10-29）              | `4a1a50a`、`c2de07c`、`00050f4` |
| 收尾   | BATCH-REPORT 定稿 + push origin                                                     | ⬜ 推送待用户确认（remote=GitHub 公共仓库） | —                             |

## 验证基线（维护轮后，全绿）

- Python 457（skipped=1 预算门）/ JS 886（41 文件）/ setup 32 / node 24 / typecheck 0
- `npm run check` 全链退出 0（typecheck → drift:check → sync:check → vitest → python → setup → build → node test → drift:python）
- bench fixture：recall@5/10=0.9167、mrr/ndcg=0.9167、abstain=0.75、update_top1_ok=1.0、empty=0.25（与 after-a12 一致）
- CLI 快照：42/42 逐字节一致；真实库副本迁移 164 memories / 130 embeddings / 752 access_log 守恒
- 隔离：Python 套件、vitest、bench、figures-smoke 跑完后 `~/.unified-memory/` **零新增文件**
- 结构指标（B5.3 后实测）：memory.py **119**；surface/cli.py 232；app/ 合计 1962；promoter.py 1055、conflict.py 619 未动（B5.4）；>600 行文件 2 个（promoter/conflict）；>60 行函数 8 个

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

## B5.4 / B5.5 未完成：接手说明（2026-10-29 收工点）

B5.2、B5.3 已入库并全绿；B5.4（promoter/conflict 拆分 + cron 搬迁）与 B5.5（预算门 + 清空白名单）**未动**。下面是本轮实际探查到的结论，接手者可直接照做，不必重走弯路。

### 为什么停在这里

- 剩余两项都是"拆 1000 行级文件 + 改全部调用面"，单步风险高；本轮已连续完成 6 个模块搬迁，继续硬推会把工作树留在半红状态，违反"每个提交独立全绿"。
- 已确认的三个技术障碍（见下）需要设计决策，不是机械操作；按任务书"方案有歧义 → 停下写明"，此处停下。

### 障碍 1：conflict.py 不能按函数边界机械切分

`describe()` / `split_change()` 是纯函数，但它们依赖的五个正则常量（`_BULLET`、`_PROVENANCE_TAIL`、`_RECORDED_AT`、`_SOURCE_IN_STAMP`、`_WIKILINK`）定义在**队列 I/O 段内部**（第 434–441 行，夹在 `read_conflicts` 与 `describe` 之间）。按"纯函数留 domain"直接切行会得到一个缺常量的 domain 模块。

**建议方案**：先把这五个正则与 `_BOUNDARY` / `_SNAP_LIMIT` 一起上移到 `domain/markdown.py` 或新的 `domain/conflict.py` 顶部，再切分；切完用 `python -c "import unified_memory.domain.conflict"` + 现有 457 例验证。**放弃方案**：在 domain 里重复定义常量（两份真相，迟早漂移）。

### 障碍 2：promoter.py 的 1055 行不是四个独立块

`promote / review / decide / cron` 共享一组模块级状态：`CATEGORY_RULES`、`DECISIONS`/`ADVISABLE`、`_pending_path`、`plan_promotion` 的返回结构，以及 `_refresh_index`/`mark_schedule_run` 的调用时序（B4 明确要求"apply 之后再刷"）。直接按函数名切会把共享常量撕成两份。

**建议方案**：先切出 `domain/policy` 已有的分类规则（`CATEGORY_RULES` 可整体下沉 domain），再按"plan / execute / adjudicate / schedule"四块切，每切一块跑一次七道门。**放弃方案**：只做文件搬家不改结构（对 B5.5 的 450/600 行预算没有帮助）。

### 障碍 3：register_cron 搬进 infra/schedule 会遇到反向依赖

`forgetter.register_cron` 需要 `forgetter.forget_dir(vault)` 来算 `.bat` 落点；直接 import 会形成 `infra.schedule → forgetter → infra.schedule` 的环。

**建议方案**：把 `register_cron` 改成 `infra.schedule.register_job(*, name, module, vault, schedule, log_path, work_dir)` 的通用形式，由调用方（forgetter/promoter）传入路径与调度参数；这样 schedule 不认识任何业务模块，subprocess/write_bytes 白名单可一次清空两条。**放弃方案**：在 schedule 里 import forgetter（环）。

### 当前白名单（B5.3 收工态，接手时照此收敛）

| 规则 | 剩余条目 | 清除条件 |
|---|---|---|
| sqlite3 | `sessiondb` | 移到 `infra/sessiondb.py` |
| writes | `conflict`、`forgetter`、`promoter`、`sessiondb` | 前三个的写盘改走 `infra.vault.apply`；sessiondb 随搬家 |
| subprocess | `app.maintain.drift`、`forgetter`、`promoter` | drift 的 `--git-precommit` 保留例外；后两个随障碍 3 |
| lazy_import | `app.ingest.digest`、`app.maintain.drift`、`app.maintain.health`、`embed`、`maintenance`、`promoter`、`search`、`app.query.commands` | 前三个是可选依赖/环，需逐条判定；`app.query.commands` 随 HTTP 客户端搬进 `app.remote` |
| third_party | `app.maintain.drift` | PyYAML 例外，B0 已批准 |
| layers | `app.govern.commands`、`app.ingest.commands`、`app.ingest.digest`、`app.query.commands`、`app.query.preview`、`app.system`、`app.maintain.drift`、`app.maintain.health` | 随 B5.4 把 promoter/conflict/search/index/embed 搬进 layers |

### 预算门（B5.5）现状

`ENFORCE_BUDGETS` 仍为 `False`。翻 True 前必须解决：`promoter.py` 1055 行、`conflict.py` 619 行（>600 硬限），以及 8 个 >60 行函数（`health.doctor` 207、`build_parser` 155、`search_index.update_memories` 141、`promoter.review` 132、`search.hybrid_search` 102、`infra.lock.file_lock` 94、`drift.main` 86、`store/schema._ensure_schema` 75）。

## 删除清单


- B3：三处重复的围栏拼装实现（render_hybrid / print_memory_data / cmd_show 各自的报头+标签常量），合并进 `domain/envelope.py`。
- B4：三个 canonical 写者各自的内联 `with file_lock` 写入块（promote/demote/repair），合并进 `infra/vault.apply` 唯一执行器；`atomic_write` 的无 fsync 版本。
- B5.1：`promoter.decide` 里的 DECISIONS 成员校验（改走状态机）。
- B5.2（阻塞回滚）：无删除——拆分件完整保存在 `../attic/b5.2-prepared.tar.gz`，解阻塞后解包即得。
- B5.2：`memory.py` 的 1305 行实现（argparse 语法、dispatch、22 个命令体、内置模板常量、vault 引导、`emit_json`）全部搬走；`emit_json` 的旧定义从 memory.py 删除（改由 `infra.console` 提供）；`surface/cli.py` 里对 `infra.config` 的直接依赖删除（`VaultMissing` 经 `app.system` 再导出）。
- B5.3：`drift.py`(445)、`digest.py`(314)、`health.py`(322)、`preview.py`(245)、`stats.py`(130)、`inbox.py`(115) 六份实现搬进 layers，旧路径只留显式 re-export shim（合计 118 行）；`graph.py` 按任务书保留 legacy facade，未动。
- 维护轮：`~/.unified-memory/journal/*.jsonl` 487 个（816 KB）+ `index-*.db` 44 个（5.1 MB）移入 `_cleanup-backup-20261029-014758/`（531 文件 / 5.94 MB，可整体还原）；备份确认无误后可删该目录。`scripts/` 下两个 smoke 辅助文件改为忽略，不再产生未跟踪文件。


## bench 前后对比

见"验证基线"；每项若影响检索路径则附前后数据。

## 已知风险

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

解除后：解包 `attic/b5.2-prepared.tar.gz` 到 `core/unified_memory/`，按 §9 顺序做 B5.3–B5.5，每步 `bash ../verify.sh`。

## 待办发现

1. **Mimosa SSRF 规则与本项目迁移冲突**（本批次最大发现）：任何新建/改写的 .py 含 `urllib`/`urlopen`/动态 URL 即被整文件拦截，导致 embed/digest/memory 三个含出站调用的模块无法物理迁移。解除路径三选一，见"阻塞记录"节。
2. `~/.unified-memory.yaml` 曾被某次 e2e 测试指到临时目录（`Temp\uam-e2e\vault`），2026-10-27 已改回真实 vault（索引哈希 `71a04777…` 核对确认）。建议测试框架避免测试直写用户全局配置。**2026-10-29 复检**：配置仍指向真实 vault、mtime 停在 2026-10-27，未复现；同期发现并修掉了 journal 与两处索引库的同类泄漏（见"维护轮"）。
3. 用户 vault 的 git 仓库有 **427 个未提交变更**、`.githooks` 为空——做任何"以 git 为记忆事务日志"类功能前必须先清基线。
4. `README.md` 被 canonical 索引收录（7 条事实行）——模板说明文件混进了事实库，可考虑在 indexed_files 里排除。

## 建议的下一批次方向

1. **解除 Mimosa SSRF 阻塞后先做 B5.2–B5.5**（拆分件已在 attic，`BATCH-B-HANDOVER.md` §9 有三步顺序）。
2. 之后进入批次 C：Claim Ledger（block ID + 双时间 + as-of）、abstain 置信下限、`PROTECTED_RE` 收敛为白名单（三项均在总方案 §7 缺陷清单）。
3. 独立小批：若扫描器未解除，embed/digest 迁移可用"新增文件不含 urllib、由既有文件继续承担 HTTP"的折中——需先评审。
