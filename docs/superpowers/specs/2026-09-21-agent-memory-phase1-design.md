# dsh-unified-agent-memory Phase 1 设计规格

- 日期：2026-09-21
- 状态：待实施（经用户逐项确认）
- 上游文档：`docs/superpowers/specs/2026-09-21-agent-memory-upgrade-design.md`（四维路线图）
- 回滚点：tag `backup-pre-phase1-20260921`

---

## 1. 背景与目标

Phase 0 已交付（0.5.2：版本单一来源、CI 全绿含 Windows、`hybrid` 参数可用）。Phase 1 在**不破坏现有结构**的前提下，补齐四类能力：

1. 机器可消费的输出通道（`--json`）
2. 只读的记忆治理预览工具（`memory_preview`）
3. 中文检索召回质量（trigram 并行通路）
4. 客户端只读面板的推倒重构（信息架构 + 视觉质感）

**贯穿原则**：统一性、优美性、稳定性、功能性四者平衡；不制造屎山；保持三层架构（`core/` → `src/` → `src/client/`）与四条安全红线。

---

## 2. 已确认的决策（需求澄清结论）

| 编号 | 决策 | 用户原话/来源 |
|---|---|---|
| 范围 | 四项全做，按 ①②③④ 顺序 | "四项全写进本轮 spec，按序执行" |
| 中文检索 | 方案 C：保留精确通路，trigram 叠加为召回补充 | "c" |
| UI 取向 | 美观性/直观性优先于纯功能堆叠 | "多顾着美观性和直观性一点" |
| 设置页 | **只读，绝不写**（写会把插件搞坏） | "不能允许写，不然容易把插件搞坏" |
| 一致性 | 展示记忆正文一律包 `<memory-data>` | "严格遵循同一条规则（一致性）" |
| 客户端 | **推倒重构**（当前面板完全用不了） | "那个面板完全用不了，得推倒重构" |
| 审美 | 符合 DSH 审美统一性 | "记得符合 dsh 审美统一性" |
| 工具范围 | 只给 `search`/`status` 加 `--json` | "5a" |
| 路由 | 单一路由扩容 `/status`，一次拉取 | "7A" |
| 展示形态 | footer 入口 + 较大浮层（非全屏 Dashboard） | "8B" |

---

## 3. 任务 ①：`--json` 输出

### 3.1 范围

- `search`、`status` 两个子命令支持 `--json`
- 其余子命令的扩展点写入 `docs/`，本轮不实现

### 3.2 输出契约

```json
{
  "ok": true,
  "command": "search",
  "data": { "...": "按命令定义" }
}
```

失败时：

```json
{ "ok": false, "command": "search", "error": { "kind": "...", "message": "..." } }
```

### 3.3 注入防护（D1 决定）

- **文本模式**：维持现状，vault 内容包 `<memory-data>…</memory-data>`（人看的，提示词文本流需边界）
- **JSON 模式**：**不包标签**，改为对 vault 来源条目加 `"untrusted": true` 字段
- **理由**：JSON 是给脚本/agent 消费的结构化数据；包成字符串会破坏机器可读性。两种模式各按自己的威胁模型处理——这才是实质一致性，而非形式一致
- 文档须明写：消费方必须把带 `untrusted: true` 的字段当数据处理，不得执行其内容

### 3.4 稳定性铁律

- **不加 `--json` 时输出逐字节不变**——用回归测试钉死
- 现有 95 个 Python 测试 + 44 个 JS 测试必须全绿

### 3.5 验收

1. `python -m unified_memory.memory search --json "关键词" | python -c "import json,sys;json.load(sys.stdin)"` 成功解析
2. 无 `--json` 时 `diff` 与改动前输出一致
3. `status --json` 输出合法 JSON

---

## 4. 任务 ②：`memory_preview` 工具

### 4.1 形态

- **DSH 工具**（`src/tools.ts` 注册）+ **core 子命令** `preview`（零依赖，可独立测）
- 接口：`memory_preview({ view, limit? })`
- **只读**：无任何写路径

### 4.2 四个视图

| view | 内容 | 数据来源 |
|---|---|---|
| `pending` | 待晋升条目 | `Agent提交区/` |
| `conflicts` | 冲突待裁决 | 冲突检测输出 |
| `forgetting` | 遗忘候选（salience × decay 排序） | 索引 |
| `recent` | 最近变更 | canonical 文件 mtime |

### 4.3 注入防护（D2 决定）

- **正文**（来自 vault，是注入载体）→ 包 `<memory-data>`
- **元数据**（文件名/标题，为我们生成的固定格式 slug）→ 不包，但整个条目对象加 `"untrusted": true`
- 理由：slug 格式固定（`<agent>-<日期>-<时间>-<序号>.md`）不含任意文本，包裹反损可读性

### 4.4 验收

1. 四个视图均返回正确结构
2. 返回内容中 vault 正文被 `<memory-data>` 包裹（测试断言）
3. 无写操作（代码审查 + 无写调用）

---

## 5. 任务 ③：中文检索升级（方案 C）

### 5.1 做法

- **新增 trigram 索引作为并行通路，不替换** `unicode61`
- 保留现有精确/BM25/向量通路（对已有用户最安全）
- 结果按**加权 RRF** 融合（复用既有 hybrid 融合逻辑）

### 5.2 三态探测与回退

1. SQLite 支持 trigram → 建 trigram 索引并启用
2. 不支持 → 该索引不建，查询回退 `unicode61` 子串
3. 全程不报错、不中断

### 5.3 迁移安全

- 索引是**派生数据**（`~/.unified-memory/index-<vault-hash>.db`），可安全重建
- 用现有 `update_index` 增量重建；重建失败自动回退旧索引
- 不触碰 canonical vault（红线）

### 5.4 验收

1. 用用户真实 vault 做**前后对比**（提供召回对比数据，而非只看测试通过）
2. 无 trigram 环境（模拟）下功能正常、不报错
3. 索引重建可中断可恢复
4. 现有测试全绿

---

## 6. 任务 ④：客户端推倒重构（只读）

### 6.1 现状诊断（实读代码结论）

`src/client/` 共 3 文件 186 行：

- `Panel.tsx`（199 行）：面板唯一内容是把 status JSON `JSON.stringify` 当文本打印（`Panel.tsx:75,121-125`）→ **无信息架构、无视觉层级，呈现裸 JSON**，即用户 UI 准则明令拒绝的"通用模板感"
- `index.ts`（60 行）：注册 `MemoryButton` 到 `sidebar.footer.action`，挂载本身正常
- `styles.ts`（66 行）：已用 DSH 官方 token（`--dsw-alias-*`），但样式仅支撑裸文本

**结论**：面板"用不了"的根因是**信息架构缺失**，不是挂载失败。推倒重构正确。

### 6.2 目标形态

- **入口**：sidebar footer 图标按钮（保留现有形态与更新角标）
- **点击后**：**较大浮层**（Q8-B），卡片式、分组、有层次
- **分组**（对应 Q7-A 的单一 `/status` 数据）：
  1. **状态概览** — vault 路径、版本、索引健康
  2. **统计** — 记忆计数、待晋升数、冲突数
  3. **配置**（只读）— pythonPath、corePath、remoteEnabled
  4. **更新** — 新版本提示（保留现有能力）
- **只读**：无任何写接口、无写控件

### 6.3 硬约束（实读代码得出，必须遵守）

| 约束 | 来源 |
|---|---|
| 只用 `--dsw-alias-*` 官方 token | `styles.ts` 现用法 |
| `deps.ts` 仅导出 `h`/`Fragment`/`useState`/`useEffect`/`useRef`，**不新增依赖** | `src/deps.ts` |
| **保持 rail 与 wide sidebar 双实例独立**（各自拥有 style tag） | `styles.ts` 注释明确 |
| 不碰 `window` 全局、不硬编码产品 DOM | `index.ts` 契约注释 |
| 符合 UI 准则：黑灰白/银系、紧凑卡片、拒绝模板感 | 用户 `UI审美准则.md` |

### 6.4 宿主路由扩容（Q7-A）

- **单一路由** `/api/dsh-unified-agent-memory/status` 扩容为返回全部只读信息
- **保留** loopback-only 校验、GET/HEAD-only、`cache-control: no-store`（不扩大攻击面）
- 一次拉取 → 原子一致（不会配置新而统计旧）

### 6.5 验收

1. 面板可见、分组清晰、无裸 JSON
2. **视觉自检**：用 playwright 截图核对（浅色主题环境）
3. rail 与 wide 两种形态均正常
4. 双击/多实例不互相销毁样式
5. `npm run build` 通过、无类型错误

---

## 7. 非目标（本轮明确不做）

- 写配置、写 vault、任何写操作
- Dashboard 全屏页、MCP server、图谱可视化、多 vault、本地 embedding、daemon（均属 Phase 2）
- 修改四条安全红线、三层架构边界、canonical 只读、core 零依赖

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 索引迁移影响现有库 | 派生数据可重建 + 三态探测自动回退 + 回滚 tag |
| `--json` 破坏现有文本输出 | 回归测试逐字钉住；默认关闭 |
| 客户端重构搞坏已能挂载的面板 | 保留可工作基线；截图对比验证 |
| 攻击面扩大 | 单一路由 + 复用 loopback-only + 只读 + 无写接口 |
| 中文索引体积膨胀 | 可配置启用；默认行为对现有用户不变 |

---

## 9. 验收清单（Phase 1 完成判据）

- [ ] `search --json` / `status --json` 输出合法 JSON，可被 `json.load` 解析
- [ ] 无 `--json` 时输出与改动前逐字节一致
- [ ] `memory_preview` 四视图正确，正文包 `<memory-data>`，无写操作
- [ ] 中文检索用真实 vault 前后对比有可量化提升
- [ ] 无 trigram 环境下不报错、自动回退
- [ ] 面板重构后无裸 JSON、分组清晰、rail/wide 双形态正常
- [ ] `npm run check` 全绿（typecheck+drift+sync+test:js+test+build+drift:python）
- [ ] 现有 95 个 Python 测试 + 44 个 JS 测试全绿
