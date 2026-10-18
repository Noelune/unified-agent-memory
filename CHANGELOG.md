# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added — 首次引导 + 多 Agent 自助接入

- **`memory_setup` 工具（第六个工具）**：装完插件后的第一次使用不再需要克隆仓库、
  也不需要 `postinstall`（pnpm 与插件市场都会拦），因为 core、`setup/setup.py`、
  `setup/deploy.py`、vault 模版本来就在 npm 包里——缺的只是一个会调用它们的入口。
  `memory_setup` 默认**只返回计划不写盘**（建/复用哪个 vault、改哪些已存在的指令文件、
  写哪些附属产物、全程本地不上传不联网），同意后才执行：建/复用 vault → 注入托管段
  （时间戳备份 + 原子替换 + 幂等）→ 写 CLI shim `~/.unified-memory/bin/memory[.cmd]`
  → 在 `50-Agent-Context/Agent提交区/前缀登记.md` 登记本端前缀 → `selfcheck`。
- **同意是显式的、可撤回的、不可伪造的**：走 DSH 原生审批通道（`ctx.approval`）时弹窗
  允许才继续，并把授权落盘（`~/.unified-memory/onboarding.json`，记录 vault 与 scope，
  换 vault 需重新授权）；审批被禁用/无应答方时**不会假装同意**，必须显式 `apply: true`，
  且这次**不写授权记录**，下次仍会再问一次。拒绝时一个字节都不写，`memory_status`
  照常可用只是报「未配置」，手动 `setup.py init` 的旧路径仍然有效。
- **多 Agent 共享同一个框架（不是每个人各装一份插件）**：插件只能自动接管它自己所在的
  运行时，其余运行时通过 ①vault 内的协作规则说明（读哪里、写哪里、前缀怎么定）与
  ②稳定的 CLI shim 接入；shim 不依赖 Python 是否在 `PATH`，也不依赖 checkout 路径。
- **`/status` 载荷新增 `agentName`、`agentSource`、`onboarding`**：`agentSource` 取值
  `config`/`env`/`profile`/`fallback`，其中 `fallback` 表示既没配 `agentName` 也没有
  `DSH_PROFILE`（多端会写成同一个前缀，属可见告警）；`onboarding.granted` 按**当前
  vault** 判定，换 vault 即回到未引导。见 [docs/JSON-CONTRACT.md](docs/JSON-CONTRACT.md) §6。
- **`setup/deploy.py` 的前缀解析**：新增 `resolved_prefix()`，`dsh` 读
  `UNIFIED_MEMORY_AGENT`（由插件经环境变量传入，不用 argv），显式 `--agent` 仍最高优先；
  既有 `dsh-` 开头的文件名不做重命名，只用于「认领归属」。
- **文档**：README 新增「装完之后的第一次使用」；`docs/AGENT-EXPERIENCE.md` 删掉
  「npm-only 安装不含 setup 脚本」这一已过时的错误说法；`docs/JSON-CONTRACT.md`
  增补 `memory_setup` 载荷与「无审批通道不伪造授权」的约定。

- **`memory_setup` 的正文不再渲染成 `[object Object]`**：宿主的 `renderText` 只读 `output` 字段，
  而早期实现只返回 `reason`/`plan`/`steps`，界面（和模型看到的正文）就成了 `[object Object]`，
  恰好把这段必须念给用户听的同意文案吞掉。现在每个分支都带 `output`，结构化字段保留不变。
- **`memory init --vault` 覆盖已有配置时会说出被替换的路径**：写入 `vault:` 本来就是
  这条命令的职责（所有运行时都从 `UNIFIED_MEMORY_VAULT` 或 `~/.unified-memory.yaml`
  解析，不看 argv），但原先静默覆盖，等于把一台本来指向正确 vault 的机器悄悄改到别处。
  现在多打印一行 `note: replaced the configured vault A -> B`；行为不变，只是不再无声。

### Fixed — 第三轮复查（代码围栏、登记表列数与路径边界）

- **I1 旧格式清理会被代码块里的标题骗到（数据丢失）**：`_replace_section` 的旧格式扫描按行找
  「标题含关键词」，却不知道 ```` ``` ````／`~~~` 围栏的存在。用户在指令文件里贴一段示例
  （内容恰好含 `## 统一记忆库`）时，扫描会从围栏**里面**开始、到下一个 `## ` 结束，把示例之后的
  正文整段删掉，还留下一个未闭合的围栏。现在先按围栏做逐行掩码，只认围栏外的标题；围栏内的
  内容不会被当作段落边界。围栏只在**同字符且不短于开头**的标记处闭合（CommonMark
  规则），所以在 `~~~` 块里再贴一段 ```` ``` ```` 来引用 Markdown 也不会提前结束。
- **旧格式编号只认阿拉伯数字 + 点**：模板与用户的习惯里还有 `## 第3节 统一记忆库`、`## (1) 统一记忆库`
  这类写法，它们被当成陌生标题留在原地，于是同一次部署里出现「旧段没删 + 新段又插」两份。
  现在 `_LEGACY_NUMBERING` 覆盖 `1.` / `1)` / `(1)` / `第1节` 等变体。
- **前缀登记表的多余列会被压掉**：`registryRow` 固定输出三格，遇到用户加了第四列（例如「状态」）
  的表时，自己那一行会少一格，`在用` 之类的值随之消失，整张表在渲染上也错位。现在按表头的列数
  补齐，已有行里我们这三格之外的单元格原样带过来。
- **登记表的行尾被整体归一化**：以前用 `existing.includes('\r\n')` 选一个全局行尾再拼全文件，
  混合行尾（两台机器都写过）的文件会被整篇改写。现在按行保留各自的行尾，只有新插入的行用
  表头那行的行尾。
- **同前缀的重复行只会更新第一条**：用户手写的表里同一个前缀出现两次时，第二条保持旧内容，
  下个 Agent 读到的是过期信息。现在所有命中的行都改成同一内容；**不删除**用户写的行。
- **vault 路径含 `#` 会写进一个读不回来的值**：读取端按 `#` 截断配置（配置文件本身可手写注释），
  `C:\notes #2` 会被读成 `C:\notes`。`init` / `use` 现在直接拒绝这种路径并说明原因。
- **半成品 vault 会先征求同意、再在第一步失败**：工具侧只探测 `50-Agent-Context` 目录，
  runner 还要求 `上下文索引.md`，同一个问题两个答案。现在共用 `inspectVault()`，工具在征求同意
  **之前**就按同一句话拒绝，不再要一份注定失败的授权。
- **`memory use` 会收下名不副实的「半成品」库**：插件侧按「有没有 `上下文索引.md`」判定，CLI 只
  看 `50-Agent-Context` 目录在不在，于是手工跑一条 `memory use --vault` 就能把 `vault:` 指到一个
  读起来是空的目录，退出码还是 0、还自称成功。现在 `use` 也要求索引文件存在，否则 `SystemExit`、
  不动配置，并提示移走/改名后重新 `init`。
- **`selfcheck` 失败时不说「已指向新 vault」**：`init` / `use` 已经改了配置，但只有 `instructions`
  失败时才追加提示。现在自检失败也追加；`vault` 步骤自身失败时不加（那时配置还没写）。
- **路径带空格时提示里的命令不能直接粘贴**：`planText` 与 `memory use` 的错误提示现在给路径加引号。

### Fixed — 第四轮复查（未闭合围栏、共享登记表与探测契约）

- **未闭合的围栏会把后面整篇文件删掉（数据丢失，第三轮引入）**：掩码把「围栏开了没关」一路当成
  围栏内，于是旧段落的收尾扫描找不到下一个 `## `，`end` 直接到文件末尾——用户写在该标题之后的
  所有内容都被当成旧段落删掉（第三轮之前的代码会在下一个标题处停住）。现在开围栏的位置会被记下：
  找旧标题时仍信任掩码（不误删围栏里的引用），找收尾时**不信任未闭合的围栏**，宁可多留文本。
- **4 空格缩进的 ``` 被当成围栏（CommonMark 里那是缩进代码块）**：被误判后它下面真正的
  `## 统一记忆库` 被掩掉，旧段不迁移，同一次部署留下两段同名段落。现在围栏只认 ≤3 空格缩进。
- **登记表是文件最后一块且没有结尾换行时，新行会粘在上一行后面**：追加前先补齐上一行的 EOL，
  否则损坏的那行（6 格）会永久留在两台机器共享的表里；现在第二次运行是逐字节 no-op。
- **单元格里含 `\|` 时登记表会无限增长**：`cellsOf` 按所有 `|` 切分，把 `\|` 这个转义读成两格，
  于是每跑一次就多带一份尾部单元格。现在只按未转义的 `|` 切分，行内容逐字节稳定。
- **表头认不出来时整份登记表被重建（用户正文丢失）**：例如表头带前导空格。现在无法解析的
  文件一律保留原文、在末尾追加我们的表；下一次运行能找到表头，从此原地更新。
- **手写表缺少 `| --- |` 分隔行时，第一行数据被当成分隔行**：我们自己的行因此永远不被改写，
  只在表尾追加一份同前缀的副本，与「同前缀的重复行会一起改成同一内容」的承诺不符。现在只有
  真的存在分隔行才从表头 +2 开始。
- **`SetupDeps.exists` 缺省时会去探真实磁盘**：注释说「没给就当作不存在」，实现却用 `existsSync`，
  于是同一份测试在有 `C:\Vault` 的机器上会走 `use` 分支、静默不再覆盖 `init`。现在缺省即
  「不存在」，`inspectVault()` 也不再带默认探针（调用方必须说明它知道什么）。
- **以引号结尾的 vault 路径同样读不回来**：读取端除了按 `#` 截断，还会剥掉值两端的引号，
  `notes'` 会被读成 `notes`，而原来的检查只挡 `#`。现在改用**回读校验**——按读取端的规则把值
  解析一遍再和原路径比较，一次覆盖 `#`、引号与将来可能变化的解析规则。
- **`selfcheck` 失败详情里的 `?? exit N` 是死分支**：`failureDetail` 只在退出码为 0 时返回空，
  而那种情况已经走成功分支。回退并入 `problem` 的计算，只为让类型自洽，不再读作「有一个
  `exit 0` 的失败分支」。

### Fixed — 第二轮复查（复用路径的配置持久化等）

- **复用 vault 时没有写配置（最重要）**：`init_vault` 是 `~/.unified-memory.yaml` 的唯一写者，而
  复用路径为了不覆盖用户笔记**跳过**了 `init`——于是 `vault:` 从未落盘，`reload()` 解析出来的
  `vaultPath` 仍是空/旧值：五个读取工具继续回「未配置」，成功提示是假的，PATH 包装器（不设
  `UNIFIED_MEMORY_VAULT`）退回 `~/AgentMemory`。自检之所以没报警，是因为它把
  `UNIFIED_MEMORY_VAULT` 钉死在自己的环境里。现在新增 `memory use --vault <path>`：只改写配置文件
  的 `vault:` 行、**不写库内任何文件**（库结构缺失时直接报错并提示先 `memory init`），复用分支调用它。
- **复用探针比 `ensure_vault` 弱**：只看到 `50-Agent-Context` 目录就认定「已初始化」，半成品或旧结构
  也能报「已完成」。现在要求 `50-Agent-Context/上下文索引.md` 存在；只有同名目录时按「不是完整的
  记忆库」失败并提示移走/改名，绝不用 `--force` 硬覆盖。
- **旧格式标题匹配仍是子串启发式**：标题里只要**出现**关键词就算我们的段落，用户自己的
  `## 关于 50-Agent-Context 的结构` 会被连正文一起删掉。现在要求标题在可选编号之后**以关键词开头**。
- **旧格式迁移后再跑一次会重写文件**：迁移路径保留标题前的空行，标记路径会折叠它，于是第二次部署
  仍有 diff 并多出一个 `.bak-`。两条路径现在共用同一个拼接函数，第二次是逐字节 no-op。
- **混合行尾的文件会被整体归一化**：以前先把全文转成 LF、处理完再转回，纯 LF 或纯 CRLF 文件没问题，
  但混合文件（两台机器各写过）会被整篇改写，在用户仓库里显示成全文件 diff。现在拼接直接在原文上做，
  只有插入的托管段落使用文件的主导行尾。
- **前缀登记表被整份重写**：`mergeRegistry` 从解析出的行重新生成文件，用户加的说明文字、多余列
  以及 CRLF 行尾全部丢失。现在只在表内**原地**改自己那一行（同前缀就地替换，新前缀追加），
  其它行、散文、列数与行尾原样保留。
- 文档与注释同步：`planText` 第 1 步按复用/新建分别显示 `memory use` / `memory init`、第 3 步不再
  写死 `memory.cmd`；`JSON-CONTRACT` §6.2 说明复用分支必须持久化配置、「已指向」提示的适用范围，
  以及半成品 vault 的失败约定；`ARCHITECTURE` 的 CLI 列表补上 `use`。

### Fixed — 首次引导的复查修复（代码评审 C1–C3 / I1–I7）

- **C1（数据丢失）托管段落的旧格式清理会吃掉前面的标题**：早期用
  `(?ms)^## .*?(?:统一记忆|Agent提交区|50-Agent-Context)` 找旧段落，`.*?` 会从**文件里第一个
  `## ` 标题**开始吞，只要中间出现过关键词，就把前面那节（例如 `## 0. 全局`）整段删掉，
  而且标记数量校验照样通过（新段落自带标记）。现在只按行找**标题本身含关键词**的那一节，
  只删它到下一个 `## ` 之间的内容。
- **C2（引导永远失败）指向已存在的 vault 时 `init` 必然拒绝**：`init_vault` 在
  `<vault>/50-Agent-Context` 已存在时直接 `SystemExit("vault already initialized … --force")`，
  而 `--force` 会用模版覆盖用户笔记。复用现成 vault 正是 0.8.0 升级与「我已有 Obsidian 仓库」
  的主路径。现在先探测 `50-Agent-Context`，存在就跳过 `init` 直接进入部署，步骤详情写
  `复用已存在的记忆库`。
- **C3（装完仍不可用）五个读取工具依旧报 not configured**：`configured` 是注册时抓的布尔值，
  `reload` 只改配置对象，所以 setup 成功后必须重启宿主才好；而且 `reload` 还挂在
  「有授权记录」这一条件上，走 `apply: true` 的路径永远不刷新。现在工厂按调用时的
  `cfg.vaultPath` 判定，vault 步骤成功即 `reload`。
- **I1 半途失败会静默把机器指到新 vault**：`init` 成功后若 `deploy` 失败，本机默认 vault 已经
  改指向了，调用方却只看到一句 `deploy failed`。现在失败详情末尾追加
  `；注意：本机默认记忆库(vault:)已指向 <path>`。
- **I2 前缀登记表被整表重写**：`buildRegistry` 从头生成，会把其他运行时（`dsh-web-`、手动登记的
  `codex-`）的行全部抹掉。新增 `mergeRegistry`：解析已有 `| \`前缀\` | 运行时 | 说明 |` 行，
  按前缀 upsert 再重排，别人的行原样保留。
- **I3 有授权记录时 `apply: true` 被吞掉**：短路条件只看「已授权」不看 `apply`，于是消息里
  「补写缺失的文件请传 apply=true」照做也没用。现在只有 `已授权 && !apply` 才短路。
- **I4 审批服务抛错会炸出工具契约**：`approval.request` 原先既没判 `typeof` 也没 try/catch，
  服务在调用中途消失就直接抛。现在两者都有，兜底返回计划并说明「未写入任何文件」。
- **I5 shim 只有 Windows 版、且每次重写**：现在 win32 写 `memory.cmd`，其他平台写
  `#!/bin/sh` 的 `memory` 并 `chmod 0o755`；内容与磁盘一致时跳过写入，不制造无意义的 mtime 变化。
- **I6 托管写入会把 CRLF 改成 LF**（含 `.bak` 备份）：Windows 上的指令文件多半是 CRLF，
  一次部署就等于整文件换行符改写，diff 噪音盖住真实改动。现在按字节读写，原文件是纯 CRLF
  就还原成 CRLF。
- **I7 `notConfigured()` 把用户推去读手册**：提示改成第一步就调 `memory_setup`（不带 `apply`
  只出计划），任务书降为手工替代路径。
- **M1 自检形同虚设**：`memory status` 发现结构缺失时仍然退出 0，只看退出码的自检永远通过。
  现在额外匹配 stdout 里的 `vault structure: MISSING` 判失败。
- **M2 相对路径会在宿主的 cwd 里建库**：`memory_setup` 现在要求绝对路径，否则直接返回
  `ok: false` 并说明怎么改，一个字节都不写。
- **M5 `relToHome` 前缀误判**：`C:\Users\bobby` 会被当成 home `C:\Users\bob` 内部路径，
  渲染出 `by/.dsh/AGENTS.md`。现在只在分隔符边界上剥离。

### Fixed — 提交前缀不再硬编码

- **`memory_submit` 把身份写死成 `dsh`**：插件层（`src/tools.ts`）原样调用
  `--agent dsh`，而 core 的 `memory submit` 早已支持任意 agent 名。后果是同一台
  机器上多个 dsh 运行时共用一个 vault 时（桌面端 `desktop`、浏览器端 `web`、
  `tui`、`headless`……）全部写成 `dsh-<时间戳>.md`，既无法按前缀隔离，也追不出
  是哪一端写的；同一个桌面端里 Lead 与 teammate 并行写时同样无法区分。
  现在前缀取自 `agentName` 配置：`config.agentName` → `UNIFIED_MEMORY_AGENT`
  → `dsh-<DSH_PROFILE>` → `dsh`。宿主每次都会设置 `DSH_PROFILE`，因此零配置
  即得 `dsh-desktop` / `dsh-web` 等可辨前缀；不设该变量的环境仍回落 `dsh`，
  升级不会改变既有安装的文件名。
- **配套**：新增纯函数 `buildSubmitArgv`（与 `buildSearchArgv` /
  `buildPreviewArgv` 同构），argv 契约可单测而无需启动 Python core；
  `scripts/drift-check.mjs` 把 `agentName` 与 `UNIFIED_MEMORY_AGENT` 纳入必须
  存在的键，防止将来又退回硬编码。文档同步：`docs/DESKTOP.md` 配置项一节、
  `docs/AGENT-DEPLOY.md` 的 dsh 规则层模板（前缀写 `dsh-<profile>`）。

## [0.8.0] — 2026-10-18

以真实 Obsidian vault（460 条事实 / 20 份 canonical 笔记）为基准做的
正确性、性能与可观测性升级。原有接口全部保持兼容；Python 测试 174 → 198 全绿。

### Fixed — 真实写入格式（最重要）

- **Hermes 方言完全无法解析**：core 只认 `（写入 …｜来源：Agent提交区/x.md）`，
  而 Hermes 实际写入的是 ``（写入 …｜来源：[[Agent提交区/x.md]]，事件 `…`）``
  与 `（来源：[[Hermes会话自动归档/…]]）`。真实 vault 的 460 行里 **0 行**能解析出
  日期/来源，导致按写入时间的遗忘、来源归因、去重全部失效。现由
  `common.parse_stamp()` 统一覆盖两种方言；实测 83/83 条带来源的行全部解析成功。
- **`｜有效至` 历史版本仍被当作当前事实召回**：索引现在把它们标记为
  `superseded`，检索默认不返回；`strip_suffix()` 也会移除
  `事件`/`使用 N 次`/`有效至` 后缀，去重与冲突检测不再被后缀干扰。
- **Forgetter 的 bullet 前缀 bug**：`parse_line()` 保留了 `- ` 前缀，导致
  `memories.line` 永远匹配不上，`importance`/`access_count` 实际从未生效。
- **中文持久主题不受保护**：`PROTECTED_RE` 只有英文关键词，路径/配置/服务器/
  凭据等中文事实会被误遗忘；已补齐中文词表。
- **笔记编辑会清空强化历史与向量**：重建一条笔记时所有行的
  `access_count`/`created_at` 被重置为 0/今天，`embeddings` 也被整批删除，
  迫使付费重新嵌入。现在仅对消失的行清理，保留行的统计数据与向量原样保留。
- **Promoter 的锁内去重从未生效**：比较时一侧带 `- ` 前缀、另一侧不带，
  重复事实仍可能被写两次；现在两侧统一取 bare fact，且同一目标笔记批量写入一次。
- **Digest 游标在写收件箱失败时仍前进**：提炼出的事实会永久丢失；现在写失败
  不推进游标，下次重试。
- **`fts_search` 中文无结果、英文只回文件名**：改为先用记忆行级流排序并返回
  命中行作为 snippet，doc 级 FTS 仅作兜底。

### Added

- **中文 bigram BM25 召回流**：`fts_mem_bigram` 把中文切成重叠 bigram
  （ASCII 词小写），`memory search` 与 `--hybrid` 都能命中“记忆/路径/环境”
  这类 2 字查询；混合检索从 4 路变 5 路。
- **`memory doctor`**：只读健康报告（索引规模、收件箱最老积压、冲突、精确重复行、
  向量覆盖率、图谱边数、OneDrive 冲突副本、孤儿索引库），带 `--json`/`--strict`，
  问题分级 error/warn/info。
- **`memory gc`**：只清理派生数据——孤儿索引库（源 vault 已不存在且超过 N 天）、
  过期 `access_log`、过期查询向量、重建有界图谱、VACUUM；默认 dry-run，
  `--apply` 才执行，`--keep-orphans` 可只做图谱/VACUUM。
- **查询向量缓存**：`query_cache` 复用 7 天内同一查询的向量，重复主题的
  hybrid 检索从约 550ms 降到约 250ms。
- **OneDrive/Dropbox 冲突副本识别**：`note 2.md`、`note-副本.md`、
  `conflicted copy` 不再进入索引；`doctor` 报 error 提示人工合并。
- **时序语义**：`｜有效至` 行索引为历史版本；Forgetter 用 `access_log` 的最近
  访问时间而不是 `updated_at` 计算衰减，最近检索过的事实不会被误降级。

### Changed — 性能与并发

- **有界概念图谱**：旧实现给一行内所有概念两两连边，真实 vault 454 条记忆产生
  206,831 条边、26 MB 数据库；现在每行最多 16 个概念、每个概念最多 8 个邻居、
  全局最多 5,000 条边，实测降到 5,000 边 / 5.5 MB（-79%）。
- **图谱召回改倒排索引**：`expand_search` 从 O(N²) 的“每个直接命中 × 每条记忆”
  改为一次倒排构建，查询复杂度与命中数线性相关。
- **SQLite WAL + busy_timeout=5s + synchronous=NORMAL**：检索/控制台读取不再因
  晋升写入报 `database is locked`。
- **混合检索只在 vault 变化时补向量**：不再每次搜索都调用一次 embedding provider。
- **Token 预算按真实 token 估算**：CJK 1 字≈1 token、ASCII 4 字≈1 token，
  修复旧实现把中文预算放大约 4 倍的问题。
- **上下文注入只注入事实行**：`inject_context.py` 按事实行 + `--max-chars`
  全局预算选取，剥掉写入/来源后缀，避免小预算被标题和散文占满。

### Tests

- Python `unittest`: 197 tests（新增 23 项：Hermes 戳解析、`｜有效至`、访问计数/
  向量跨编辑保留、bigram 检索、冲突副本过滤、图谱上界、查询缓存、GC 孤儿库、
  doctor 错误分级、digest 游标、promoter 去重）。
- 既有后端门禁保持全绿：`npm run typecheck`、`test:js`（421）、`test:node`（21）、
  `setup/tests`（5）。

### Hermes-side pipeline (external, aligned in the same pass)

The live Hermes deployment keeps its own scripts under
`HERMES_HOME/scripts/`. They were aligned to the same hygiene contract in this
release (see `integrations/hermes/README.md`):

- new `memory_hygiene.py` shared by promoter/forgetter/inject/export/status;
- fixed `SOURCE_SUFFIX_RE` so ordinary `（写入 …｜来源：[[…]]）` lines are
  recognised (they were silently skipped by the forgetter);
- forgetter now skips `｜有效至` history, backs up + atomically rewrites, and
  scans only `50-Agent-Context` (not `20-Knowledge` guides);
- auto-versioning backs up before rewrite;
- context injection strips provenance suffixes;
- Supermemory/mem0/OpenClaw exports filter history, 已取代 sections and
  sync-conflict copies;
- `hermes_memory.py` points at current canonical files and searches current
  facts only.

## [0.7.2] — 2026-10-18

适配 DSH `0.2.1-rc.2`（桌面端 44.7.0 附带的运行时）。**插件代码零改动**：上游这一版只在
`dsh-tools`、`dsh-host-webserver`、`dsh-client-ui-slots` 上做加法，本插件用到的
`defineTool`、`ctx.tools.register`、`webServer.register({kind:'exact'})`、`slots.inject`
签名全都没变。同一台机器上被宿主按 peer 范围整体跳过的插件（例如 `dsh-turn-rewind`、
`dsh-vision-toolkit`）是它们自己的声明没跟上，与本项目无关。

### Changed

- `devDependencies` 的 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-host-webserver` 钉到
  `0.2.1-rc.2`，`@deepseek-ai/cordis` 升到 `^4.0.5`（上游把 `~4.0.4` 提到了 `~4.0.5`）。
- `package-lock.json` 重建：CI 走 `npm ci`，锁文件与 `package.json` 不一致会直接装错版本。
  重建是全新解析，顺带把 `vitest` 4.1.11 → 4.1.12、`rolldown` 1.2.9 → 1.2.14、
  `@types/node` 等开发依赖挪到各自 range 内的最新版，属于锁文件的正常刷新。
- `compatibility.dshReleases` 增加 `"0.2.1-rc.2": "compatible"`（`package.json` 与
  `dsh.plugin.json` 两处必须一致，drift-check 会比对）。
- 文档里的「验证目标」统一改为 `0.2.0-rc.2` / `0.2.1-rc.2`：`0.1.5-rc.2` 仍在 peer 范围内，
  但本轮没有复测，因此不再声称「已验证」。

### Added (tests)

- `test/version-sync.test.mjs`：`devDependencies` 钉住的 DSH 版本必须出现在两张兼容表里，
  否则红灯。此前兼容表纯属注释性质，升版后没人检查，声明落后于实际验证也发现不了。
- `test/web-ui-contract.test.mjs`：客户端 bundle 的**真实加载**用例——在 `vm` 里模拟
  `window.__ModuleLoader__`，跑 factory 拿到模块对象，再喂一个 `slots` 桩，断言
  `sidebar.footer.action` 与 `shell.overlay` 两个座位确实被注册、且都拿到 React 组件。
  在这之前只靠正则确认字符串存在，客户端契约变了也看不出来。

## [0.7.1] — 2026-10-13

在真实桌面端上安装 0.7.0 后实测发现的三个问题。**建议从 0.7.0 升级**：其中第一条会让
「已配好 vault 的安装」看起来完全没配置。

### Fixed

- **`vaultPath` 解析与 core 不一致（用户可见）**：插件此前只读自己的 cordis 配置，而 core
  的 vault 解析顺序是 `UNIFIED_MEMORY_VAULT` → `~/.unified-memory.yaml` 的 `vault:` →
  内置默认值。于是「用 `setup.py init` 初始化过、但没在插件里填 `vaultPath`」的安装会出现
  **自相矛盾**：侧边栏控制台正常显示真实数据（437 条记忆 / 364 向量），而 5 个模型工具全部
  回答 `not configured`——控制台与 agent 对同一台机器给出不同结论。
  现 `resolveConfig` 完整复刻 core 的优先级（cordis 配置 → 环境变量 → core 配置文件），
  并导出 `readCoreConfigVault()` 供测试；空字符串不再遮蔽低优先级来源。
- **npm 包缺少 `setup/` 与 agent 模板**：`files[]` 未收录 `setup/*.py` 与
  `integrations/{codex,claude}`，因此 npm 安装的用户**无法初始化 vault**（`setup.py init`
  不存在），也无法拿到 `AGENTS.md` / `CLAUDE.md` 模板——而文档有 12 处引用这些脚本。
  现已全部随包发布（包条目 92 → 99），并新增 `setup/README.md` 说明各脚本用途。
  实测：从安装位置运行 `setup.py init` 可正常建库（8 份 canonical 笔记 + 两份 agent 模板）。

### Changed

- `docs/DEPLOY.md` 新增「§0 你是哪种安装」对照表，说明 npm 安装与 git clone 各含什么、
  `<pkg>` 指代哪个目录，以及 core **无需 pip install**（插件自动把内置 `core/` 加入
  `PYTHONPATH`）。
- `docs/DESKTOP.md` 新增「§4b 插件还附带什么」：列出包内 `core/`、`vault-template/`、
  `setup/`、`integrations/`、`docs/` 的用途与从安装位置直接建库的命令。

### Fixed (tests)

- 降级路径测试改为**密闭执行**：`resolveConfig` 现在会读 `~/.unified-memory.yaml`，使原测试
  在「本机已配 vault」时失败、在 CI 上却通过（典型的环境依赖型测试）。现改为在子进程中以
  空 `HOME`/`USERPROFILE` 运行，任何机器上都成立。

## [0.7.0] — 2026-10-13

DSH `0.2.0-rc.2` / 桌面端适配版本。**兼容性声明修复是必须升级的理由**：0.6.0 在
DSH `0.2.0-rc.2` 上会被宿主整体跳过（工具与路由都不注册）。

### Added — DSH 0.2.0 / 桌面端适配

- **桌面端支持（DeepSeek Harness Desktop）**：新增 `docs/DESKTOP.md`，说明桌面端使用
  **独立的 `desktop` profile**（而非 `profiles/web`），因此 Web 端装的插件在桌面端不可见。
  安装**只能走桌面端自带的插件管理器**：`dsh plugin --profile desktop …` 会被 CLI 直接拒绝
  （`profile "desktop" is managed exclusively by the Electron application`），该拒绝不可用
  命令行绕过（`manageDesktopProfile` 是仅桌面端载体可传的程序化参数，无对应旗标或环境变量）。
  文档另含 `vaultPath` 配置、验证步骤与「安装卡死」的排查手册。
- DSH `0.2.0` 兼容性闸门说明：宿主在**导入插件前**校验其 `@deepseek-ai/dsh*` peer 范围，
  不匹配的组合包会被**整体跳过**（工具与路由都不注册，UI 无任何报错）。该机制与
  `compatibility.json` 精确版本豁免的用法一并记录在 `docs/DESKTOP.md`。
- `engines.dsh` 与 `dsh.manifestVersion` 声明（DSH 0.2.0 起的包清单字段；目前仅声明、
  不参与强制校验）。

### Changed — DSH 0.2.0 / 桌面端适配

- **兼容性声明修正（关键修复）**：`peerDependencies` 中两条 `@deepseek-ai/dsh*` 范围由
  `^0.1.0-rc.6` 改为 `^0.1.0-rc.6 || >=0.2.0-rc.1 <0.3.0-0`。原范围**不匹配** `0.2.0-rc.2`
  （预发布版本不落入上界为 `0.2.0` 的 caret 范围），在 DSH `0.2.0-rc.2` 上会导致插件被静默
  跳过——五个工具与六条 HTTP 路由全部不注册。
- 开发依赖对齐到真实目标版本：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-host-webserver`
  升至 `0.2.0-rc.2`，`@deepseek-ai/cordis` 升至 `^4.0.4`。这些包自带精确锁定的 peer 集合
  （`dsh-llm`、`dsh-agent`、`dsh-ptc-runtime`、`dsh-sandbox` 等），需整套同版本共存。
- `build.mjs` 的进度日志改走 **stderr**：新增 `prepack` 后，构建输出会污染
  `npm pack --json` 的 stdout，使 `audit:package` 以 JSON 解析错误失败。
- 兼容目标文档（`README.md` / `README.zh.md` / `docs/ARCHITECTURE.md` /
  `docs/AGENT-EXPERIENCE.md` / `docs/DEPLOY.md` / `docs/DSH-MEMORY-ADAPTERS.md`）由单一
  `0.1.5-rc.2` 改为「`0.1.5-rc.2` 与 `0.2.0-rc.2` 两条版本线」。
- `dsh.plugin.json` 改为**完全由 `build.mjs` 从 `package.json` 与源码派生**，不再手工维护；
  `entry.inject` 直接从 `src/index.ts` 的 `export const inject` 读取。此前该文件已漂移：
  `entry.inject` 写的是 `['tools']`，而代码实际是 `['tools','webServer']`。
- 更新检查（`src/updater.ts`）新增 **npmmirror 回退**：主源 `registry.npmjs.org` 在国内网络
  经常超时，镜像可用时仍能拿到版本号；镜像也失败时保留既有状态而不是写入「未知」。

### Fixed — DSH 0.2.0 / 桌面端适配

- **七个死测试**：`test/*.test.mjs` 既被 `vitest.config.ts` 排除，也没有任何 npm script 或
  CI 步骤执行，其中两个文件仍在对重构前的 API 断言（`plugin.default`、可选的 `webServer`、
  四个工具、`contextPath`、`memoryUiStatus`），实际 9 项中 7 项失败且长期无人发现。现按当前
  契约重写，并新增 `npm run test:node` 纳入 `npm run check`（排在 `build` 之后，因为它断言的
  是构建产物）。
- `drift-check.mjs` 的工具名清单补上 `memory_preview`（此前只校验 4/5 个工具），并新增对
  `dsh.plugin.json` 的 `compatibility` / `entry.inject` / `client.platform` 的独立复算比对
  （即使没跑构建也能抓到漂移）。
- **版本比较器重写**（`src/updater.ts`）：原实现用 `replace(/[^0-9.]/g, '')` 剥掉预发布标识，
  导致 `0.6.0-rc.1` 与 `0.6.0` 判为**相等**——跑预发布的用户永远收不到正式版已发布的提示。
  现按 SemVer 实现（预发布低于正式版、数字标识符低于字母标识符、短标识符列表更低、
  忽略 build metadata）。
- **`remoteEnabled` 字符串布尔陷阱**（`src/utils.ts`）：原用 `Boolean(value)`，而
  `Boolean('false') === true`——配置文件或环境变量里写 `'false'` 会**静默打开**远程索引。
  现改用 `toBool()`，接受 `1/true/yes/on` 与 `0/false/no/off`，无法解析时回退默认值而非猜测；
  并新增 `UNIFIED_MEMORY_REMOTE` 环境变量支持。
- `sync-check.mjs` 的汇总行把退出码当作问题计数，两条错误会打印「1 issue(s) found」；
  现独立计数。
- CI（`.github/workflows/ci.yml`）补上 `npm run test:node`（排在 `build` 之后），死测试不再
  可能无声复发；`sync:check` 改为 `continue-on-error`（发布中途「已打 tag 未发布」是合法状态，
  不应卡住 CI）。
- `package.json` 新增 `prepack`，使从干净 checkout 发布时必定带上 `lib/` 产物
  （此前无任何 prepare/prepack 脚本，直接 `npm publish` 会发出不含构建产物的包）。
- **CI 的 `npm ci` 修复**：`vitest` 内嵌的 `vite@8` 把 `esbuild` 声明为**可选 peer**
  （`^0.27.0 || ^0.28.0`），npm 11 生成的锁文件因此留下了 26 个 `@esbuild/*@0.28.2`
  平台包、却没有对应的 `esbuild@0.28.2` 本体条目；npm 10（CI 版本）据此判定锁文件不一致，
  报 `Missing: esbuild@0.28.2 from lock file` 并直接失败——这正是上一次 v0.6.0 提交
  CI 变红的原因。现将根 `esbuild` 升到 `^0.28.2`，让根依赖与 vite 的 peer 由同一版本满足，
  悬空条目消失。已用 **npm 10.9.9 实际复现并验证** `npm ci` 通过。

### Notes — DSH 0.2.0 / 桌面端适配

- `dsh.plugin.json` 与 `dsh.compatibility.dshReleases` 在 DSH `0.2.0` 中**已无任何读取方**
  （宿主改读 `package.json` 的 `peerDependencies`）。文件暂时保留以免影响第三方市场读取方，
  但不再作为兼容性权威来源；真实兼容性以 `peerDependencies` 为准。
- `npm run sync:check` 仍会报红：registry 上是 `0.5.2`，本地已打 `v0.6.0` tag 但从未发布。
  这是发布状态事实而非缺陷，`npm publish` 后即消失。

### Added

- **记忆库可视化**：控制台从「四 Tab 列表」改为「搜索 + 四张图」（搜索 / 访问 / 生长 / 构成 / 排行）。
  四张图全部由 core 新增的 `stats` 聚合命令驱动，**一次请求喂满四个 pane**。
  - **访问日历热力图**：按星期×周铺开，颜色深浅表示当日访问量。
  - **记忆生长曲线**：按天累计的记忆总数，带日期跨度标注。
  - **构成环图**：`type` 七类占比，右侧图例带百分比。
  - **访问排行条**：被召回次数 Top-N 横向条形。
  四个图共用**同一条降级路径**：读不到数据时统一显示原因，绝不画出空白图形。
- 记忆库可视化：core 新增 `stats --json` 聚合命令（`core/unified_memory/stats.py`），
  七键载荷 `daily` / `access` / `types` / `importance` / `top` / `span` / `totals`，**全部只读 SELECT**。
- 记忆库可视化：新增宿主读路由 `GET /stats`（第 6 条），**唯一不压平 core 信封**的读路由，
  客户端直接消费 core 的原生七键结构，少一层需要同步的映射。
  契约见 `docs/JSON-CONTRACT.md` §7.2 / §7.4。
- 记忆库可视化：客户端新增纯几何模块 `src/client/charts.ts`（零依赖：日历网格、折线路径、
  环图扇段、条形行），四张图的 SVG 几何全部由它产出，可脱离 React 单测。
- 记忆控制台：浏览器面板从「系统状态窗」改为控制台（当时为四 Tab），
  全部数据来自真实 core 调用，命中词高亮，可切换 hybrid 混合检索。
- 记忆控制台：新增五条宿主 HTTP 路由。读路由 `GET /search`（`q` 必填、`hybrid=1` 可选）、
  `GET /preview`（`view` ∈ pending/recent/forgetting/conflicts）、`GET /note`（`name` 为提交区内文件名），
  写路由 `POST /dismiss`（仅将提交区条目移入 `已处理/`，不删除、不改写）。
- 记忆控制台：core 新增 `note`（读单条提交正文）与 `dismiss`（唯一写命令，提交区条目移入 `已处理/`）
  子命令，新增 `core/unified_memory/inbox.py`；两者沿用统一信封 `{ok, command, data}`，
  并新增 `data.reason` 失败枚举（`invalid-name` / `not-found` / `outside-inbox` / `io-error:*`）。
- 记忆控制台：抽出宿主共享 HTTP 工具 `src/routes.ts`（loopback 判定、方法白名单、`no-store` 头、
  查询参数解码、带字节上限的请求体读取），五条路由复用同一基线。
- P0(U-2): `memory_search` 工具支持 hybrid/format/budget 参数，消除 ARCHITECTURE 文档漂移。
- Phase 1：`memory status/search/preview --json` 机器可读契约（统一信封 `{ok, command, data}`），
  JSON 模式下 vault 派生字段逐条打 `untrusted: true`，文本模式保留 `<memory-data>` 包裹。
  详见 `docs/JSON-CONTRACT.md`。
- Phase 1：`memory_preview` 工具与四个只读治理视图（pending / conflicts / forgetting / recent）。
- Phase 1：中文检索新增 trigram FTS 表（`tokenize='trigram'`，独立于既有 `fts`/`fts_mem`），
  作为 RRF 第四路召回；短于 3 字的 CJK 查询（如 `记忆`）回退到子串扫描。
- Phase 1：`/status` 路由新增只读 `index` 与 `stats` 字段（`memories`/`vectors`/`pending`）。

### Changed

- 记忆控制台：五 Tab（搜索 / 访问 / 生长 / 构成 / 排行）。原「待处理」「库全貌」「系统」
  三个列表 Tab 及其专用样式**已删除**；待处理计数移到「搜索」Tab 的小徽章上
  （悬停提示「31 条待处理」），因为它是控制台里唯一非图形的 pane，
  数字挂在那里才不至于被误读成图表数据。
- P0(U-1): `dsh.plugin.json` 的 version/description 由 package.json 单一事实源回填（build 自动完成），drift-check 硬校验版本一致。
- P0(S-1): CI 增加 Windows 测试 runner 与完整 JS 检查 job（typecheck/drift/sync/vitest/build/audit）。
- Phase 1：记忆面板客户端重构为分组卡片（黑灰白/银系、卡片层次、无裸 JSON）。
- 记忆控制台：`preview` 名字校验强化（提交区文件名白名单 + 解析后路径前缀双重校验），
  读单条提交与移入 `已处理/` 共用同一套校验，避免符号链接把内容带出提交区。

### Fixed

- **记忆控制台（可视修复）**：`Panel.tsx` 的更新圆点用了宿主**从未声明**的 token
  `--dsw-alias-err`，该属性一直是透明——圆点从来就没画出来过。改为宿主真实声明的
  `--dsw-alias-state-error-primary`。
- **记忆控制台（可视修复）**：四张图渲染的 17 个 class 名在 `styles.ts` 里**一条规则都没有**，
  于是排行条的 `<i style="width:96%">` 因 `inline` 元素**同时忽略宽和高**而完全画不出来、
  环图图例退化成项目符号——而当时 **393 个测试与冒烟脚本全绿**。现补齐规则并新增契约测试：
  `test/client-figures.test.ts` 遍历 `Figures.tsx` 渲染的每个 class，要求 `styles.ts` 有对应选择器；
  删掉任一条规则、或新增一个未样式化的 class，都会变红。
- **记忆控制台（正确性修复）**：日历热力图的星期轴原本用的是**数组下标**而非真实星期。
- **记忆控制台（正确性修复）**：日历热力图在**首个日期非法时会级联成 NaN**，让整张图消失
  （只守了逐项的 `at`，没守起点；而起点本身又是"末尾日期"的种子，所以坏一处塌全图）。
- **记忆控制台（正确性修复）**：`stats` 聚合里 `_scalar` 曾用 `except Exception: return 0`
  把真实错误——例如表缺失——静默折成 0。现直接删掉该 `except`：读不到就该报错，不该假装是 0。
- **记忆控制台（正确性修复）**：`loadStats()` 会在 core 侧改键名时画出**一张空图**，
  而 `totals.memories` 仍是非零——用户看到「记忆库是空的」这句他无法自行察觉的谎话。
  现加键存在性检查：七个键缺一即判 `error`，而**齐全的全空数据仍是 `ok`**（真的空库不是错误）。
- 记忆控制台（安全加固）：`POST /dismiss` 的失败语义此前被压平成 `unavailable`——`shapeDismissResult`
  以外层 `ok` 为先决条件，而 core 信封的外层 `ok` 是 `data.ok` 的**副本**（业务拒绝时两层同为 `false`），
  于是「条目已被移走」与「core 不可用」在面板上不可区分。现改为：只要 `data` 存在就按其内容判定，
  仅 `data` 缺失（畸形/非 JSON 输出）才降级为 `unavailable`，失败原因分类得以保留。
- 记忆控制台（安全加固）：`POST /dismiss` 的 argv 曾把 `--json` 放在 `--` 终止符**之后**，
  argparse 把它当作第二个位置参数并以 exit 2 空 stdout 退出，宿主会误判为名字非法而拒绝所有合法提交；
  现改为 `dismiss --json -- <name>`，并保留 `--` 以阻止前导 `-` 的名字被当作 flag。
- 记忆控制台（安全加固）：`POST /dismiss` 的请求体上限按**字节**而非 UTF-16 码元计数
  （CJK 每字符最多 3 字节，用 `.length` 会放过 2–3 倍载荷），并拒绝前导 `-`/`~`、分隔符、`:`、NUL
  及路径穿越形状的名字。
- 修复 `audit-package.mjs` 在 Windows 上的 spawn 失败（经 `process.execPath` 调用 npm-cli.js，不依赖 shell），并豁免 vault-template 归档区 README 占位文档的违禁路径误报。
- Phase 1：`/status` 的 `pending` 计数此前把非有限值悄悄折成 `0`，使「读取损坏」与「确实没有待办」
  不可区分；现与 `memories`/`vectors` 兄弟字段一致——任一计数非有限即整体 `stats` 降级为 `null`。

## [0.5.2] — 2026-09-19

### Fixed

- **The host plugin never applied at all.** `apply` read `ctx.webServer` from
  inside a nested `ctx.inject(['webServer'], ...)` callback, but cordis resolves
  services against the plugin's own declared `inject`, so that read threw
  `cannot get property "webServer" without inject`. The loader failed the entry,
  and none of the four `memory_*` tools nor
  `/api/dsh-unified-agent-memory/status` ever registered. It was invisible from
  outside: the harness booted, no banner appeared, the sidebar button rendered —
  the panel just polled a route that had never existed. `webServer` is now
  declared statically and the route is registered directly, matching the other
  route-registering plugins in this profile.

### Added

- **Loopback-only status route.** The payload carries local filesystem paths
  (vault, python, core) and the harness may sit behind a reverse proxy, so
  non-loopback peers now get 403 and non-`GET`/`HEAD` methods 405.
- **`test/plugin.test.ts`** applies the entry against a context that enforces
  the same undeclared-service guard cordis uses, and covers the tool set, the
  route path, the payload and both guards. It fails against the 0.5.1 code with
  the original error and passes with the fix.

## [0.5.1] — 2026-09-18

### Fixed

- **The client entry is now a Cordis plugin.** `src/client/index.ts` exported
  no `apply`, so the DSH client loader rejected the bundle with
  `invalid plugin, expect function or object with an "apply" method, received
  object` and the harness booted into its "Failed to load plugins" screen. The
  module now declares `inject: ['slots']` and contributes UI from inside
  `apply(ctx)`, which is the shape the client runtime registers.
- **The sidebar trigger actually mounts.** It previously wrote to
  `window.__DSH_SIDEBAR_SEATS__` — a global the harness does not provide — so
  the button never appeared even when the module loaded. It now occupies the
  additive `sidebar.footer.action` seat beside Settings, and skips registration
  cleanly in hosts without a slot registry (headless, mobile shells).
- **Atomic build output.** esbuild results are buffered and published with
  temp file + rename. A profile that installs this package via `link:` with
  live patch reload can no longer observe a half-written `lib/index.js` and
  fail the entry for missing exports.
- **Self-referential `client.inject`.** `dsh.client.inject` listed this
  package's own module id; it now lists nothing, since the bundle loads its own
  client half.
- **Style tag ownership.** `adoptStyles()` gives each `<style>` its own
  instance token instead of removing the first matching tag, so two mounted
  instances (rail and wide sidebar) cannot dispose each other's CSS.
- **Uninstallable dev tree.** `@deepseek-ai/dsh-tools` and
  `@deepseek-ai/dsh-host-webserver` were ranged at `^0.1.0-rc.6`, which spans
  incompatible prereleases: `0.1.0-rc.8` requires peer
  `@deepseek-ai/dsh-llm@^0.1.0-rc.8`, colliding with `0.1.5-rc.2`. `npm install`
  failed with ERESOLVE. `devDependencies` now pin the harness release this
  plugin targets (`0.1.5-rc.2`); the `peerDependencies` ranges stay permissive
  so installs keep resolving against whatever harness the user runs.
- **Corrupt lockfile.** `package-lock.json` had been committed with unresolved
  git merge conflict markers (six blocks, since `0bed915`), so it was not valid
  JSON and `npm ci` refused to run at all. Regenerated from `package.json`.
- **Latent type errors in the tool handlers.** `CoreResult` and `ToolOutput`
  were `interface`s, and TypeScript only infers an implicit index signature for
  object type aliases, so all four `tools.register()` handlers failed
  assignment against the harness contract's `Record<string, JsonValue>`. These
  were never observed because `typescript` was not installed and the build
  swallowed the failure.
- **`sync:check` never checked npm.** It shelled out to `npm view`, which
  cannot be spawned that way on Windows (`npm` is `npm.cmd`, and Node 20+
  rejects a `.cmd` without a shell), and the throw landed in an empty `catch` —
  so the published-version gate always printed "All in sync" while doing
  nothing. It now reads the registry over HTTPS, and an unreachable registry is
  an error rather than a pass. It also no longer calls `process.exit()` after a
  top-level await, which aborted Node on Windows.

### Changed

- `npm run typecheck`, `npm run test:js` (32 tests) and declaration emit now
  actually run; the toolchain they need is installed from the lockfile.
- `exports.types` points at `lib/types/**` again, because those files are now
  genuinely emitted.
- `build.mjs` no longer prints "All checks passed" when declaration emit did
  not run. It reports the skip explicitly, fails under `--strict`/`CI`, and
  asserts that the built client bundle exports `apply`.

## [0.5.0] — 2026-09-15

### Added

- **Drift prevention system**: checks memory structure drift between vault
  template expectations and actual vault layout, with automated correction.
- **In-app update notification**: periodic npm registry check to alert users
  when a new plugin version is available.
- **TypeScript type declarations**: published `.d.ts` bundles alongside the
  compiled output for both host and client entry points.
- **Sync check / pre-push hooks**: prevent version drift between `package.json`
  and `dsh.plugin.json` on every commit and push.

### Changed

- **Migrated from plain JavaScript to TypeScript** — full type coverage across
  host entry (`src/index.ts`), tools (`src/tools.ts`), utilities (`src/utils.ts`),
  and client module (`src/client/`). Build pipeline uses esbuild for both host
  (Node ESM) and client (AMD with ModuleLoader wrapper).
- Hardened the DSH host adapter for DSH `0.1.5-rc.2` / npm `next`: strict
  boolean parsing, bounded and redacted core output, safe degradation when
  optional host capabilities are absent, and disposable HTTP status routes.
- Added a cross-platform, allowlisted deployment helper with preview, atomic
  apply, timestamped backup, rollback, self-check, and lock protection.
- Added public five-Agent experience guidance without local paths, credentials,
  infrastructure identifiers, or session content.
- Updated package boundaries and audit checks so npm dry-runs reject local
  vault, database, session archive, credentials, backup, and log content.
- Bumped `dsh.plugin.json` version to align with `package.json` at `0.5.0`.

### Fixed (DSH STORE compliance)

- Added `dsh.compatibility.dshReleases` with explicit declarations for DSH
  `0.1.5-alpha.2` (unknown), `0.1.5-rc.1` (compatible), and `0.1.5-rc.2`
  (compatible), resolving the "compatibility unlisted" status in the catalog.
- Added `dsh.compatibility.node` range (`>=20`) alongside the existing
  `engines.node` declaration.
- Removed protected `@deepseek-ai/*` package references from
  `dsh.client.inject` in both `package.json` and `dsh.plugin.json`; now uses
  the plugin-owned client module ID (`dsh-unified-agent-memory`) only.
- Versions bumped for DSH STORE fixed-Commit recheck.

### Compatibility

- Primary verification target: DSH `0.1.5-rc.2` / npm `next`, Cordis `4.0.1`,
  Node.js `>=20`. Stable `latest` remains a separately validated boundary.

## [0.3.0] — 2026-08-16

### Added — fused memory architecture (informed by rohitg00/agentmemory & TencentDB-Agent-Memory)

- **`index.py` — memory database (derived copy of the vault)**. Per-vault SQLite
  now holds `memories` (one record per canonical fact line: type / importance /
  status / version / superseded_by / source_agent / created / updated /
  access_count), `embeddings` (Float32 vectors), `access_log`, `graph_nodes` /
  `graph_edges` and `audit`, alongside the legacy `docs`/`fts` tables. Incremental
  rebuild by content digest.
- **`embed.py` — optional semantic vectors**. `memory embed` uses SiliconFlow
  `Qwen/Qwen3-Embedding-4B` (1024 dims) to embed every memory line; API key from
  `SILICONFLOW_API_KEY` or `~/.unified-memory/secrets.yaml`; graceful degradation
  to BM25 when unavailable.
- **`search.py` — hybrid retrieval**. `memory search --hybrid` fuses BM25 +
  vectors + concept graph with weighted RRF, diversifies per note, and caps
  output by a token budget (`--format`, `--budget`).
- **`digest.py` — session summarization (default on)**. Extracts durable facts
  from archived sessions via a lightweight LLM call into the submission inbox;
  cursor-idempotent, `--dry-run` preview, `--off` to disable.
- **`graph.py` — optional concept graph** (ASCII + CJK-bigram co-occurrence)
  feeding the third retrieval stream.
- **Supersession in the promoter**. Replacement cues (“改用/迁移到/instead of”)
  move the superseded old line under a `已取代` section instead of the conflict
  queue; the index marks it `superseded`.
- **Scored forgetting**. `forgetter.py` now uses `importance × (durable floor +
  decay) + access-reinforcement` instead of a plain 90-day rule.
- **Chinese-aware classification** in the promoter (偏好/路径/端口/服务器/规则 …)
  so non-English facts route to the correct canonical note.
- **Canonical filenames aligned to the live vault** (`工具可用性检查.md`,
  `UI审美准则.md`, `Codex-Claude-Hermes协作规则.md`) and the vault template /
  fallback template updated to match.

### Changed

- `core` index/search logic consolidated into `index.py`; `memory.py` delegates
  and keeps its public call shapes (`search_index`, `index_db_for`,
  `update_index`) so the remote server and existing tests keep working.
- **HKMemory SSH recall deprecated and removed.** The external Hermes semantic
  memory provider (`HKMEMORY_SSH_HOST`, `--hk`, the `_hkmemory` SSH bridge) is
  deleted. Its recall role is fully replaced by the fused local hybrid
  retrieval (`search.py`: BM25 + SiliconFlow vectors + concept graph) — the
  same capability the two reference projects provide, but local-first, faster
  and without an SSH/server dependency. The dsh plugin no longer passes
  `--hk`/`noHk`.

## [0.2.1] — 2026-08-15

### Fixed

- `memory search --remote` no longer requires a local vault: a pure remote
  client can query the remote index without any local vault (the local
  fallback still needs one). Reported by Codex review.
- `archive_session.py` appends under the vault file lock so concurrent
  post-turn hooks never drop each other's blocks on the same daily file.

## [0.2.0] — 2026-08-15

### Changed — deployment is now agent-driven (the only supported way)

- **New `docs/AGENT-DEPLOY.md`** — a self-contained deploy task book for DSH:
  full memory rules, per-agent global-instruction specs (dsh / Codex / Claude
  Code / Hermes), write conventions, step-by-step flow, verification checklist
  and pitfalls. On a fresh install DSH reads it and wires every agent itself.
- **`setup.py agents` is deprecated** — scripted writing of global instruction
  files was removed on purpose (each agent's prompt must be tailored to its own
  file format); the command now prints the agent-driven guidance only. The dead
  template/wiring code was deleted.
- **Plugin surfaces deployment guidance**: `memory_status` (and the
  not-configured message) now point DSH to `docs/AGENT-DEPLOY.md` and check the
  vault structure, so a fresh install is self-discoverable.

### Fixed

- **npm package now ships the Python core** (`core/` sources in the tarball).
  `corePath` already defaulted to `<plugin>/core`; previously the tarball did
  not include it, so the four tools failed on a bare npm install. No `pip
  install` is needed for the plugin tools (PYTHONPATH is injected). `.npmignore`
  and a glob-based `files` entry keep `__pycache__`/`.pyc` out of the tarball.
- **npm package ships the full deploy surface**: `vault-template/`,
  `integrations/hermes/` scripts and all docs are now in the tarball, so a bare
  npm install can create a complete vault (`memory init`), run the Hermes-style
  scripts, and resolve the doc links. The agent-driven task book documents the
  npm-only equivalents of `setup.py` (`memory init` / `memory status`).
- Removed stale `pip install unified-agent-memory-core` hints — that package is
  not on PyPI yet; the plugin-bundled core is the supported path.

### Added

- `memory search --remote`: real remote-index client — Bearer-token HTTP query
  against `setup/remote_index_server.py`; falls back to the local index (with a
  stderr note) when unconfigured, unreachable, or the token is rejected.
- `setup/remote_index_server.py`: dependency-free remote index server
  (`GET /health`, `POST /search`, Bearer token).
- `promoter --repair-existing`: conservative canonical hygiene (exact
  duplicates + template placeholders) with automatic backup and `--dry-run`.
- `memory show <doc>`: accept any canonical note under `50-Agent-Context`
  (structured-fact notes) in addition to the built-in ids.
- `integrations/hermes/`: runnable `inject_context.py`, `daily_cron.py`,
  `archive_session.py` scripts (context injection, full daily lifecycle,
  session archiving into `会话归档/`).
- Vault template: `50-Agent-Context/会话归档/` session-archive folder.
- dsh plugin `memory_search`: optional `remote` parameter.

## [0.1.1] — 2026-08-15

### Fixed

- **`file_lock` now prints a one-time "waiting for lock …" notice to stderr**
  while another writer holds the lock, instead of waiting silently for up to
  30 s (the timeout error itself was already clear; the wait in between was not).

### Docs

- **DEPLOY.md: Windows vault-path note** — paths like `/tmp/...` are
  drive-relative on Windows (`C:\tmp\...`); use `C:/...` or `$HOME/...` forms.

## [0.1.0] — 2026-08-14

### Added

- **Dependency-free Python core** (core/): memory init/search/show/submit (local SQLite FTS5 index with <memory-data> output markers), promoter review/apply/auto/adjudicate (classification, dedup, char-bigram conflict detection, file lock + atomic writes, inbox archiving), forgetter (90-day decay, reversible).
- **Vault template** (vault-template/): 7 canonical notes, 提交区 inbox, 情境信息 (pending/conflicts), 记忆遗忘区.
- **dsh plugin** (repo root): memory_search / memory_show / memory_submit / memory_status model tools; graceful degradation when unconfigured; optional sidebar status panel.
- **Integrations**: AGENTS.md (Codex), CLAUDE.md (Claude Code), Hermes hook examples.
- **Setup**: setup.py init/cron/selfcheck; standalone deployment documented (no Hermes required; Hermes dream-cron is just one optional scheduler).
- **Docs**: ARCHITECTURE / DEPLOY (standalone + full mode) / SECURITY; bilingual README.
- **CI**: core unit tests (unittest), gitleaks secrets scan, license check on every push.
