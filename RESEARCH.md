# AgentLodge — 现状评估、业界对标与下一步候选

> 调研稿 · 2026-09-14 · **只是研究，没有实施。** 分支 `research/roadmap-2026-09`。
>
> 目的是把一轮代码审查加一轮业界调研的结论写下来，供排期时逐条讨论。每一条都带
> 「为什么」和出处，好让它能被逐条否决，而不是整份接受或整份放弃。

---

## 0. 怎么做的

**代码这边**：读了 README / MANUAL / DESIGN、全部路由清单、`schema.sql`、`gateway/index.ts`、
`core/db/pricing.ts`、`core/config.ts`、`app/containers.ts`、`web/lib/i18n.ts`；跑了
`npm outdated` 和 `npm audit`；上生产机看了备份目录、内存、磁盘和各容器的占用。

**业界这边**，看了十个项目，按和我们重叠的层分三类：

| 层 | 项目 |
|---|---|
| 订阅 / API 中转网关 | sub2api（CRS 2.0）、new-api、LiteLLM、CLIProxyAPI、teamclaude |
| 多用户聊天平台 | LibreChat、Open WebUI |
| Claude Code 的远程 / 网页壳 | claudecodeui（CloudCLI）、Happy Coder、OpenHands，以及 Anthropic 官方的 Claude Code on the web / Remote Control / Routines / self-hosted runner |

**DeepSeek**：官方价格页与 thinking 文档，2026-09-14 抓取。它 9 月 10 日刚换过阵容，
第三方价格聚合站多数还是旧数，所以只信官方页。

---

## 1. 现状评估：待办清单

### 1.1 P0 —— 现在就在算错账，或者会丢数据

| # | 问题 | 位置 | 为什么 |
|---|---|---|---|
| 1 | **DeepSeek 价格表过期** | `core/db/pricing.ts:256-257`、`web/lib/model-facts.ts:51-52` | 9/10 起新的 ID 是 `deepseek-flash`（V4.1 Flash），表里**没有这一行**。`resolve()` 是精确匹配 → 最长前缀 → `*` 兜底，`deepseek-flash` 对不上 `deepseek-v4-*` 任何前缀，落到 `*` 的 $5 / $25 —— 按金额计费时贵 **33 倍**。`deepseek-v4-pro` 的种子价 0.435 / 0.87 是 4 月 preview 价，官方现价非高峰 0.66 / 1.98，少算一半。`deepseek-v4-flash` 已退役（请求仍可用，按 flash 价结算）。种子只在首次启动写入，**线上库要手动改**，后台 → 系统设置 → 价格表 |
| 2 | **价格表没有分时维度** | 同上 | DeepSeek 周一至周五 UTC 01:00–04:00、06:00–10:00 是高峰，全线 ×2。一行只能填一个数，`note` 提醒一句就完了。要么价格行加时段，要么至少后台标出「当前时段」。见 §4 |
| 3 | **SQLite 没有自动备份** | 生产机 `/root/AgentLodge/db-backup/` | 现有的是手工 `cp` 出来的 `-wal` / `-shm` 文件，主库和 WAL 分开拷，**不是一致快照**，恢复出来可能对不上。应该 `sqlite3 .backup` 或 `VACUUM INTO`，cron 定时，再推到别的机器。库本身只有 36M，一分钟的事 |
| 4 | **nodemailer 两个高危** | `npm audit` | GHSA-cc9r-2j5m-2m83：收件域校验绕过，邮件可被投到攻击者控制的域。`npm audit fix` 可修。CI 的 verify 不跑 audit（DESIGN §13 自己写着「手动跑」） |

### 1.2 P1 —— 运维与健壮性

| # | 问题 | 为什么 |
|---|---|---|
| 5 | **环境变量 ↔ compose 的转发检查** | `TRUST_PROXY` 那个 bug（#43）：代码读了、两个 compose 都没转发、`.env` 里设了等于没设，没有任何检查能发现。扫 server 源码里的 `process.env.X`，断言每个都出现在两个 compose 里，几十行的 `check-env.mjs` |
| 6 | **生产机容量到边了** | 1.7 G 内存剩 100 M free；每个 agent 容器上限 1 G（`config.ts:240`，`CONTAINER_MEMORY_MB`）→ **两个人同时开工就 OOM**。磁盘 47 G 用了 73%。要么调小限额，要么升配 |
| 7 | **没有 `/metrics`，没有告警** | DESIGN §14 承认。余额低、429 激增、排队 p95、磁盘满 —— 现在全靠人看。LibreChat 也是今年 5 月（v0.8.6）才加 Prometheus + OTel，不算落后，但该做。`/gate` 和 `/upstream-allowance` 两个 JSON 端点已经有了，先接一个 exporter |
| 8 | **没有每用户磁盘配额** | DESIGN §13 承认。一个用户 `npm install` 几次就能把盘吃满，连带所有人 |
| 9 | **缺 CSP** | `docker/Caddyfile` 发 HSTS / X-Frame-Options / nosniff，没有 Content-Security-Policy。Markdown 渲染 + 用户上传文件预览的场景值得有 |
| 10 | **依赖大版本落后** | shiki 1→4、vite 6→8、TypeScript 5→7、react-markdown 9→10、@vitejs/plugin-react 4→6、@fastify/cors 10→11、nodemailer 9→10。没有 Dependabot / Renovate |
| 11 | **多实例部署**（已知，M5） | 并发闸门和事件总线是进程内的；`ROLE` 拆开后 `queue.waiting` 到不了浏览器（DESIGN §2.6） |
| 12 | `notes.md` 里有一把 `al_` key 明文 | 已在 `.gitignore`，不会泄漏；只提一句 |

### 1.3 P2 —— 代码质量与性能

| # | 问题 | 为什么 |
|---|---|---|
| 13 | **前端零测试** | 45 个套件全在 server；测试是 tsx 脚本不是框架。web 那边 `store/chat.ts` 1214 行、`lib/api.ts` 1218 行，没有任何自动化覆盖 |
| 14 | **`handleProxy` 一个函数 600 行** | `gateway/index.ts:247-846`。鉴权、路由、闸门、翻译、流解析、记账全在一个函数里 |
| 15 | **八个语言包全部静态打进主 chunk** | `web/lib/i18n.ts:3-10` 静态 import 全部 locale；源码 357 KB，主 chunk 888 KB。按语言 `import()`，能砍三分之一以上 |
| 16 | **长会话无虚拟滚动**（已知） | |
| 17 | **`protocol.ts` 双份副本**（已知） | 靠 typecheck 逐字比对。抽成 workspace 包 `@agentlodge/protocol`，比对脚本就能删 |

### 1.4 做得好的地方，别动

全仓 `any` 只有一处。i18n 覆盖率、两个 compose 的一致性、价格表与选择器的一致性、
server / gateway 分层，都有脚本卡在 `npm run typecheck` 里。注释里记的是「为什么」而不是
「是什么」，实测结论（DESIGN §16）单独成节。这些是这个仓库的资产。

---

## 2. 业界对标

### 2.1 它有、我们没有的

**A. 订阅 / API 中转网关**（和我们的网关层重叠最多）

| 项目 | 定位 | 它有、我们没有 |
|---|---|---|
| sub2api（CRS 2.0） | Go + PostgreSQL + Redis；把多个 Claude / OpenAI / Gemini / Grok 订阅拼成 API 池。中文社区最火的一个，前身 claude-relay-service | **多账号池 + 粘性会话调度**；账号级代理和冷却（503 / 5xx 的 TTL）；分组 + 组、账号两级倍率；**支付（支付宝 / 微信 / Stripe）+ 兑换码**；用户自助门户；LDAP；webhook 通知 |
| new-api | one-api 的继任，Go，AGPL | 充值 / 兑换码 / 邀请返利；按次计费；渠道加权 + 失败自动禁用 + 重试；**OIDC / LinuxDO / Telegram / Discord 登录**；多格式互转（含 Gemini）；模型名后缀控制 thinking（`-high`、`-thinking`） |
| LiteLLM | Python 网关，53K star | **org → team → project → key 四级预算**；软预算邮件告警；临时预算提升；按 tag 预算；key 自动轮换；对接 KMS / Vault |
| CLIProxyAPI、teamclaude | 把 CLI 的 OAuth 包成 API | 429 时自动换号重试 |

**B. 多用户聊天平台**

| 项目 | 它有、我们没有 |
|---|---|
| LibreChat | **MCP**；agents / subagents；**共享链接**；fork 对话；**对话搜索**；导入对话；Prometheus + OTel；Admin Panel（2026 路线图） |
| Open WebUI | **RBAC 分组**（附加式权限）；知识库 RAG；Channels（群聊 @ 模型）；pipelines 插件；SCIM / LDAP。反过来：它**只跟踪用量、不强制**，社区讨论 #23558 还在提案阶段 —— 这是我们明显领先的地方 |

**C. Claude Code 的远程 / 网页壳**

| 项目 | 它有、我们没有 |
|---|---|
| claudecodeui / CloudCLI（13.5K star，AGPL） | **项目 = 目录，跨会话持久**；文件编辑器；**git 面板**（stage / commit / 切分支）；终端；worktree；浏览器；插件系统（cron 调度、token 燃烧率……）；导出 md / html / pdf；全文搜索；TaskMaster / MCP。但：单租户，无计量 |
| Happy Coder | **手机推送**（需要审批、出错时）；端到端加密；语音；设备间切换 |
| OpenHands | Agent Canvas 用 ACP 协议接任意 agent；定时自动化；headless REST |
| Anthropic 官方 | Claude Code on the web：云沙箱 + GitHub 集成 + teleport。**Routines**：cron / API / GitHub 事件触发。self-hosted runner（2.1.224，Team / Enterprise）—— 注意它**推理必须直连 Anthropic，不能走网关**，和我们的计量模型是冲突的，不是替代品 |

### 2.2 我们有、它们多数没有的

每用户容器隔离且容器内无凭据；turn 内配额刹车；把用户自己的额度改写进响应头让 CLI
状态栏显示；审计代理全量抓包；自写记忆 + 使用画像；九种语言；凭据独立成一个服务。
这个组合在上面十个里没有第二家 —— 做取舍时别把它们当理所当然。

---

## 3. 可借鉴的功能

括号里是出处。

### 3.1 用户交互

1. **权限审批 UI**。现在 `PERMISSION_MODE` 默认 `bypassPermissions`（`config.ts:54`），一刀切。
   Claude Code 的 `--permission-prompt-tool stdio` + `--input-format stream-json` 会把权限请求以
   `control_request` 发到 stdin / stdout，前端可以弹卡片让用户允许或拒绝；顺便就能做 **plan 模式**。
   wire 格式官方文档没写全，有第三方逆向文档可参考。（Claude Code headless）
2. **手机通知**。Web Push：turn 完成、需要审批、出错、额度到 90%。（Happy Coder）
3. **对话搜索**。SQLite FTS5，零依赖。M4 已经列了。（LibreChat、CloudCLI）
4. **分享链接**。只读、可撤销、可选是否带工具卡片。（LibreChat）
5. **`/` 命令面板 + 快捷键**。`/compact`、`/clear`、`/model`，`⌘K` 切会话。
6. **会话文件夹 / 置顶 / 归档**。`conversations` 有 `parent_id`（线程）和 `title_custom`，
   没有 archived / pinned。
7. **语音输入**。浏览器 `SpeechRecognition`，零后端。

### 3.2 功能

8. **持久项目（目录 / git 仓库）跨对话**。目前工作区是 `workspaces/<user>/<conv>/`，
   **删对话即删目录**（`routes/conversations.ts:103`）。这是和 CloudCLI、Claude Code on the web
   最大的一条差距：没法「在同一个仓库上开第二个对话」。配套 git 面板和 diff 查看。
9. **MCP 服务器配置**（全局 + 每用户）。LibreChat / Open WebUI / CloudCLI 都有；容器里
   `--mcp-config` 一挂就行。
10. **定时任务 / Routines**。cron 触发一个对话：日报、依赖升级、代码审查。（官方 Routines、
    CloudCLI Scheduler 插件）
11. **用户分组 + 组级配额 / 倍率**。现在配额只到个人。（LiteLLM team、new-api 分组、Open WebUI groups）
12. **多凭据池调度**。credential-manager 已经能存多把凭据，缺的是「一个模型 → 多凭据 →
    轮转 / 429 换号 / 粘性会话」。sub2api 的核心卖点，对拼车场景是刚需。
13. **OIDC 登录**。组织内部署必备。（new-api、LibreChat、Open WebUI）
14. **webhook 通知**。注册、超额、上游故障。（sub2api、Open WebUI）
15. **图片输入**。`gateway/translate.ts` 已支持 image 块，Composer 不允许贴图；
    `deepseek-flash` 现在支持视觉，见 §4。
16. **API key 增强**。现在只有名字和撤销；可加过期时间、模型白名单、单 key 预算。（LiteLLM、new-api）

### 3.3 性能

17. locale 按需加载（§1.3 #15）。
18. 虚拟滚动（§1.3 #16）。
19. `/api/me/quota` 等轮询改为事件推送，和 M5 一起做。

---

## 4. DeepSeek 专题

**现状**：项目已经把 DeepSeek 当一等上游 —— `/anthropic` 兼容层、余额 API（DESIGN §9）、
`adaptive → enabled` 的 thinking 方言翻译（`gateway/upstream.ts:566`）。基础是打好了的。

**9 月 10 日之后的 DeepSeek**（官方价格页）：

| | `deepseek-flash`（V4.1 Flash） | `deepseek-v4-pro`（V4-Pro-0813） |
|---|---|---|
| 输入 / 输出，每 1M，非高峰 | **$0.15 / $0.60** | $0.66 / $1.98 |
| 高峰（周一至五 UTC 01–04、06–10） | ×2 | ×2 |
| 缓存命中（非高峰） | $0.003 | $0.022 |
| 上下文 / 最大输出 | 1M / 384K | 1M / 384K |
| 图片输入 | ✓ | ✗ |
| thinking | 默认开；effort `low` / `high` / `max`；Anthropic 格式用 `output_config.effort` | 同 |
| 原生 Responses API | ✓ | ✓ |
| 并发上限 | 2500 | 500 |

对比：flash 是 Claude Sonnet 5（$2 / $10）的 **1/13**，Opus 5 的 **1/33**。权重 MIT 开源。
V4 Pro 原计划 9/14 下线，官方已改口继续提供，计费不变。

**基于这些能做的事，按性价比排：**

1. **「工具模型」设置。** 标题、摘要、画像、记忆候选这些内部调用（`app/recap.ts:408`
   现在是 `config.model || 'claude-haiku-4-5'`，`config.model` 来自 `MODEL` 环境变量）固定走
   `deepseek-flash`，和用户选的主模型解耦。一次摘要约等于被总结对话 1% 的 token，用 flash
   几乎免费 → 「打开画像页才补摘要」可以改成**每轮自动**，进而做语义标签、更好的对话搜索、
   自动归类。
2. **分时计费 + 时段提示。** 就是 §1.1 #2。做到位的话，后台显示「现在是半价时段」，
   甚至配额允许用户在非高峰多用。
3. **Codex 直连原生 Responses。** 现在 Codex 流量被 `gateway/translate.ts` 翻成 chat
   completions，翻译层**不带 thinking 块和 cache 标记**（MANUAL 已知限制）。DeepSeek 文档明确：
   chat 格式下 `tools` + thinking 必须回传 `reasoning_content`，否则 400 —— 翻译层迟早踩这个坑。
   加一个 `openai-responses` 的 provider kind 直接透传，两个问题一起解决。
4. **图片输入**（§3.2 #15）。flash 支持视觉，Composer 放开贴图，anthropic-native 路径透传即可。
5. **自动路由 / 降级。** 简单轮次走 flash、复杂走 pro 或 Claude；用户额度快用完时自动降到
   flash 而不是直接 402。（LiteLLM fallback、new-api 渠道重试的思路）
6. **1M 上下文。** 长对话不用怕 compact；但 384K 输出加 `max` 思考一次能烧很多，配额提示要跟上。
7. **配额单位。** 按 token 计费时 flash 和 Opus 一个权重不合理；项目已有按金额模式，或者
   加 new-api 那种「模型倍率」。
8. **两点注意。** DeepSeek 数据落在中国境内（合规视角）；它的并发上限远高于我们闸门默认的 3
   —— 闸门是按 Anthropic 订阅调的，DeepSeek 上游可以单独放宽。

---

## 5. 候选方向与建议顺序

上面的功能清单里，§3.2 的 #8、#1（审批 UI）、#12 三件决定产品往哪边走，先定方向再排它们：

| 方向 | 一句话 | 主要投入 | 最像的对手 |
|---|---|---|---|
| **A. 团队拼车网关** | 多凭据池调度、分组倍率、支付 / 兑换码、OIDC、webhook | 网关与后台，前端改动小 | sub2api、new-api |
| **B. 团队版 Claude Code on the web** | 持久项目 + git 面板、审批 UI + plan 模式、MCP、定时任务、手机推送 | 前端与容器编排，网关基本不动 | CloudCLI、官方 web |

两个方向不互斥，但同时做等于两边都做一半。

**不管选哪个，建议这样排：**

- **本周**：§1.1 全部四条。价格表（线上账正在算错）、`npm audit fix`、备份 cron、分时至少加 note。
  加起来不到半天。
- **下一批**：§1.2 #5 env 检查、#6 容量；§4 的第 1 条（工具模型走 flash）和第 3 条（Responses 透传）。
- **然后**：按选定的方向从 §3 里挑。

---

## 附：来源

- DeepSeek：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) ·
  [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) ·
  [V4 Preview Release](https://api-docs.deepseek.com/news/news260424/)
- 网关类：[sub2api](https://github.com/Wei-Shaw/sub2api) ·
  [claude-relay-service README_EN](https://github.com/Wei-Shaw/claude-relay-service/blob/main/README_EN.md) ·
  [sub2api 源码精读](https://inferloop.dev/source-reading/sub2api/) ·
  [new-api](https://github.com/QuantumNous/new-api) ·
  [One API vs New API 2026](https://www.apiseven.com/one-api-vs-new-api) ·
  [LiteLLM Budgets & Rate Limits](https://docs.litellm.ai/docs/proxy/users) ·
  [LiteLLM Enterprise](https://docs.litellm.ai/docs/enterprise) ·
  [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) ·
  [teamclaude](https://github.com/KarpelesLab/teamclaude)
- 聊天平台：[LibreChat](https://github.com/danny-avila/librechat) ·
  [LibreChat 2026 Roadmap](https://www.librechat.ai/blog/2026-02-18_2026_roadmap) ·
  [LibreChat v0.8.6](https://www.librechat.ai/changelog/v0.8.6) ·
  [Open WebUI RBAC](https://docs.openwebui.com/features/authentication-access/rbac/) ·
  [Open WebUI usage limits 讨论](https://github.com/open-webui/open-webui/discussions/23558)
- Claude Code 壳：[claudecodeui / CloudCLI](https://github.com/siteboon/claudecodeui) ·
  [Happy Coder features](https://happy.engineering/docs/features/) ·
  [OpenHands ACP](https://www.openhands.dev/blog/use-any-coding-agent-in-openhands-with-acp)
- Anthropic 官方：[Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments) ·
  [Introducing routines](https://claude.com/blog/introducing-routines-in-claude-code) ·
  [Remote Control](https://code.claude.com/docs/en/remote-control) ·
  [Headless](https://code.claude.com/docs/en/headless) ·
  [CLI 协议（社区逆向）](https://github.com/Roasbeef/claude-agent-sdk-go/blob/main/docs/cli-protocol.md)
