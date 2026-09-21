# Phase 1 视觉自检记录

日期：2026-09-21 ｜ 执行：Task 9

## 结论（先说清楚能与不能）

| 项目 | 状态 |
|---|---|
| 构建产物（`lib/`）与真实 Python 核心 + 临时 vault 端到端联通 | ✅ 已实测 |
| 宿主路由载荷字段完整性与真实计数 | ✅ 已实测 |
| 客户端插件注册到 `sidebar.footer.action` 座位 | ✅ 已实测 |
| 面板全部 `dsh-memory-*` 类名 / 文案 / 状态变体存在于构建产物 | ✅ 已逐条核对 |
| 视觉纪律：配色全部走 `--dsw-*` 主题令牌、无硬编码颜色 | ✅ 已实测（0 hex / 0 rgb()） |
| **真实浏览器像素级截图（rail 与 wide 两种宽度）** | ❌ **未取得，见下** |

> **未能观察到的部分要说实话**：本机未安装 `react-dom`，且任务约束禁止新增依赖，
> 因此**无法在无头浏览器中真正绘制面板并截图**。上面的「已实测」是
> **结构化/文本级证据**（真实构建产物 + 真实核心 + 真实 payload），
> 不是像素级视觉确认。**外观最终仍需真人在运行中的 DSH 中目视确认。**

另外：`127.0.0.1:3081` 上运行中的 DSH 加载的是**另一个 checkout**
（见任务说明），因此该实例**不可能**反映本次改动 —— 未重启、未改配置，符合控制器 Q1 的 A 方案。

## 复现方式

```bash
cd "<repo>"
npm run build                      # 必须先构建，确保 lib/ 含最新改动
node .visual-verify.mjs            # 驱动构建产物 + 真实核心 + 临时 vault
```

脚本行为（全部为真实调用，无桩数据）：

1. 建临时 vault（`50-Agent-Context/` + `Agent提交区/`）。
2. 用**真实 Python 核心**（`python -m unified_memory.memory status --json`）初始化并读取。
3. 以真实 `host.apply(ctx, {vaultPath, pythonPath, corePath})` 注册，
   直接调用真实 `/status` 路由处理函数，捕获响应体。
4. 用 `window.__ModuleLoader__` 壳加载**真实构建的** `lib/client-ui.js`，
   调用其 `apply(ctx)` 捕获注册进 `slots` 的组件。
5. 对构建产物做类名/文案/令牌的逐条核对。

## 实测输出（节选，完整见 `phase1-visual-check-evidence.txt`）

宿主半边：

```
host tools        : ["memory_search","memory_show","memory_submit","memory_status","memory_preview"]
host route        : /api/dsh-unified-agent-memory/status
payload keys      : ["ok","configured","vaultPath","pythonPath","corePath","remoteEnabled",
                     "version","latestVersion","updateAvailable","index","stats"]
payload.stats     : {"memories":1,"vectors":0,"pending":1}
payload.index     : {"ok":true}
```

客户端半边：

```
client module id  : dsh-unified-agent-memory
client plugin keys: ["apply","inject","name"]
slot seat         : sidebar.footer.action / dsh-unified-agent-memory
registered type   : function
```

面板核对（19/19 通过）：

```
OK  dsh-memory-sheet      OK  dsh-memory-card-title   OK  dsh-memory-stat
OK  dsh-memory-head       OK  状态概览 / 统计 / 配置（只读） / 更新
OK  Unified Memory        OK  dsh-memory-kv          OK  dsh-memory-dot
OK  --dsw-alias-ok / --dsw-alias-warn / --dsw-alias-err
OK  dsh-memory-trigger    OK  rail / row             OK  —
OK  Counts unavailable
```

配色纪律：

```
--dsw-* tokens   : 14   ["--dsw-alias-label-secondary", … ,"--dsw-alias-ok","--dsw-alias-warn"]
hard-coded hex   : 0    []
rgb()/rgba()     : 0    []
```

构建产物中全部 `dsh-memory-*` 类：

```
badge, card, card-title, dot, head, kv, note, sheet, stat, stats, title, trigger, ver
```

## 对 spec §6.3 与用户 UI 准则的逐条核对

| 约束 | 结论 | 依据 |
|---|---|---|
| 黑灰白 / 银系 | ✅ | 14 个令牌全部为 `--dsw-alias-*` 语义色，无硬编码 hex/rgb |
| 卡片层次 | ✅ | 面板 = sheet › 4×card（状态概览/统计/配置（只读）/更新），card 内 kv/stat 分栏 |
| 无裸 JSON | ✅ | 全部字段经 `show()` 格式化；不可用值渲染为 `—`，不打印原始对象 |
| 深色按钮白字（对比度） | ⚠️ **未能视觉确认** | 触发按钮用 `--dsw-alias-label-secondary` → hover/active 切 `--dsw-alias-label-primary`，语义正确；**实际对比度需真人目视** |
| rail / wide 两种宽度 | ⚠️ 部分 | 两分支的 `data-wide` 值为 `rail` / `row`，字号 16/14 均在产物中；**两宽度的真实布局未视觉确认** |
| 缺失值不等于 0 | ✅ | `stats === null` 时三个数字位渲染 `—`，并附注 "Counts unavailable — the memory core did not answer." |

## 诚实声明

- 本项目**没有**做成真实截图。若评审需要像素证据，请在**加载本 checkout 的**
  DSH 实例中打开侧边栏内存按钮，分别以 rail 与 wide 宽度展开面板截图。
- 本记录中的「已实测」一律指：真实构建产物 + 真实 Python 核心 + 真实注册路径的结构化证据。
