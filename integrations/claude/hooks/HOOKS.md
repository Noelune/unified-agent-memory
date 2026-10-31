# Claude Code 钩子接入（批次 E2）

把 unified-agent-memory 的三个生命周期事件（会话开始注入 / 每轮按需检索 /
会话结束沉淀）接进 Claude Code 官方钩子。钩子是**机制强制层**：上下文注入
不依赖模型自觉——这是与 `CLAUDE.md`（模型自主兜底）的关系，一句话：钩子管
"自动发生"，CLAUDE.md 管"模型怎么对待注入的数据"。

## 接入方式

### 默认启用（0.9.1 起，推荐）

```bash
python setup/setup.py hooks          # 安装（幂等，重复执行无副作用）
python setup/setup.py hooks --remove # 摘除我们的三条钩子（不动你的）
```

`setup init` 现在也**默认安装**钩子（`--no-hooks` 跳过）。安装 = 把我们的三条
钩子**追加**进 `~/.claude/settings.json`（首次写入前自动备份为
`settings.json.bak-<时间戳>`；你的已有钩子原样保留；无法解析的 settings 文件
绝不触碰并提示手工合并）。

### 手动接入（等价方式）

1. **确认前置**：`python`（≥3.11）在 PATH 上；知道本仓库的安装路径（下称
   `<REPO>`）。
2. **粘片段**：打开 `integrations/claude/hooks/settings-snippet.json`，把
   其中的 `${CLAUDE_PROJECT_DIR}` 全部替换为 `<REPO>` 的绝对路径，然后把整个
   `"hooks"` 对象粘进 `~/.claude/settings.json`（已有其他钩子时**合并**进各
   事件数组，不要覆盖别人的钩子；`_about` 键粘完即删）。
   - SessionStart **不设 matcher**：startup/resume/clear/compact 全触发——
     compact 后重注入是特性不是浪费（包很小，≤2400 字符预算）。
   - UserPromptSubmit 带 `"timeout": 30`（秒）；SessionEnd 带 `"async": true`
     （官方文档：SessionEnd 全体钩子共享 1.5s 预算，async 不阻塞退出）。
   - 为什么用 exec 形式（`command` + `args` 数组）而不是 shell 字符串：
     免引号转义，Windows 上 Git Bash 与 cmd 的引号差异全部绕开。
3. **设环境变量**（用户级，Claude Code 启动时继承）：
   - `UNIFIED_MEMORY_VAULT`：vault 绝对路径（core 既有约定；未设时回落到
     `~/.unified-memory.yaml` 的 `vault:`）。
   - 可选：`UNIFIED_MEMORY_HOOK_RECALL_MODE`（`auto|always|off`，默认 auto，
     与 dsh recall 配置名对齐）、`UNIFIED_MEMORY_HOOK_MAX_CHARS`（默认
     2400）、`UNIFIED_MEMORY_HOOK_TIMEOUT_MS`（默认 5000）。

手工冒烟（不启动 Claude Code 直接验证脚本）：

```bash
echo '{"prompt": "同步端口是多少"}' | python <REPO>/integrations/hooks/memory_hook.py prompt-submit
```

应输出一个 `<memory-data>` 块（vault 未配置/无命中/不敏感时静默——空输出
也是合法结果）。

## 验证钩子已生效

`claude --debug` 启动，debug log 里找 `Hooks: SessionStart … finished with
status 0` 行（官方 debug 形态）；会话内问一句记忆敏感问题（如"上次配置的
同步端口是多少"），回答应引用包内事实。auto 模式下普通技术问题不触发检索
（省时省钱，这是特性）。

## 失败排查

- 钩子在任何异常下 exit 0——**它不会炸你的回合，只会"少包"**：
  session-start 少了常驻包，prompt-submit 少了 recall 块。
- 看不到包时按序检查：
  1. 手工跑一遍：`echo '{}' | python <REPO>/integrations/hooks/memory_hook.py
     session-start`，看 stderr 的 `[memory-hook]` 提示（vault 未配置、
     Python 不在 PATH 等）；
  2. `UNIFIED_MEMORY_VAULT` 是否指向**已初始化**的 vault（目录存在且含
     `50-Agent-Context/`）；
  3. 钩子状态目录（默认 `~/.unified-memory/hooks/`，env
     `UNIFIED_MEMORY_HOOK_STATE` 可改）是否可写；
  4. `claude --debug` 确认钩子被调用且 status 0——status 0 但无输出 = auto
     门判定不敏感或无命中，属正常行为不是故障。
- **SessionEnd 在硬崩溃时可能不触发**（官方文档事实）：写侧沉淀因此仍以
  cron 归档 digest 为兜底，钩子队列（`digest --queue`）是"及时性"增强，
  不替代 cron。

## 测试

`core/tests/test_claude_hook_wiring.py` 是"文档与脚本不漂移"的守卫：它读取
`settings-snippet.json` 并**原样执行**其中的命令行（替换
`${CLAUDE_PROJECT_DIR}` 为仓库根）跑三种事件——文档里写的命令就是测试跑的
命令。
