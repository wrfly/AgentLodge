# 在 AgentLodge 里复现 claude.ai

> 实施计划 · 2026-09-16 · **Phase 0–1 已落地，Phase 2 的 web search/fetch 已接入。**
> 分支 `feature/native-chat` 已同步到当前 `master`。
>
> 每一条都带出处（`file:line` 或官方文档），好让它能被逐条否决，而不是整份接受或整份放弃。
> claude.ai 的功能面以 `support.claude.com` / `platform.claude.com` 为准，抓取于 2026-09-16；
> 官方没写、只能照着实物做的几项在「先说做不到的」里单独列了。

## Context

现在的网页对话是 Claude Code 的壳：每轮 `podman exec` 在用户容器里拉起一次 `claude -p`，逐行解析它的 `stream-json`。想做成 claude.ai，这条路走不通 —— **claude.ai 和 Claude Code 是两个产品，工具集不一样**：

| | 工具 | 为了什么 |
|---|---|---|
| Claude Code | Read / Write / Edit / Bash / Glob / Grep | 改代码 |
| claude.ai | web_search / web_fetch / code_execution / artifacts / connectors(MCP) / memory / skills | 对话 |

而且系统提示词是 CLI 内置的（全仓库 grep 不到 `--system-prompt`），上下文压缩也在 CLI 里。所以这不是「换个实现方式」，是自己发 `/v1/messages`、自己跑 agent loop。

**地基已经在了**：

- `AgentAdapter` 接口（`apps/server/src/app/agents/types.ts:56`），`registry.ts:14` 的注释写着「加一个 agent 只需写个 adapter 并列在这里；认证、会话存储、SSE 和配额照旧」
- `app/recap.ts:395` 的 `ask()` 已经在直连网关的 `/v1/messages` 做标题和摘要 —— 这就是自研 runner 的非流式版本
- `app/agents/claude.ts:186` 的 `handleStreamEvent` 解析的**就是** Anthropic 原生 SSE 事件（CLI 的 `stream_event` 是原样透传的），block 编号、thinking token、tool 参数拼装那 200 行可以直接搬
- 网关在 `anthropic-native` 路径上**原样透传整个 body**（`gateway/index.ts:491` 是个 spread 拷贝加 `JSON.stringify`），`anthropic-beta` 也会 merge（`upstream.ts:343-350`）—— image / document / tools / mcp_servers / context_management 今天就能过去

**坑在计量侧**。这个项目的全部意义是计量，而网关的 usage 解析只认四个 token 计数器：服务端工具的用量看不见，价格表只能按 token 算钱，`settle()` 还会在 token 总数为 0 时**整行不记**。所以每上一个服务端工具，计量要跟着改一次。

**一处意外的收获**：claude.ai 里编辑任意一条自己的消息会**分叉出一条新对话线**（含它自己那套 artifacts）。我们当初把分叉功能删掉了（`Message.tsx:142-152`），理由是工作目录的副作用没法回滚。自研路径下历史从 `messages` 表重建、没有工作目录副作用，**这条限制自然消失**。

---

## 先说做不到的

「完美复现」有几块注定复现不了，先划掉，免得排期时当成漏项：

1. **Cowork / 桌面应用 / 移动 App / Chrome 扩展 / Claude Design / Claude Science / Claude Tag / Office 插件** —— 都是 claude.ai 账号体系下的独立客户端，不是一个网页能做的
2. **Anthropic 的真实系统提示词** —— 可以对齐，但它会漂，永远不会一致
3. **Artifacts 的完全体**：20MB 持久存储、artifact 里直接调 Claude API（**账单算在查看者头上**）、从 artifact 连 MCP。这是一套沙箱运行时加存储后端加计费归属，工作量约等于前面所有项之和。本计划只做能渲染、能改、有版本的那一档
4. **官方 Connectors 目录**（Gmail / Calendar / Drive / GitHub / M365 / Slack / 1Password / 那八个 interactive connector）—— 是 Anthropic 跟各家谈的 OAuth 集成。我们能做的是通用 remote MCP，然后自己接几个
5. **服务端工具只在 Anthropic 上游上有** —— DeepSeek、openai-chat 上游没有 web_search 也没有 code_execution。多上游是这个项目的卖点，所以模型选择器要按上游降级，而不是让用户点了一个不存在的能力

另外，官方文档里查不到、只能照着实物做的：停止生成按钮、重新生成按钮、键盘快捷键表（应用内 `Cmd+/` 面板是唯一权威）、新对话页的起始提示、PWA。**Response Styles（Normal/Concise/Explanatory/Formal）看起来已经下线** —— 旧博客 404，现在的个性化文档只列 Instructions / Project instructions / Skills。所以样式按 skill 和 instructions 做，不做单独的选择器。

---

## Phase 0 — 分支与骨架

分支 `feature/native-chat`，从 `master` 的 `cf8ef01` 起。

- `AGENT_IDS` 加 `'chat'`：`core/protocol.ts:200` 和 `web/lib/protocol.ts:200`。这两份文件**逐字相同**，`npm run typecheck` 会 diff 它们
- `AgentAdapter` 加 `needsContainer: boolean`。`turns.ts:306` 现在是无条件 `if (containers.enabled())`，改成 `containers.enabled() && adapter.needsContainer` —— 纯对话不该为了聊天拉起一个 1G 内存的容器（生产机现在 1.7G 内存剩 100M free，两个容器就 OOM）
- `registry.ts:18` 的 `adapters` 数组、`CATALOG`、前端 `lib/route.ts:5` 的路由表各加一行
- 新目录 `apps/server/src/app/agents/native/`

`conversations.agent` 是无约束的 text 列（`schema.sql:137`），不用迁移。

## Phase 1 — native runner（纯对话跑通）

最小可用：能流式回答、计费正确、能中断。

**`native/runner.ts`** —— `AgentAdapter` 实现

用 `@anthropic-ai/sdk` 的 `client.messages.stream()`，`baseURL` 指向 `gatewayInternalUrl()`，`authToken` 用 `turns.ts:281` 已经签好的 runtime token。用 SDK 而不是裸 fetch：类型化的 content block、`.finalMessage()`、typed error class，而网关本来就说 Anthropic 协议，指过去即可。

两个必须显式写的参数：

- `thinking: { type: 'adaptive', display: 'summarized' }` —— 当前模型上 `display` **默认是 `omitted`**，不写就只流出空的 thinking 块，界面表现是回答前一段长时间的沉默。claude.ai 那边是一个带**计时器**的 Thinking 指示条，加一段可展开的推理摘要，位置在回答**上方**
- `max_tokens` 流式取 64000；`output_config: { effort }` 接 `conversation.effort`

claude.ai 的 effort 是五档 Low / Medium / High / Extra high / Max，且**和「扩展思考」开关相互独立**。我们现在的 `CLAUDE_EFFORTS`（`claude.ts:428`）已经是这五档，thinking 开关也已经是独立的（`gateway/upstream.ts:566` 按票据 claim 改写），这块对得上。

**`native/history.ts`** —— 从 `messages` 表重建 `MessageParam[]`

这一步取代 `--resume`，`conversations.agent_session_id` 对 native 不用。直接收益：编辑重问就是真的截断历史，**`gateway/redo-trim.ts` 整块对这条路径不必走**（它存在只是因为 CLI 的转录改不了）。

**`native/events.ts`** —— 把 `claude.ts:152-258` 的 block 记账逻辑抽出来共用

那段现在围绕 `{"type":"stream_event","event":{…}}` 信封写，native 拿到的是裸事件，剥掉信封就一样。抽出来两边共用，不要复制一份。

**`native/prompt.ts`** —— 系统提示词，对齐 Anthropic 公开的 claude.ai 系统提示词；另加账号级的「Instructions for Claude」（claude.ai 里这条**连隐身对话也生效**）。

**验证**：`npm run dev:free`（内置假 provider，零成本）发一条消息，看到逐字流式，`usage_records` 里有正确的一行。

## Phase 1b — 分叉（编辑任意一条消息）

claude.ai 的行为：任意一条自己的消息上有铅笔图标，改了就**分叉出一条新线**，带自己那套 artifacts。原线还在。

- `messages` 加 `parent_message_id`，会话变成一棵树；`conversations` 加 `head_message_id` 指向当前这条线的末端
- `history.ts` 从 head 往上走到根，就是这一线的历史
- 前端：分叉点上一个 `‹ 2/3 ›` 的切换器
- 现在的 `truncateFrom` / `restoreMessages`（`core/db/conversations.ts:397-439`）和 `message_trims` 对 native 路径退役

放在这里是因为它依赖 Phase 1 的 history-from-DB，且它改 schema —— 越晚做，要迁移的数据越多。

## Phase 2 — 服务端工具

claude.ai 的能力主要来自这三个加 artifacts。

**工具声明**（按模型分档）：

- `web_search_20260209` / `web_fetch_20260209` —— Opus 5 / 4.8 / 4.7 / 4.6、Sonnet 5 / 4.6；更老的模型退回 `web_search_20250305` / `web_fetch_20250910`
- `code_execution_20260521` + beta `code-execution-2025-08-25`，结果块是 `bash_code_execution_tool_result`（不是裸的 `code_execution_tool_result`）

**一个互斥**：`_20260209` 的搜索/抓取变体内置动态过滤，底下自己跑 code execution，**不能同时再声明 `code_execution`** —— 两个执行环境会让模型犯浑。要 Analysis 工具就得配基础版 `web_search_20250305` + `code_execution_20260521`。这是个产品决定，不是技术细节。

**两个必须处理的返回**：

- `stop_reason: 'pause_turn'` —— 把 content 原样回灌再发一次
- **服务端工具报错不抛异常**：HTTP 200，`web_search_tool_result.content` 成功时是数组、出错时是个 `{error_code}` 对象。先判类型再索引

**Research 模式**（claude.ai 的付费档功能）：不是新工具，是把 `max_uses` 放宽 + 提示词要求多轮检索，跑 5 次以上工具调用、1–3 分钟。界面上是底部一条可点掉的蓝色指示。我们这边等于「一个预设」，但**它会让一轮对话占着并发闸门的 slot 好几分钟**，见下。

**前端**：`web_search_tool_result` / `bash_code_execution_tool_result` 的工具卡片（`lib/tools.tsx:17-88` 加分支）；引用要做成 claude.ai 那样的**行内角标 + 出站链接 + 相关引文**，不是一个链接列表。

**计量（必做，否则这些工具是白送的）**：

| 改什么 | 在哪 |
|---|---|
| `usage` 类型从 `Record<string, number>` 放宽到嵌套对象 | `gateway/usage-parser.ts:32-36` |
| 读 `server_tool_use.{web_search_requests,web_fetch_requests}` 和 `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` | `usage-parser.ts:69-82`、`UsageAcc:11-19`、`absorbBody:114-129` |
| 去掉 `total === 0` 的提前返回 | `gateway/index.ts:868` |
| 价格表加 `price_per_web_search` / `price_per_code_exec_hour` | `schema.sql:301-328`、`pricing.ts` 的 `Pricing`/`UpsertInput`/`add`/`seedDefaults` |
| 计费公式加对应项 | `pricing.ts:255-270` 的 `costMicroExact`、`TokenCounts:227-232` |
| `usage_records` 加列 | `schema.sql:231-262` |
| `SCHEMA_VERSION = 17` + 一个 `if (from < 17)` 的 ALTER 块 | `core/db/index.ts:131` |
| INSERT / SUM / Totals 一起改 | `core/db/usage.ts:16-33, 78-112, 116-171` |
| `TurnUsage` | `core/protocol.ts:13-22`（两份） |

`billable()` 是除以 `*` 行的 input 价换算的（`usage.ts:66`），所以新费用只要进了 `costMicroExact`，自动就变成配额，不用另写。

顺带两处：

- `cache_creation` 的 TTL 拆分现在**整个丢掉**（`usage-parser.ts:75` 只读扁平总数），1 小时缓存写入按 5 分钟的价结算 —— 这是今天就在发生的静默少算
- 并发闸门的背景判定是 `max_tokens <= 512 && !body.tools`（`gateway/index.ts:356`）。只带 `mcp_servers` 不带 `tools` 的请求会被误判成后台排队。而且一轮 Research 会占着一个 slot 好几分钟，全局默认只有 3 个 —— 容量必须重新算，否则一个人做深度研究，全站排队

## Phase 3 — 附件与多模态

现在的附件是把文件名拼成 `"Attached: a.png"` 追加到 prompt（`Composer.tsx:265-284`），靠 CLI 的 cwd 就是会话目录才能打开。native 没有 cwd，必须走真的内容块。

- 图片：`{type:'image', source:{type:'base64'|'url'|'file'}}`
- PDF：`{type:'document', source:{type:'base64', media_type:'application/pdf'}}`，base64 字符串不能带换行
- 引用：每个 document 块加 `citations: {enabled: true}`（全有或全无，混用 400）。回来的 text 块带 `citations` 数组（`cited_text` / `document_index` / `char_location` 或 `page_location`）。注意它和 `output_config.format` 互斥

**对齐 claude.ai 的限制**（照抄，用户才不会撞到我们自己发明的墙）：
- 对话内：500MB/文件、20 个文件/对话、图片 ≤8000×8000、PDF ≤1000 页
- PDF 分档：≤100 页读文字**加图表等视觉元素**；101–1000 页只读文字；>1000 页直接失败
- 非 PDF 文件只做文本抽取，内嵌图片不解读
- 项目里：30MB/文件、数量不限
- 上传路径要三条都有：`+` 菜单、拖拽、**粘贴剪贴板图片**（这三条我们已经有了）

**Files API**：`client.files.upload()` 拿 `file_id`，跨轮复用不重传。两件事要处理：

1. **file_id 是 workspace 维度的，不是用户维度的**（500MB/文件、1TB/组织）。网关是唯一持凭据的组件，所以上传必须经网关代理一个 `/v1/files` 路由 —— 这是网关今天没有的。**而且必须在我们库里记 file_id ↔ user 的归属并在引用时校验**，否则 A 用户猜到 B 的 file_id 就能读到别人的文件。这是新增的一条越权面，不是可选项
2. 只有 skill / code-execution 的**产出**可以下载回来，上传的原件不行

**三个坑，上图片之前必须先处理**：

1. **app 的 `bodyLimit` 是 2MB**（`apps/server/src/index.ts:36`），网关是 32MB（`gateway/index.ts:931`）。附件走 app 路由就卡在 2MB
2. **`redo-trim.ts:110-115` 的 `isUserMessage` 会把会话永久搞死**：它认为「不是全部 `tool_result` 就是人在说话」。一条同时带 `tool_result` 和 `image` 的用户消息会被当成边界，裁剪停在它前面，留下孤儿 `tool_result` → API 400，而 trim 规则不过期 → **这个会话永远 400**。这正是那个函数的注释（`:101-109`）说它要防的事。Phase 1b 之后 native 路径不走 redo-trim，但 claude / codex 路径还在走，所以还是得修
3. **`openai-chat` 上游会静默吞掉 document**：`translate.ts:107-133` 的 `contentOf` 只认 text / image / tool_result，`:202` 又筛一次，`source.type === 'file'` 也没有分支。要么补，要么在模型选择时就挡住

## Phase 4 — Artifacts 与行内可视化

claude.ai 这块其实是**两个东西**，先做便宜的那个。

**4a 行内自定义可视化**（claude.ai 2026-03-12 上的 custom visuals）：模型在回答里直接嵌一段图表 / 图解 / 交互 HTML，**默认是临时的**，用户可以「复制为图片」「下载 .svg/.html」「另存为 artifact」。点可视化内部会**发出一条追问**。这个不需要版本、不需要存储、不需要发布，成本低而观感提升最大。

**4b Artifacts**：模型用一个客户端工具 `artifacts`（create / update / rewrite）写内容，落到新表 `artifacts`（版本 = 多行），前端右侧面板渲染。

- **硬前提**：claude.ai 里 artifacts 依赖「代码执行和文件创建」开着。我们这边等价于 Phase 2 必须先完成
- 类型：Markdown 文档 / 代码片段 / 单页 HTML / SVG / Mermaid 图 / **交互式 React 组件**。触发条件是内容自包含且通常 >15 行
- 一个对话可以有多个 artifact，右上角切换器决定更新哪一个
- 版本选择器在不同迭代间切换；手动改不影响模型记得的原版
- 报错时的「Try fixing with Claude」按钮 —— 把错误详情塞进一条新消息
- iframe 用 `srcdoc` + `sandbox="allow-scripts"`，**不给 `allow-same-origin`**（两个一起给等于没有沙箱）。React 需要在 iframe 里带 React + Babel standalone，或者服务端预编译
- **发布/分享**：只有被选中的那个版本变公开，对话本身仍私密，页面带 `noindex`。取消发布**不可逆**且会删掉该 artifact 的全部持久化数据

**4c 完全体**（持久存储、调外部 API、连 MCP）单独立项，不在这个分支。

## Phase 5 — Projects

- 新表 `projects`（id, user_id, name, description, instructions, created_at, starred, archived）+ `project_files`；`conversations` 加 `project_id`
- `name` / `description` 是给人看的，**模型看不到**（claude.ai 就是这样）；`instructions` 才进 system prompt
- 对话可以在项目之间移进移出，移动时它的记忆也在「项目记忆」和「通用记忆」之间搬
- **项目可以加星**（置顶到侧栏）和**归档**（沉到底部单独标签页，对话仍可访问，归档状态下不能删）。注意：claude.ai 的星标和归档**只有项目有，对话没有**
- 项目内的知识库用 RAG：知识量接近上下文上限时自动启用，容量放大到 10 倍，界面上有「RAG-enabled」标记，模型侧表现为一个可见的 `project knowledge search` 工具调用
- **注意一条反直觉的语义**：同一项目里的两个对话**不共享上下文**，只共享知识库

**和现在的工作目录模型冲突**：现在是 `workspaces/<user>/<convId>/`，**删对话即删目录**（`routes/conversations.ts:103`）。Project 的语义是跨对话持久，所以目录要提到 `workspaces/<user>/projects/<projectId>/`。这条改动摊到 `workspace.ts`、`turns.ts:271` 和删除路径 —— 是本期最大的一处结构改动。

## Phase 6 — Memory / Connectors / 长会话

**Memory**：`{type:'memory_20250818', name:'memory'}` 是**客户端工具**，存储后端由我们实现 —— 正好接现有的 `app/memory.ts`（已经有 CRUD、快照、20 层撤销、60 条 / 8KB 上限）。TS SDK 有 `betaMemoryTool` helper。

对齐 claude.ai 现在的形态（2026-07-10 换过一次）：

- 是**按主题分条**的条目，对话进行中就写，不是每天汇总一次
- 设置页按 Topic 列出，可读、**可编辑**、可删；还有一个「告诉 Claude 要改什么」的输入框
- **暂停**（保留条目但不读不写）和**重置**（永久删除，含项目记忆，不可逆）是两个不同动作
- 每个项目有自己独立的记忆空间
- **敏感话题默认不记**（健康、种族、宗教、政治、性别认同），要开得单独开且不追溯；证件号、犯罪记录、金融账号、移民身份**说了也不记**
- **删除对话不会删掉从它派生的记忆** —— 这条要在界面上说清楚，不然是个隐私投诉
- **隐身对话**：不入历史、不入记忆、不可搜索、不套用已有记忆、不进月度回顾，但**账号级 instructions 仍然生效**；项目内不可用；开了就不能转成普通对话

**Connectors**：`mcp_servers: [{type:'url', url, name}]` **加上** `tools: [{type:'mcp_toolset', mcp_server_name: 同名}]`，beta `mcp-client-2025-11-20`。只给一半是验证错误。

- 每个连接器的工具权限分「只读」和「写/删」两组，每项可设 **总是允许 / 需要批准 / 禁止**。这要求做一套审批 UI —— 我们现在是 `bypassPermissions` 一刀切，这是第一次需要真正的审批流
- 工具接入模式三档：**Auto**（默认）/ **总是可用**（<10 个连接器）/ **按需**（10 个以上，省上下文）
- ⚠️ claude.ai 的自定义连接器是**从 Anthropic 云侧连出去的，不是从用户设备**。我们如果从自己的服务器连，网络可达性和出网审计（`core/egress.ts` 的 fail-closed）都要一起考虑

**长会话**：beta `compact-2026-01-12` + `context_management: {edits:[{type:'compact_20260112'}]}`。**必须把整个 `response.content` 回灌**，只取 text 会静默丢掉 compaction 块、压缩状态就没了。

- claude.ai 的压缩也**依赖代码执行开着**，界面上是一句「organizing its thoughts」，**压缩本身不计入用量**。我们要不要照办是个计费决定，但至少要在 `usage_records` 里能区分出来
- claude.ai 没有上下文百分比进度条，只有那句提示。别自己发明一个
- 另一个选择是 context editing（beta `context-management-2025-06-27` + `clear_tool_uses_20250919`），那是「清除」不是「摘要」，便宜但会丢内容

## Phase 7 — 对话层补齐

全是 APP 侧，不依赖上游，可以并行做。

**搜索**：claude.ai 的对话搜索是**语义检索**，表现为一次工具调用（「我们之前聊过的 X」），范围是全部非项目对话或单个项目内。SQLite FTS5 做不到语义，但能做到关键词召回 —— 先上 FTS5，把它包成一个工具给模型调，形态就对了。

**分享，三套机制，claude.ai 是分开的三个东西**：

1. **公开链接** —— 时间点快照（之后的消息不会自动进去，要手动「更新」）、只读、**附件不包含**、MCP/连接器的原始工具输出隐藏、artifacts 包含在内、页面 `noindex`、可随时撤销但撤不回已复制的内容
2. **指定人分享** —— 链接**绑邮箱**，转发无效；邀请 30 天过期；收件人只读、不能继续、不能复制到自己账号、不能再分享；可单个撤销
3. **artifact 单独发布** —— 见 Phase 4

**其余**：整条消息的复制按钮（现在只有代码块有）、`⌘K` 命令面板（应用内 `Cmd+/` 是 claude.ai 的快捷键权威来源）、批量删除对话、导出数据（链接 24 小时过期）、语音输入（浏览器 `SpeechRecognition`，零后端）、**可点击的交互式输入组件**（多选/排序，claude.ai 在对话底部渲染这些，同时仍可打字）。

**不做**：对话的置顶和归档 —— claude.ai 没有，只有项目有。

顺手修掉调研中发现的四个 bug：`/api-keys` 不在 `normalizePath` 的 KNOWN 列表（`route.ts:104-115`）、`AgentSwitcher.tsx:33` 的 `navigate` 少前导斜杠、`ui.tsx:344` 的 `fmtDate` 对所有语言硬编码 `zh-CN`、`Sidebar.tsx:70` 重命名预填过期标题。

---

## 验证

- **每期都能 `npm run dev:free` 跑通**（内置假 provider，零成本走全链路）
- `npm run typecheck` 卡着六项机器校验：分层边界、两个 compose 一致、env 转发、九语言 i18n 覆盖率、价格表、`protocol.ts` 双份逐字一致
- **计量正确性**用 `npm run dev:trace`（trace 代理）核对：一轮带搜索的对话，`usage_records` 的行数和金额要能手算对上
- 新增测试（`apps/server/src/**/*.test.ts`，`node scripts/test-all.mjs` 跑）：
  - history 从 `messages` 表重建的正确性，含分叉后走哪一条线
  - server tool 的 usage 解析（喂一段录下来的 SSE，断言四个 token 计数器加两个新计数器）
  - **带 image 的 redo-trim 不产生孤儿 `tool_result`** —— Phase 3 的回归闸
  - **Files API 的 file_id 归属校验**：A 用户引用 B 的 file_id 必须被拒
- 手动对照：拿 claude.ai 开一个同样的对话，逐条比行为（思考指示、引用角标、artifact 版本切换、隐身对话的记忆隔离）

## 工作量

以 DESIGN §15 里 M0–M7 共 26 人日为标尺：

| | 人日 |
|---|---|
| Phase 0–1 native runner | 3 |
| Phase 1b 分叉（schema 改动） | 3 |
| Phase 2 服务端工具（计量占一半） | 5 |
| Phase 3 附件与多模态（含 Files API 越权校验） | 5 |
| Phase 4a 行内可视化 | 2 |
| Phase 4b Artifacts | 5 |
| Phase 5 Projects（含工作目录迁移） | 5 |
| Phase 6 Memory / Connectors / 压缩（含审批 UI） | 7 |
| Phase 7 对话层补齐 | 5 |

约 **40 人日**到「用起来像 claude.ai」，不含 Artifacts 完全体、Cowork 和那一堆独立客户端。

Phase 1 结束就有可用的东西；Phase 2 结束就已经不像 Claude Code 了；Phase 4a 是性价比最高的一格（2 人日换来观感上最像 claude.ai 的那个东西）。
