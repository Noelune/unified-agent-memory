# 插件更新的漂移、兼容与平滑升级设计

> 日期：2026-10-20 ｜ 状态：已实现 ｜ 对应版本：0.8.1
> 相关代码：`src/upgrade.ts`（规划器）、`src/upgrade-run.ts`（唯一写入点）、`src/upgrade-boot.ts`（启动接线）

## 1. 问题：一次升级不是一件事，是四件

`dsh plugin update` 只做一件事：把 npm 包的新 `lib/` 和 `core/` 放到磁盘上。
但插件的「安装」分散在四个地方，其中只有第一个是 npm 管的：

| # | 工件 | 谁写的 | 升级时会被替换吗 |
|---|---|---|---|
| 1 | `lib/`、`core/`（代码） | npm | 会 |
| 2 | `~/.unified-memory/bin/memory`（CLI shim） | `memory_setup` | **不会** |
| 3 | `~/.dsh/AGENTS.md` 等的托管段（给 Agent 的规则） | `setup/deploy.py` | **不会** |
| 4 | vault 里的模版文件与 `前缀登记.md` | `memory_setup` | **不会** |
| 5 | `~/.unified-memory/` 下的派生索引 | 核心首次打开时 | 会（schema 迁移） |

老用户升完级，1 是新的，2–4 全是旧的，而**没有任何机制告诉他这件事**。

## 2. 四种漂移，按「有多疼」排序

这才是设计的依据。四种失败模式的实际后果不一样，方案必须区别对待。

### 2.1 shim 指向已经不存在（最伤，且静默）

`buildShim()` 把 `corePath` 的**绝对路径**写死在 shim 里：

```bat
set "PYTHONPATH=C:\Users\...\node_modules\dsh-unified-agent-memory\core"
```

包目录一变（升级换了路径、用户换了 pnpm store、profile 重建），这个路径就指向
不存在的目录。**非 DSH 的 Agent（Codex / Claude / Hermes）调用 `memory` 时拿到
的是 `No module named unified_memory`** —— 读起来像「装坏了」，不像「shim 过期
了」。用户的第一反应是重装，而重装不一定修得好。

### 2.2 托管段是旧规则（最隐蔽）

`deploy.py` 把规则写进 `<marker>` 之间。规则本身会随版本变（0.8.1 就加了
「前缀来源」这条）。托管段不更新，就出现：**Agent 照着上一版的规则做事，工具
按这一版的行为执行**。两边都「正常运行」，但互相对不上，且任何日志里都看不到
这个矛盾。

### 2.3 派生索引是旧 schema（核心已经兜住了）

`core/unified_memory/schema.py` 有 `SCHEMA_VERSION = "4"`；不匹配时
`_migrate_schema` **清空派生表、写回版本号**，靠重扫重建。所以这一项不需要升级
流程干预 —— 但它**静默**，只在有人打开数据库时才发生。方案要做的是把它**报出来**，
让版本切换不是无声的。

### 2.4 vault 缺新模版文件（最吵）

新版本往 `vault-template/` 加了文件（这次是 `Agent提交区/README.md` 等）。老
vault 里没有，于是搜索对新文档回 `unknown document` —— 发布说明说这个文档存在，
用户却搜不到。

## 3. 设计原则

四条，都是从前面的失败模式反推出来的：

1. **规划与执行彻底分离。** `upgrade.ts` 只读盘、只产出 `UpgradePlan`，不写一个
   字节；`upgrade-run.ts` 是唯一的写入点。这样规划器可以纯函数式测试，计划也能
   在动手之前拿给人看 —— 和 `memory_setup` 的 confirm 流程同一个形状，理由也
   一样：动的是用户的文件。
2. **不删除任何东西。** vault 文件只在缺失时新增（`COPYFILE_EXCL`），托管段只在
   marker 之内重写（`deploy.py` 自己的备份 + 回滚），登记表逐行合并
   （`mergeRegistry`，绝不重写他人的行），坏掉的 shim 重新生成。**唯一被"重建"
   的是派生索引，而它按定义就是可重算的**。
3. **版本最后写。** 见 §5。
4. **启动时不阻塞、不询问、不抛。** 见 §6。

## 4. 规划器：五类工件，五种判定

`planUpgrade(probe)` 对每个工件只问一个问题，答案落进 `ok | drift | missing`：

| 工件 | 判定方式 | 为什么这么判 |
|---|---|---|
| `shim` | 读回 `PYTHONPATH=` 那一行，检查目标目录存在；再比对记录里的 `corePath` | 不重新推导「应该是什么内容」——那取决于用户配的 python 路径和平台，重新推导会把「用户手改过的合法 shim」判成 drift |
| `instructions` | 只数目标文件是否存在 | **内容比对归 `deploy.py`**，它拥有 marker 语义、围栏屏蔽、备份命名和写后校验。在这里实现第二份判定，一定会在某天和它漂开 |
| `vault` | 遍历 `vault-template/`，列出 vault 里没有的 | 只有「有 / 没有」两态，不比较内容：用户改过的模版文件是他的，不是我们的 |
| `index` | 永远报 `ok`，附一句「打开时按 schema 重建」 | 迁移是核心的职责，规划器无权断言它坏没坏；报出来只是为了让版本切换不留静默 |
| `registry` | 存在性 | 合并逻辑在 `mergeRegistry`，它自己会保持幂等 |

### 4.1 `shimTarget()` 的三个方言

第一版正则只写了两种，`PYTHONPATH=(?:"([^"]*)"|'([^']*)')`，看起来对，实际错：

```
cmd : set "PYTHONPATH=C:\path with spaces\core"    ← 引号在赋值两边
sh  : PYTHONPATH='/path/core' exec python          ← 引号在值两边
```

cmd 那一行里 `=` 后面**没有**引号，紧跟的是 `C:`。旧正则只可能匹配到 sh 形式，
于是**每一个 Windows 用户的 shim 每次启动都被判成「内容无法识别」并被重写**。
这个 bug 是单元测试抓到的，不是读代码看出来的 —— 值得记一笔：这种「在目标
平台上的分支从没被走通过」的逻辑，只有拿真实产物喂进去才现形。

修正后三个分支，cmd 那条必须排在最前且吃到闭合引号：

```ts
/"PYTHONPATH=([^"]*)"|PYTHONPATH='([^']*)'|PYTHONPATH="([^"]*)"/.exec(text)
```

## 5. 执行顺序，以及为什么版本最后写

`runUpgrade()` 的顺序是 **shim → vault → instructions → registry → state**。

- **shim 最先**：最便宜，且失败最静默。
- **vault 先于 instructions**：托管段可能引用只有这一步才创建的规范笔记。
- **state 最后**：这是整个方案的**核心不变量**。如果任何一步失败，`upgrade.json`
  不写新版本号，下一次启动看到的仍是旧版本，于是**整个 reconcile 重跑一遍**。
  反过来先写版本号，等于把一次半途而废的升级盖章成「已完成」，从此再也不重试，
  用户就永远停在那个坏状态里。

`runUpgrade()` 刻意**不接收 `UpgradePlan`**：每一步都从磁盘重新推导自己的判断
（`existing !== wanted`、`missingTemplateFiles()`、`mergeRegistry` 返回原值即无
变更）。计划是**给人看的报告**，而计划与执行之间隔着时间，vault 可能已被别的东西
动过。既然每一步都幂等，对着当前状态执行既更安全也更简单。

### 5.1 失败的步骤不阻断其它步骤

一个坏 shim 不该连累托管段刷新，反之亦然。每步独立上报，于是「半截升级」是
**可见的**（5 步里 3 步失败），而不是一片沉默。

## 6. 启动接线：三条硬约束

`startUpgradeReconcile(cfg)` 用 `setImmediate` 调度，不 `await`：

1. **绝不阻塞加载。** 一个慢的 `deploy.py` 会让每个用户每次启动的工具和面板都变慢
   —— 那比「托管段过期」是严重得多的 bug。
2. **绝不弹确认。** 宿主的 approval 服务不一定在；启动时问问题会训练用户不看内容
   就点「允许」。这一步只碰插件**在 setup 时就已经写过、且用户为此给过同意**的文件
   —— 同一批文件、同一个写入者，只是内容换了版本。同意不会因为内容更新而失效。
3. **绝不把异常抛给宿主。** 任何失败都吞掉（`runUpgrade` 自己按步上报，外层
   `catch` 兜住它没预料到的 throw）。坏掉的升级不能顺手把用户的工具也弄丢。

### 6.1 首次安装必须让给 `memory_setup`

```ts
if (plan.fromVersion === null && probe.vaultPath === null && !existsSync(join(home, '.unified-memory'))) {
  // 交由 memory_setup
}
```

否则一台从没配过的机器上，第一次启动就会生成一个指向「还没配的 vault」的 shim，
并且**替用户把 setup 的同意流程跳过去了**。这台机器上的三个条件必须同时成立才算
「首次安装」：没有版本记录、没有 vault、没有 `~/.unified-memory` 目录。

## 7. 状态记录

`~/.unified-memory/upgrade.json`：

```json
{
  "version": "0.8.1",
  "corePath": "C:\\...\\dsh-unified-agent-memory\\core",
  "installPath": "C:\\...\\dsh-unified-agent-memory",
  "appliedAt": "2026-10-20T02:30:00.000Z",
  "changed": ["shim", "vault", "instructions", "registry"]
}
```

`corePath` 是下一轮 `installMoved` 的唯一依据 —— 它是「shim 可能已经指向死路径」
的最强预测信号。`changed` 让人能回答「上次升级到底动了什么」。

**读不出来一律当作首次运行。** 一个被截断的 JSON 最坏后果是多重跑一次无害的
reconcile（和全新安装跑的是同一趟）；因为一个 JSON 文件解析失败就拒绝启动，那才
是不可接受的。

## 8. 面向用户的两处出口

- **`/status` 的 `upgrade` 字段**（`UpgradeInfo`）：`fromVersion` / `toVersion` /
  `needsAttention` / `problems`（最多 3 条，面板只有 380px 宽）/ `done`。首次规划
  之前是 `null`，客户端必须渲染成「检查中」而不是「失败」。
- **`summarizePlan()`**：一行话，给日志、工具结果和面板共用。版本没变、只有工件
  要修时**不打印 `0.8.0 → 0.8.0`** —— 那读起来像一次没发生的迁移。

## 9. 今后的迭代怎么复用这套东西

对新版本的要求只有三条，都不需要改升级代码：

1. **往 `vault-template/` 加文件** → 自动被 `missingTemplateFiles` 发现并补建。
2. **改托管段规则** → 自动被 `deploy.py apply` 重写（它自己带备份和回滚）。
3. **改 `SCHEMA_VERSION`** → 自动被核心迁移，规划器自动报出来。
4. **包目录变了** → `upgrade.json` 里的 `corePath` 对不上，shim 自动改指。

唯一需要人做的事：**改 `package.json` 的 version**。`upgrade.json` 里的版本是
唯一的「已应用」凭据，所以发版流程本身成了升级流程的触发器。

## 10. 未验证项 / 后续

- 目前只在 Windows 上跑过真实 `reconcile`。POSIX 的 shim 分支有单测覆盖
  （`sh` 方言、`chmodSync 0o755`），但没有在真机上升级过一次。
- 首次升级的**用户感知**还没做：现在只在 `/status` 里出现，健康页/统计页没有
  对应的视觉位。计划是「有 `needsAttention` 时在健康页给一条可展开的行」，与
  `upgrade` 卡片复用同一套 `problems` 文案。
- `deploy.py` 的 60s 超时是拍的。慢磁盘 + 大量目标文件时可能不够，失败会被记成
  一步失败并在下次重试，不会损坏数据，但值得按实测调。
