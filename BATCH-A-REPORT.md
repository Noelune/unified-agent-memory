# BATCH-A-REPORT — 第一阶段（止血）交付报告

- 分支：`fix/batch-a`（基于 `main` @ `3697909` / v0.8.8）
- 提交：14 个（A0–A12 各一 + 1 个迁移顺序修复），列表见文末
- 日期：2026-10-27
- 结论先行：**12 项全部完成，全部有测试与 bench 前后对比；其中"现场迁移验证"还额外抓到并修掉了一个会让所有真实 0.8.8 升级直接崩溃的顺序 bug。**

---

## 1. 逐项交付：做了什么、删了什么

| 项 | 提交 | 做了什么 | 删除了什么 |
|---|---|---|---|
| A0 | `afd0024` | `bench/snapshot_env.py` + 环境基线 JSON（对 vault 副本建索引，不碰真实 vault） | — |
| A1 | `d63e2a9` | golden set v0：确定性合成 vault（16 条人工标注，覆盖 7 类）+ 真实 vault 派生标注（64 条）+ 确定性评测器（offline/latency 双通道） | "无任何 benchmark"状态 |
| A2 | `cd2d82e` | schema 迁移改增量：`MIGRATIONS` 注册表 + 单事务 + 失败回滚 + `.v<n>.bak` 备份；降级库不碰 | `_migrate_schema` 的全表 DELETE 分支（升级即失忆） |
| A3 | `090934a` | `encode_untrusted`（`<`→`\u003c`）统一围栏；show 文本路径补围栏；recall query echo 编码；200 条模糊测试 | 3 处各自拼围栏的重复实现 |
| A4 | `56b2e8f` | occurrence 身份：`id = sha256(doc␟line)`，`text_hash` 做跨文档查重，v5 迁移折叠遗留重复并重映射 access_log/embeddings | `sha256(text)` 主键（跨文档同句静默合并、删一篇丢另一篇） |
| A5 | `a5f90e8` | 跨文档冲突候选：review() 先刷索引，词法 top-20 全库候选，同 subject/value 规则判定；队列带 `跨文档` 字段 | "冲突只在目标笔记里找"的盲区 |
| A6 | `196800e` | review() 返回 `conflicted_sources`；auto_promote 只归档无冲突来源，verbose 报告 held 数 | 无条件 `archive_sources(source_files)` |
| A7 | `7ac40fb` | 审计链：`prev_hash/entry_hash`（v6 迁移），submit/promote/decide/forget/repair/digest 全接入；`memory audit [--verify]` | 定义了但零调用的 `record_audit`（audit 表永远为空） |
| A8 | `d0bc3cf` | 词法收敛：`fts_lex` 一张表（ASCII 词 + CJK bigram）服务双语；三路融合（lexical/vector/graph），三元权重；v7 迁移回填并删旧表 | `fts_mem`（unicode61，中文恒 0 命中却拿最高权重）、`fts_mem_tri`、`fts_mem_bigram`、两个检索函数、test_trigram/test_hybrid_trigram |
| A9 | `bd5f2cc` | 图流门控：`score ≥ 0.5×top`、度归一化扩展、`ceil(2.5×直击数)` 上限、无直击返回空；图改纯内存计算；v8 迁移删表；doctor/gc 移除图项 | `graph_nodes`/`graph_edges`（5000 条只写不读的边）、build_graph、graph-bloat 告警、gc 的图重建块 |
| A10 | `f305a6b` | 预算按价值密度装填（skip-and-continue），头尾排布（最好置首、次好置尾），`budget: {usedTokens,dropped,truncated}`，compact 标 `truncated` | 到达顺序 `break` 截断（一条长记忆饿死后面全部） |
| A11 | `1374c2b` | 热路径：`QUERY_TIMEOUT_S 0.8→0.12`；缓存键改"概念袋"（CJK 字符袋 + ASCII 词袋 + model id），v9 迁移加 `query_cache.model_id` | 精确字符串缓存键（7 天 23 条命中率） |
| A12 | `6b3bfc7` | retrieved/used 拆分（v10 加 `access_log.event`）；围栏事实带 `[10位短id]`；模型回显引用 → recall 钩子检测 → `memory cite --ids` 记 used；遗忘强化只读 used | "检索即强化"的正反馈环（752 条 access 全算表扬） |
| 补 | `8e36e47` | **现场迁移验证抓到的 bug**：`_ensure_schema` 在 v5 加列前就建 `idx_mem_text_hash`，真实 0.8.8 库升级必炸 `no such column`；改为容错 + v5 内补建索引；新增"真 v4 旧形状库"回归测试 | — |

## 2. 验证结果

### 2.1 测试（全部绿）

| 套件 | 基线 | 现在 |
|---|---|---|
| Python（core） | 389 OK | **432 OK**（新增 43：迁移 6、围栏 fuzz 8、occurrence 6、跨文档 4、归档 3、审计 6、词法 9、预算 4、热路径 5、反馈 6，减去被替换的 trigram 套件） |
| JS（vitest） | 879 passed | **886 passed**（41 文件） |
| setup 套件 | 32 OK | 32 OK |
| typecheck（tsc） | OK | OK |

### 2.2 检索质量与延迟（bench/run.py，确定性 offline 通道 + 网络通道）

| 指标 | baseline-v0 | after-a12 | 说明 |
|---|---|---|---|
| fixture recall@10 | 0.9167 | 0.9167 | 持平（词法收敛未伤召回） |
| real recall@10 | 1.0 | 1.0 | 持平 |
| fixture nDCG@10 | 0.9167 | 0.9167 | 持平 |
| abstain 准确率 | 0.75 / 0.40 | 0.75 / 0.40 | **未变**——abs 弃答下限不在本阶段 12 项内（属总方案 O4），见 §4 |
| offline p95 延迟 | 105.7 / 104.9 ms | **34.5 / 36.8 ms** | 三表→一表、五路→三路的直接收益 |
| 网络 p50 / p95（噪声大） | 105.6 / **1029.3 ms** | 34.7 / **335.7 ms** | 0.12s 预算 + 概念袋缓存 |

### 2.3 现场迁移验证（任务书完成定义 #3）

`bench/verify_live_migration.py`：把本机 0.8.8 写的真实索引库（`index-71a04777…db`，6.6MB）复制后用批次 A 代码打开：

```text
before: memories 149 / embeddings 142 / access_log 752 / version "4"
after:  memories 149 / embeddings 142 / access_log 752 / version "10"
backup .v4.bak 存在；MIGRATION OK
```

**这次验证本身抓到了一个真 bug**（提交 `8e36e47`）：`_ensure_schema` 先于 v5 迁移创建 `idx_mem_text_hash`，真实旧库升级必然 `no such column: text_hash` 崩溃。测试夹具此前全是"新代码建库 + 改版本号"，测不出这条路径；现场副本一跑就现形。已修 + 回归测试（真 v4 旧形状建表 → get_conn 迁移成功）。

### 2.4 删增账目（core/unified_memory，13 文件）

+928 / −440 行，净 **+488（7994 → 8475）**。任务书完成定义第 5 条"core 不净增（≤7900）"**未达成**，原因如下，交由评审裁决：

- 净增的主体是**永久性基础设施**：迁移框架（~150 行）、哈希链审计 + CLI（~140）、跨文档冲突（~50）、occurrence 迁移与折叠（~80）、引用反馈（~90）。这些不是批次 B 能"搬走"的代码。
- 任务书同时要求的删除项（两张 FTS 表 + 两个检索函数 + 图两张表 + build_graph + 审计死代码 + 三处重复围栏）已全部删除（−440 行），但删除量被新增的防线抵消。
- 大头减法在批次 B：12 个模块的直接 SQL 收口进 `infra/store`、三套格式化收成 Evidence、三个写者合成 executor 时才会发生。**若坚持行数红线，可在批次 B 完成后回头核账。**

### 2.5 表数量

主表：13 → **9**（docs、index_meta、fts、fts_lex、memories、embeddings、query_cache、access_log、audit；FTS5 影子表为内部实现）。删除：fts_mem、fts_mem_tri、fts_mem_bigram、graph_nodes、graph_edges。

## 3. 与总方案的偏差记录

1. **弃答下限（总方案 O4 的 score floor）未做**——任务书 12 项里没有它，abstain 指标维持基线。属下一批最小改动。
2. **遗忘保护收敛（PROTECTED_RE 75.5%）未做**——同上，在总方案 §7 缺陷清单里但未列入本任务书。
3. **`memory use` 命名冲突**：新命令最初叫 `use`，与既有的 `memory use <vault>`（切换 vault）冲突，测试套件当场抓到，已更名 `memory cite`。
4. **A12 的 used 采集是保守实现**：只有模型回显 `[短id]` 才记 used（提示词未改动，所以回显率取决于模型自觉）。这意味着 used 事件初期偏少——方向是安全侧（强化只会更难得到，不会乱发），但若实测回显率过低，需要在批次 B 的 Recall Compiler 外挂里做实体级匹配。
5. **0.12s 超时是 per-socket-op 语义**：urllib 的 timeout 不覆盖总时长，bench 网络通道里仍观测到一次 1581ms 尾延迟（p95 336ms 已达标）。硬墙钟需要批次 B 的 provider 层。

## 4. 移交清单（给批次 B 的输入）

- `bench/`：golden set（fixture 16 + real 64）、`run.py`（offline/latency 双通道）、`baseline-v0.json` / `after-a12.json`。
- 依赖方向测试（`test_architecture.py`）与 `infra/store` 收口是批次 B 第一步；本批次把 `sqlite3` 的直接使用仍留在各模块（与基线一致），未做搬移。
- 批次 C 需要的钩子已就位：occurrence id、`text_hash`、`legacy_id`、审计链（Claim/Occurrence/Link/Event 的 SQLite 骨架可在 v10 之上继续增量迁移）。
- 真实 vault 尚未升级（升级 = 用户在真实环境跑一次任意检索触发迁移，已验证安全且有 `.v4.bak` 兜底）。

## 5. 提交列表

```text
8e36e47 fix(schema): create the text_hash index only when the column exists (A12 addendum)
6b3bfc7 feat(feedback): split retrieved from used — only citations reinforce (A12)
1374c2b perf(embed): 120ms hot-path budget + concept-bag query cache (A11)
f305a6b fix(search): budget fills by value density; head-tail placement (A10)
bd5f2cc refactor(graph): gate the concept stream, drop the write-only graph tables (A9)
d0bc3cf refactor(index): one lexical table for both languages (A8)
7ac40fb feat(audit): wire every write path into a hash-chained audit log (A7)
196800e fix(promoter): auto_promote no longer archives conflicted sources (A6)
a5f90e8 feat(promoter): cross-document conflict candidates (A5)
56b2e8f fix(index): occurrence identity — a fact belongs to its note (A4)
090934a fix(envelope): vault text can no longer close <memory-data> early (A3)
cd2d82e fix(schema): incremental, transactional migrations — never wipe learning data (A2)
d63e2a9 bench: golden set v0 + deterministic evaluator + baseline-v0 (A1)
afd0024 bench: add environment baseline capture (A0)
```
