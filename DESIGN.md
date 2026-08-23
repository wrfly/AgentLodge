# AgentLodge — 基于 Claude Code + DeepSeek 的多租户 AI 对话服务

> 详细设计文档 v1.0 · 2026-08-17

---

## 0. 一句话概括

用户在 Web（桌面/移动）上用高仿 Claude 的界面对话；每个用户在服务器上有一个**独立容器 + 独立工作目录**，容器里跑的是 **Claude Code CLI（headless 模式）**；Claude Code 的 API 请求不直连 DeepSeek，而是全部经过我们自研的**计量网关**——网关负责鉴权、记账、配额闸门和**全局并发限速（最多 3 路 in-flight）**；管理员可以给每个用户配额，用户能实时看到自己用了多少、账户还剩多少钱。

---

## 1. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | React 19 + Vite + TypeScript + TailwindCSS | 一套代码适配桌面/移动，组件自写（lucide-react 提供图标） |
| 前端状态 | Zustand | UI 状态与服务端状态都在这一层，规模用不上第二个库 |
| 路由 | 自写（~120 行） | 路由不到十条，router 库的体积和概念都不划算 |
| Markdown | react-markdown + remark-gfm + Shiki | 代码高亮用 Shiki（和 VSCode 同引擎） |
| 后端 | Fastify + TypeScript | 单体规模用不上 DI 容器 |
| 计量网关 | 同一个包，`ROLE=gateway` 单独起进程 | 代码本就是独立的 Fastify app，拆容器零成本 |
| 数据库 | SQLite（`node:sqlite`，WAL） | 单机足够；双进程共享一个库文件实测可行，无需 ORM |
| 事件流 | 进程内 pub/sub + SSE | 单机不需要外部消息系统；多实例时要换（§7.4） |
| 容器 | Podman / Docker CLI，经挂进来的 socket | 不用 dockerode：`exec` 的 stdout 就是 CLI 的 stdout |
| 反向代理/TLS | Caddy 2 | 自动 HTTPS |
| Agent | Claude Code CLI、Codex CLI，`ANTHROPIC_BASE_URL` 指向计量网关 | |
| 上游模型 | provider 注册表，可增删改切 | 官方 Anthropic、DeepSeek 兼容层、本机假上游都支持 |

---

## 2. 总体架构：角色定义与请求路径

### 2.1 四个角色

| # | 名字 | 端口 | 在哪 | 有凭据吗 | 有工具吗 |
|---|---|---|---|---|---|
| ① | **应用服务**（app） | 8787 | 宿主机 / app 容器 | — | — |
| ② | **容器内 CLI**（agent） | — | 每用户一个容器 | ❌ 只有一次性票据 | ✅ **在容器里执行** |
| ②′ | **用户自带 CLI** | — | 用户自己的机器 | ❌ 只有长期 api key | ✅ **在用户机器上执行** |
| ③ | **计量网关**（gateway） | 8788 | 宿主机 / gateway 容器 | ✅ 真凭据只在这里 | — |
| ④ | **上游**（upstream） | 视配置 | 视配置 | 自己的 | 见 §2.3 |

开发时 ① 和 ③ 同进程（少起一个进程），部署时靠 `ROLE=app` / `ROLE=gateway` 拆成两个容器 ——
网关才能单独接进 internal 网络。代码本来就是两个独立的 Fastify app，目录也是分开的（见 §2.1b）。

**命名约定**：「网关」一词只指 ③。`gateway/` 目录下若有别的服务（如凭据注入层），
它们是 ④ 那一侧的东西，文档里不叫「网关」，避免和计量网关混淆。

### 2.1b 代码分层

①③ 同在 `apps/server` 一个包里，内部按三层切开，靠 `ROLE` 决定跑哪半边：

```
apps/server/src/
├── core/       3.3k 行 / 20 文件   两边都能用，谁都不依赖
│     config · protocol · quota · events · runtime-token
│     auth/{crypto,guard,tokens} · db/（13 张表 + schema.sql）
├── app/        3.6k 行 / 25 文件   ① 主服务
│     routes/{auth,conversations,me,admin/(10)} · agents/(7)
│     turns · containers · workspace · memory · mail
├── gateway/    1.7k 行 /  5 文件   ③ 计量网关
│     index(403) · gate(276) · translate(646) · upstream(251) · usage-parser(159)
└── index.ts    123 行             装配点，两边都 import
```

**规则：core 谁都不依赖，app 和 gateway 不许互相依赖。**
`scripts/check-layers.mjs` 机器校验，挂在 `npm run typecheck` 里，越界退出码 1。

之所以要机器查而不是靠自觉：两层现在同进程跑（`ROLE=all`），越界 import 一样能跑通，
拆容器部署才会暴露 —— 那时的表现是「dev 好好的，线上静悄悄少了点东西」。
这个检查第一次跑就抓出三处历史越界：

| 越界 | 处理 |
|---|---|
| `app/turns → gateway/runtime-token` | 票据是两层的**契约**（app 签、gateway 验），挪进 core |
| `admin/shared → gateway/index`（直读 gate 对象） | 改成一律 HTTP 问网关，**顺带根治了「读到空壳 gate、界面一片 0」的 bug** |
| `admin/gate → gateway/index` | 同上 |

几条不显然的归属：`runtime-token` 在 core（两层契约）；`events` 在 core
（gateway 要推 `queue.waiting`，见 §2.6）；`agents/provider` 在 app
（只有 app 需要知道 agent 往哪连）。

### 2.2 请求路径

```
                    ┌─────────────────────────────────────────────┐
                    │  浏览器  :5173（dev）/ Caddy（部署）          │
                    └────────────────────┬────────────────────────┘
                                         │ REST + SSE
                    ┌────────────────────▼────────────────────────┐
                    │  ① app  :8787                               │
                    │     认证 / 会话 / 配额 / 管理后台            │
                    │     podman exec 拉起 CLI（stdout 即事件流）   │
                    └────────────────────┬────────────────────────┘
                                         │ podman exec -i
                    ┌────────────────────▼────────────────────────┐
                    │  ② 容器内 CLI  agentlodge-agent-<uid 前12位>    │
                    │     uid 10001 · CapDrop ALL · no-new-privs   │
                    │     只挂 /workspace（该用户自己的目录）        │
                    │     HOME 持久化在 <用户目录>/.agent-home      │
                    │     凭据 = 票据，绑 (user, conversation,     │
                    │            turn)，20 分钟过期                │
                    └────────────────────┬────────────────────────┘
                                         │ Anthropic /v1/messages
                                         │ 或 OpenAI Responses（codex）
   ┌─────────────────────────────────────▼──────────────┐
   │  ◆ trace 代理 :8796   位置 B（可选，见 §2.4）      │
   └─────────────────────────────────────┬──────────────┘
                    ┌────────────────────▼────────────────────────┐
                    │  ③ 计量网关  :8788                          │
                    │     ① 验票据 → 归属 user/turn               │
                    │     ② 配额硬闸门（超额 402/429）             │
                    │     ③ 全局并发闸门 + 用户级公平队列 + AIMD    │
                    │     ④ 协议翻译（仅 openai-chat 上游需要）     │
                    │     ⑤ 票据换成真凭据                         │
                    │     ⑥ SSE 字节透传 + 旁路嗅探 usage → 落账   │
                    └────────────────────┬────────────────────────┘
   ┌─────────────────────────────────────▼──────────────┐
   │  ◆ 审计代理 :8796   位置 A（默认关，后台开）          │
   │    一个实例服务所有上游，按 x-forwarded-host 分流     │
   │    没配 → 网关 503，不静默直连（fail closed）        │
   └─────────────────────────────────────┬──────────────┘
                    ┌────────────────────▼────────────────────────┐
                    │  ④ 上游                                     │
                    └─────────────────────────────────────────────┘
```

**关键**：④ 返回的 `tool_use` / `tool_calls` **原路穿回 ②，在容器里执行**。
③ 只窥探不改写字节流 —— 改一个字节都可能弄坏 CLI 的解析。

### 2.2b ②′ 用户自带 CLI —— 同一个 ③，② 换个位置

用户把本机的 `claude` / `codex` 的 BASE_URL 指到我们，共用同一个账号、同一份额度。

```
用户笔记本                            我们
┌──────────────────┐
│ ②′ claude/codex  │
│    工具在这儿执行  │──── al_xxx ───▶ Caddy /v1/*  ──▶ ③ 计量网关 :8788
│    他自己的文件    │                                     （一步没变）
└──────────────────┘                                          │
                                                              ▼ ④ 上游
```

**③ 一行没改。** 它原本就在做「验凭据 → 归属 user → 配额 → 闸门 → 翻译 → 换真凭据 →
记账 + trace」，这条路径缺的只是一张不绑 turn 的长期票据：

| | runtime token | api key |
|---|---|---|
| 谁在用 | 我们的容器 ② | 用户机器上的 ②′ |
| 有效期 | 20 分钟 | 长期，可撤销 |
| 绑到什么 | (user, conversation, turn) | 只绑 user |
| 存哪儿 | 不落盘，每轮现签 | 库里存 sha256 |

`core/credential.ts` 把两种解析成同一个 `Principal`；差别只在 `cid`/`tid` 为空 ——
没有会话就推不了 SSE 事件（`queue.waiting` / `quota.updated`，见 §2.6 的同一个总线）。

**工具跑在用户机器上是对的**，不是隔离被绕过：那是他自己的文件，容器边界在这条路径上
没有保护对象。跟 §2.3 是同一条规律的两面 —— 谁消费 `tool_calls`，工具就在谁那儿执行。

三处配套改动，都是「不改就静悄悄出错」那类：

| 改了什么 | 不改会怎样 |
|---|---|
| `count_tokens` 加鉴权 | 它拿真上游 key 转发却不验身份。绑 127.0.0.1 时无所谓，暴露公网就是白嫖入口 |
| `anthropic-native` 去掉写死的 `/anthropic` 前缀 | base 填官方 Anthropic 会拼出 `api.anthropic.com/anthropic/v1/messages` |
| 转发时补 `x-api-key` + 转发 `anthropic-beta` | 官方端点认前者；丢掉后者会让 prompt caching 之类的特性**不报错地**失效 |

### 2.2c compose 形态下的逐跳链路

§2.2 那张图画的是**逻辑**路径。拆成四个容器之后，每一跳落在哪个容器、哪张网络、
带什么凭据是另一层信息 —— 排障时缺的恰好是这一层。

```
浏览器  :8080（本地 http）/ :443（有域名）
  │ POST /api/conversations/<cid>/messages     Authorization: Bearer <access token>
  ▼
caddy      [frontend]          handle /api/* → app:8787（SSE 那条 flush_interval -1）
  ▼
app        [frontend+backend]  ROLE=app
  ① 验 access token
  ② quota.check(user) —— 超了 402，容器都不用拉
  ③ signRuntimeToken{sub:user, cid, tid, agent}，TTL 20min
  ④ containers.ensure(user) ── 引擎 socket ──▶ run/start agentlodge-agent-<uid 前 12 位>
  ⑤ exec -i --workdir /workspace/<cid>
       -e ANTHROPIC_BASE_URL=http://gateway:8788
       -e ANTHROPIC_AUTH_TOKEN=<票据>   -e ANTHROPIC_API_KEY=（显式清空，防串用）
  ▼
agent      [agent-net 独占]    CLI 在里面跑自己的工具循环
  │ POST /v1/messages（或 Codex 的 /v1/responses）  Authorization: Bearer <票据>
  ▼
gateway    [agent-net+frontend+backend]  ROLE=gateway
  ① resolveCredential   票据 或 al_ 长期 key → 同一个 Principal
  ② resolveUpstream     库里 active=1 的那条 provider
  ③ egressTarget()      返回 null ⇒ 503，fail closed，绝不静默直连
  ④ quota.check         turn 内部唯一能刹住的点（402，用不可重试类型）
  ⑤ gate.acquire        全局 ≤3 / 单用户 ≤2 + AIMD
  ⑥ fetch(http://audit:8796/<上游的 path+query>)   ← 仅在「启用审计代理」开着时
       x-forwarded-host: <上游 host>    ← 一个代理实例服务所有上游；关着时直连且不发这两个头
       x-api-key / authorization: <真实 key，只在这个进程里解密>
  ▼
audit      [backend 独占]      落盘请求头体 / SSE 逐事件 / 重建结果 / usage，然后转发
  ▼
上游
  ◀ SSE 字节原样回传，旁路 SseSniffer 嗅 usage
gateway: 按**上游那份原始 usage** 记账 + gate.reportUpstream(status) 喂 AIMD
app:     解析 CLI 的 stream-json → 消息落库 → 推到浏览器那条 SSE
```

**逐跳凭据** —— 换手的地方就是信任边界：

| 跳 | 带什么 | 谁签 | 谁验 | 有效期 |
|---|---|---|---|---|
| 浏览器 → app | access token（JWT） | app | app | 短期，refresh 轮转 |
| 用户自带 CLI → gateway | `al_` api key | app（库里只存 sha256） | gateway | 长期，可撤销 |
| agent → gateway | runtime token，绑 (user, cid, tid) | app | gateway | **20 分钟** |
| gateway → audit → 上游 | 上游真实 key | 管理员填，AES-256-GCM 存库 | 上游 | 长期 |

**网络归属** —— 决定了谁够得着谁：

| 容器 | 网络 | 够得着 |
|---|---|---|
| caddy | frontend | app、gateway |
| app | frontend、backend | gateway、audit、宿主机的引擎 socket |
| gateway | agent-net、frontend、backend | agent（收）、audit（发） |
| audit | backend | 只有 gateway 找得到它，公网和 caddy 都到不了 |
| agent | agent-net | **只有 gateway**（外加公网出口，理由见 compose 文件头） |

agent-net 上除了 agent 只有 gateway —— app、caddy、audit 都不在这张网里，
所以容器里的 CLI 够不到主服务，也够不到审计代理。

> 引擎 socket 挂载的是 podman 的；docker 引擎上换成 `docker.sock` + `PODMAN_BIN=docker`，
> 见 `docker/compose.docker.yml`。链路本身不因引擎而异。

### 2.2d 票据过期时会发生什么 ★（实测）

票据是**每个 turn 现签**的，多轮对话每轮换新，所以只有**单个 turn 跑过 20 分钟**才会
撞上过期（长工具循环、大重构那种）。撞上之后不是「立刻失败」：

| 环节 | 实际行为 |
|---|---|
| 网关 | `401 {"type":"authentication_error","message":"凭据无效或已过期"}` |
| Claude Code | **重试 10 次**，指数退避 590ms → 1.1s → 2.1s → 4.0s → 9.2s → 19.2s → 39s …（实测） |
| 用户看到的 | 这一轮**卡住两三分钟**才报错，不是秒失败 |
| 收场 | CLI 以 `is_error` 退出 → app 推 `turn.error` |

**401 是会被 CLI 重试的**，这点和配额那条相反：§7.5 特意给超额选了不可重试的错误类型，
就是为了避免这种十连重试。过期票据没有对等的保护 —— 它本不该在正常链路里出现。

一次八连重试之后的副作用（实测逐项确认）：

| | |
|---|---|
| 并发 slot | **不占** —— 认证在 `gate.acquire` 之前 |
| 配额 / 记账 | 不动，`usage_records` 一条不增 |
| 出网 / 审计 | 没发生，审计卷条数不变 |
| 会话与文件 | 都在。用户重发一句就是新 turn + 新票据，CLI `--resume` 接着原会话 |
| 日志 | ⚠️ **查不到** —— 401 走 `sendError` 不打日志，而 Fastify 的请求日志在 `info`，默认 `LOG_LEVEL=warn` 收不到 |

处理办法，按代价排序：

1. **调大 `RUNTIME_TOKEN_TTL_MS`**（默认 20min）。最省事，代价是票据越长命，泄漏窗口越大。
2. 让网关按「这个 turn 还活着吗」判定，而不是纯看 `exp`。票据就不再自包含，
   网关每次要查库 —— 它现在是**无状态验签**，这是 §7.4 之外的另一处状态化，代价不小。
3. 中途换票据：**做不到**。凭据是进程启动时的环境变量，CLI 起来之后就改不了。

> 顺带一条部署失败模式：app 和 gateway 的 `JWT_SECRET` 不一致时，**每一个**请求都是这个
> 401（而不是「偶尔过期」），因为票据是 app 签、gateway 验。compose 里两个容器引用
> 同一个变量就是为这个。

### 2.3 ④ 有两种，插同一个槽，语义相反 ★

这是整套设计里**最容易踩错的一处**，配置上看不出区别，但差一个隔离边界。

| ④ 的类型 | provider kind | 返回什么 | 工具在哪执行 |
|---|---|---|---|
| **模型端点** | `anthropic-native` / `openai-chat` | `tool_calls` | ✅ **容器里**（② 执行） |
| **另一个 agent** | 任意（把某个 CLI 封成 API 的服务） | 只有最终文本 | ❌ **那个 agent 所在的机器** |

实测（2026-08-19，假上游回真 `tool_use`，不花钱）：

```
模型端点：
  ② 的 block:  tool_use(Write) → text
  文件落点:    data/workspaces/<用户>/<会话>/mock-tool-probe.txt
  界面文件列表: ✓ 看得到

agent 上游（曾接过一个把 codex CLI 封成 API 的服务）：
  ② 的 block:  只有 text，一个工具都没调
  文件落点:    <那个服务>/workspaces/th_<thread>/probe.txt      ← 宿主机上
  界面文件列表: ✗ 空
```

**原因**：agent 自己消费 `tool_calls`，就地执行完只吐最终文本。所以把 agent 当模型塞在
② 后面，会同时丢掉两样东西：容器隔离，和用户对自己产出的可见性。

**推论**：想让工具回到容器里，④ 必须是**模型**。这跟凭据是同一条规律 ——
**谁消费 `tool_calls`，工具就在谁那儿执行**；**谁发起模型调用，凭据就得在谁那儿**。

### 2.4 ④ 的契约

自建上游（如自己的 claude proxy，背后接 deepseek / kimi / glm）只需满足两条：

1. **讲 Anthropic Messages 协议** → kind 填 `anthropic-native`，③ 零翻译透传。
   只讲 OpenAI chat 也行 → kind 填 `openai-chat`，③ 负责翻译。
2. **流式响应必须带 usage**：

```
message_start → usage.input_tokens / cache_read_input_tokens / cache_creation_input_tokens
message_delta → usage.output_tokens
```

chat 协议则是最后一帧带 `usage`（③ 会在请求里发 `stream_options.include_usage`）。

> ⚠️ **这是整套里唯一会静默出错的地方。** 上游吞掉 usage 不会报错，只会让计费、配额、
> 用量页全部归零，可能几个月后对账才发现。自建上游上线前必须用一条真请求确认这些字段非零。
> 踩过一次：接一个自建上游时它只在**非流式**响应里给 usage，而 agent 全是流式的，
> 于是计费静悄悄归零。是接入时逐条核对字段才发现的。

底层模型的 key **只进 ④**，不进 ③ —— ③ 连它用的是哪个模型都不需要知道。

### 2.5 审计代理（`trace-proxy/`）—— 位置 A，默认关

零依赖的透明转发代理，字节不改（只改 `Host`/协议要求的部分），落盘请求头体、SSE 逐事件、
重建结果和 usage。两个位置语义不同：

| 位置 | 看什么 | 状态 |
|---|---|---|
| **A** ③ ⇄ ④ | 我们**真正发给模型厂商**的是什么 | ★ **强制**。没配就不许出网 |
| **B** ② ⇄ ③ | agent 到底发了什么 | 可选调试用（`npm run dev:trace`） |

**位置 A 是强制的**，因为审计要的保证是「凡是出去过的都有记录」。留一个能静默直连的
口子，这条保证就不成立 —— 所以 `egressTarget()`（`gateway/index.ts`）配漏了返回 null，
网关直接 503，而不是退回直连。

判据收在 `core/egress.ts`，app 和 gateway 共用：后台 `activate`/`patch` 先拦一道，
网关发请求前再拦一道。两边判据分家会出现「后台说能切、网关说不许发」。

回环上游和 `mock`/`local-agent` 豁免 —— 流量没离开这台机器，没有审计对象。
这跟 `needsKey` 那处用的是同一条判据。

**一个实例服务所有上游**：网关逐请求用 `x-forwarded-host` / `x-forwarded-proto`
告诉代理这条该转给谁，换上游、加上游都不用动代理。`trace-proxy/` 归本仓库维护，
不再从外部同步，所以这个能力直接加在里面。

> 为什么不是直接改 `Host`：网关用 Node 的 `fetch`，undici 把 `Host` 当 forbidden
> header **静默丢掉** —— 设了也不发、也不报错（实测确认）。要改 Host 得把出站换成
> `node:http`，那要重写 SSE 透传和 usage 嗅探那一段，风险远大于收益。
> `x-forwarded-*` 是反代链路的标准写法，语义一样。Host 也带不动 scheme，
> proto 无论如何都得单独有个头。

能被 header 指定目标 = 开放转发器，所以代理侧四道防护：`PROXY_DYNAMIC_UPSTREAM`
默认关、`PROXY_UPSTREAM_ALLOW` 白名单、`host[:port]` 形状校验（挡路径和 userinfo 混淆）、
proto 只允许 http/https。加上代理只接内网、路由头转发前摘掉。

代理地址只有一个来源：`AUDIT_PROXY_URL`。**provider 上没有代理字段** ——
早先按「每条上游一个实例」设计过，加了 forwarded 分流之后那个字段既多余又有害
（能给某条上游单独指别的代理，等于绕过统一审计），已经删掉，存量列由迁移 drop。
单实例仍可把 `UPSTREAM_URL` 钉死，那时固定值优先于路由头。

**`PROXY_RETRY=0` 且 `PROXY_MAX_CONCURRENT=0` 不是调优项，是正确性前提**（位置 A 常驻之后尤其）：代理自带重试会把上游的 429 悄悄重试掉，网关的 AIMD
闸门（§7.4）就再也收不到降并发的信号，反而会因为「连续成功」而抬高并发 —— 上游在限流
我们却在加压。并发同理：代理也带排队，两级队列串联会让槽位对不上账，而且它认不出用户，做不了单用户上限和公平队列。**代理在链路里只做观察者，重试和并发决策都归网关。**`npm run trace` 已写死这两个默认值。

位置 B 借 `GATEWAY_URL` 把 agent 引到代理上，不用改代码。代理默认 HTTP/1.1
（实测 Claude Code 直连时 ALPN 只报 `http/1.1`），链路内上游又都是本机 `http://`，
所以既不协商 h2 也不过 TLS —— TLS 指纹那层对本项目不产生任何影响。

实测抓到的一轮带工具调用的对话，正好是 agent 循环的两半：

```
#10  200 /v1/messages  stop=tool_use   in=3020  out=22
#11  200 /v1/messages  stop=end_turn   in=3032  out=18

展开 #11 的请求体：
  → tool_use    Write {"file_path":"mock-tool-probe.txt", ...}
  ← tool_result "File created successfully at: mock-tool-probe.txt"
```

### 2.6 ⚠️ 拆进程后的两个缺口

`ROLE=app` / `ROLE=gateway` 拆开之后，有两处**不会报错、只是静悄悄失效**，记在这里
免得部署后当灵异事件查：

**一、网关推的事件到不了浏览器。**
`events.ts` 是进程内 `Map<conversationId, Channel>`，SSE 连接都注册在 app 进程上。
网关进程 `publish()` 是发给自己进程里的空 Map。

| 事件 | 影响 |
|---|---|
| `queue.waiting`（排在第几位） | **整个消失**，没有替代品 |
| `quota.updated`（turn 内实时刷额度） | 少了实时性；turn 结束时 app 侧还会统一推一次（`turns.ts`） |

保留而不是删掉，是因为单进程模式下它们工作正常，删了是实打实的体验损失。
真修法是把总线换成跨进程实现 —— 跟 §7.4 并发闸门换 Redis 是同一件事，一起做。

**二、三个网关地址必须分别配。**

| 变量 | 谁用 | 值长什么样 |
|---|---|---|
| `GATEWAY_URL` | 容器里的 agent ② | `host.containers.internal:8788` 或 trace 代理 |
| `GATEWAY_INTERNAL_URL` | 本进程（后台读闸门） | `http://gateway:8788` |
| `PUBLIC_GATEWAY_URL` | **展示给用户**填 BASE_URL（②′） | `https://你的域名` |

前两个宿主机/容器各自连得通、对方连不通，混用就是「dev 好好的、部署起来读到空壳」。
第三个不参与任何转发，只在设置页显示 —— 不配的话用户复制到的是浏览器地址，
反代在别的域名下就错了。单机开发三个都不用填。

> 这条是分层重构时发现的：后台改成一律 HTTP 转发之后，才暴露出
> `gatewayBaseUrl()` 一个函数被两种用途共用。

### 2.6b agent 网络为什么有外网

agent 容器**能出公网**，这不是省事，而是安全模型的一部分。定位是「跑在沙箱里的
Claude Code」，要能装包、能查资料。计量绕不过去靠的是**容器里没有 key**，不是没有网：

- 容器内无任何凭据，只有一张绑 `(user, conversation, turn)` 的 20 分钟票据
- 只挂自己那一个工作目录
- 非 root + CapDrop ALL + 资源限额
- 它够不到 app 和内网 —— 那两个不在 agent-net 上，所以它的可达范围跟任意一台外部机器一样

云主机上还需要在宿主机防火墙挡掉 `169.254.169.254`（实例元数据端点），否则容器里的
agent 能读到云厂商下发的机器凭据。

---


## 3. 组件职责

一个 npm 包 `apps/server`，内部分三层（§2.1b），靠 `ROLE` 决定进程跑哪一半。
分层边界由 `npm run typecheck` 里的检查强制，跨层 import 直接报错。

### 3.1 应用服务（`ROLE=app`，Fastify :8787）
- 认证：邀请码注册、登录、refresh 轮转、多设备管理
- 会话 CRUD、消息持久化
- 容器生命周期编排：拉起 / 保活 / 空闲回收 / 健康探测
- 用 `podman exec`（或 `docker exec`）在用户容器里拉起 CLI，逐行解析它的 stdout
- 向浏览器提供 SSE 事件流
- 配额读写、用量聚合、管理后台 API、上游余额轮询

### 3.2 计量网关（`ROLE=gateway`，Fastify :8788）
唯一持有上游 key、唯一与上游通信的组件。详见 §7。

### 3.3 为什么容器里没有常驻进程

容器里不跑我们自己的任何代码，`podman exec` 每轮直接拉一次 CLI：

- **exec 的 stdout 就是 CLI 的 stdout。** `stream-json` / JSONL 的解析一行都不用改，
  省掉一整套自写的进程内协议、端口和它的版本兼容问题。
- **少一个要维护的攻击面。** 容器里没有监听端口，也就没有「谁能连上它」这个问题。
- 中断靠 `exec` 进程的信号（SIGINT → 3s 后 SIGKILL），不需要自定义 abort 指令。

代价是每轮多一次 exec 的启动开销（实测 ~50ms 量级，相对一轮对话可忽略）。

---

## 4. 数据模型

**SQLite，WAL 模式。** 单机足够，`ROLE` 双进程共享同一个库文件实测可行
（`busy_timeout=5000`）。多实例部署要换库，那时并发闸门也要一起换（§7.4）。

**`apps/server/src/core/db/schema.sql` 是唯一来源。** 没有迁移层，也没有第二份 DDL：
schema 只在这一个文件里，启动时整体执行（每张表都是 `create table if not exists`）。
本节写的是模型和取舍，具体列以那个文件为准 —— 把 DDL 抄进设计文档，抄的那份迟早会漂。

### 4.1 表

| 表 | 装什么 |
|---|---|
| `users` / `user_quotas` | 账号，以及每人的额度、周期、软硬限 |
| `invite_codes` | 邀请码，可定向到邮箱、可预置角色与额度 |
| `auth_sessions` | refresh token 的哈希，一台设备一行，带轮转来源 |
| `password_resets` | 一次性重置令牌的哈希 |
| `api_keys` | 用户自带 CLI 的长期 key，存哈希 + 展示用前缀 |
| `conversations` / `messages` | 会话与消息，消息的 blocks 和 usage 存 JSON |
| `usage_records` | 一次上游调用一行，计费的事实表 |
| `model_pricing` | 价格表，带生效时间，改价不影响历史账 |
| `upstream_providers` | 上游注册表，key 可以是密文也可以是文件路径 |
| `settings` | 系统设置，值是明文 JSON 或密文 |
| `audit_logs` | 管理动作留痕 |

### 4.2 几个决定

**明文不落库。** `settings.value` 和 `upstream_providers.api_key` 都可能是密文
（`enc:v1:` 前缀），AES key 由 `JWT_SECRET` 派生。所以换 `JWT_SECRET` 等于把这些值
作废 —— 这一条在部署文档里单独写了。

**key 也可以只存路径。** `api_key_file` 与 `api_key` 二选一。存路径时库里没有密钥，
网关每次请求现读文件，上游轮换文件后下一个请求就用上了。

**用量是流水不是计数器。** `usage_records` 一次调用一行，所有汇总都从它算。
计数器省查询但对不上账时无从查起，而这张表可以按天、按会话、按 key、按模型
任意切，代价只是一个索引。

**时间一律存 ISO 8601 文本。** SQLite 没有原生时间类型，存文本至少是可读、可比较、
可 `substr` 取日期的。`usage_records.day` 另存一列本地日期，日报表不必对每行做时区换算。

**消息的 blocks 存 JSON。** 一条消息里 text / thinking / tool_use 的结构随 CLI 演进，
拆成关系表意味着每次上游加一种 block 都要改 schema。查询也从不需要按 block 检索。

## 5. 认证与注册

### 5.1 邀请码注册流程
```
POST /api/auth/register  { email, username, password, inviteCode }
  1. 事务内 SELECT ... FOR UPDATE 锁定 invite_codes 行
  2. 校验：!disabled && used_count < max_uses && (expires_at is null || > now())
  3. 创建 user（argon2id，memoryCost=64MB, timeCost=3）
  4. 用邀请码的 preset_* 初始化 user_quotas；未设置则用全局默认
  5. used_count += 1
  6. 不自动创建容器（首次对话时惰性创建）
```

管理员生成邀请码：`POST /api/admin/invites { count, maxUses, expiresIn, presetTokenLimit, note }`，返回明文码（只展示一次）。

### 5.2 Token 方案（桌面 + 移动统一）

| Token | 生存期 | 存放 | 载荷 |
|---|---|---|---|
| access token | 15 min | 前端内存（不落 localStorage） | `{sub, role, sid, exp}` |
| refresh token | 30 天 | Web：httpOnly+Secure+SameSite=Lax cookie<br>原生 App：系统安全存储 | 随机 32B，DB 存 sha256 |

- **轮转 + 重放检测**：每次 refresh 生成新 token，旧的标记 `rotated_from`。若一个已轮转的 refresh token 再次被使用 → 判定泄漏，撤销该用户整条 session 链并强制重登。
- SSE 连接无法带 Authorization header → 用短期（60s）一次性 `streamTicket` 作为 query 参数换取连接。
- 设备管理页：列出 `auth_sessions`，支持单个/全部登出。
- 可选 TOTP 二步验证；管理员账号强制开启。

### 5.3 移动端适配要点
- PWA（manifest + service worker），支持"添加到主屏幕"
- `100dvh` 而非 `100vh`（避免 iOS 地址栏抖动）
- 输入框 `font-size: 16px` 起（避免 iOS 自动缩放）
- 切后台 → SSE 断开 → 回前台用 `Last-Event-ID` 续传（见 §6.4）
- 侧栏在 `<768px` 变抽屉

---

## 6. Claude Code 集成

### 6.1 容器镜像

`docker/agent.Dockerfile`。用完整版 node 而不是 slim + apt —— 内网环境下容器里的
Debian 源不可达，而完整版自带 git / curl / procps，够 agent 用了。

```dockerfile
FROM node:22-bookworm

ARG CLAUDE_VERSION=2.1.224
ARG CODEX_VERSION=0.147.0
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} @openai/codex@${CODEX_VERSION}

RUN useradd -m -u 10001 -s /bin/bash agent
USER agent
ENV HOME=/home/agent DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 CODEX_HOME=/home/agent/.codex

WORKDIR /workspace
CMD ["sleep", "infinity"]        # 不跑我们的代码，靠 exec 按需拉 CLI
```

镜像里**不写 `ANTHROPIC_BASE_URL` 和任何 key**：地址和票据都是每轮 exec 时通过 `-e` 下发的。
镜像不该知道网关在哪，更不该带凭据。

装的 CLI 版本写进镜像 label（`dev.agentlodge.claude-code.version`），构建时核对
npm 真的装了那个版本，对不上直接构建失败 —— label 说的和里面装的不一致，比没有 label 更糟。

容器内 `~/.claude/settings.json` 只预置 `{"includeCoAuthoredBy": false}`。
**不禁 WebFetch / WebSearch** —— agent 网络是有外网的（§2.6b），禁掉反而废掉了它的一半能力。

### 6.2 容器创建参数

`podman run` / `docker run` 的实际参数（`app/containers.ts`）：

```
run -d --name agentlodge-agent-<uid 前 12 位>
    --hostname agent-<uid 前 8 位>
    -v <DATA_DIR>/workspaces/<uid>:/workspace:rw     # 只挂自己那一个目录
    -v <DATA_DIR>/workspaces/<uid>/.agent-home:/home/agent:rw
    -w /workspace
    --user 10001:10001                               # 非 root
    --cap-drop ALL
    --security-opt no-new-privileges
    --pids-limit 256
    --memory <N>m  --memory-swap <N>m                # swap 禁掉
    --cpus <N>
    --restart no
    --log-opt max-size=10m
    --network agentlodge-agent-net
```

两个决定值得记：

**整个 HOME 挂出来，不用 tmpfs。** 写入层会随 `rm` 一起消失，而 `~/.claude/projects/*.jsonl`
是 CLI 的会话记录 —— 丢了 `--resume` 就失效，等于每次重启都换一个人。配置同理。

**只挂用户自己那一个目录。** `MEMORY.md` 和每个会话的子目录都在里面，容器看不到别人的任何东西。

**磁盘配额**：目前没做硬限。要做的话用 XFS project quota，或定时 `du` 检查后告警。

### 6.3 一轮对话的完整链路

```
浏览器 POST /api/conversations/:id/messages { text }
  │
  ├─ ① 同会话串行：进程内 active map 里已有这个会话 → 直接拒
  ├─ ② 前置配额检查（读 SQLite 的 usage_records 汇总）→ 不足则 402
  ├─ ③ 确保容器 running（惰性创建 / 冷启动 ~2s，期间推 container.status）
  ├─ ④ 落库 messages(role=user)
  ├─ ⑤ 签发 runtime token（JWT，HS256，20 分钟）
  │      claims 绑死 (user, conversation, turn)，网关据此归属计费
  ├─ ⑥ podman exec 在用户容器里拉起 CLI，逐行读它的 stdout
  │
  └─ 立即返回 { turnId, userMessage }；后续从 SSE 流来
```

CLI 的拉起方式（`app/agents/claude.ts`，codex 同理）：

```ts
const args = [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--include-partial-messages',      // token 级 delta
  '--verbose',
  '--dangerously-skip-permissions',  // 容器本身就是沙箱
  '--model', model,
];
if (resumeSessionId) args.push('--resume', resumeSessionId);

// env 里只有票据和网关地址，没有任何真实 key
env = {
  ANTHROPIC_BASE_URL: gatewayBaseUrl(inContainer),
  ANTHROPIC_AUTH_TOKEN: runtimeToken,
};
```

### 6.4 事件协议（CLI → app → 浏览器 SSE）

统一事件格式，经进程内 pub/sub（`core/events.ts`）转成 SSE 推给浏览器。
拆进程后网关侧产生的事件到不了浏览器，这是已知缺口，见 §2.6。

| event | payload | 说明 |
|---|---|---|
| `turn.started` | `{turnId}` | |
| `container.status` | `{state:'starting'\|'ready'}` | 冷启动时提示"正在准备环境" |
| `queue.waiting` | `{position, estimatedMs}` | 被并发闸门排队时（§7.4） |
| `message.start` | `{messageId, role}` | |
| `block.start` | `{blockIndex, type}` | type: text/thinking/tool_use |
| `text.delta` | `{blockIndex, text}` | 打字机效果 |
| `thinking.delta` | `{blockIndex, text}` | 折叠展示 |
| `tool.start` | `{blockIndex, id, name, input}` | 工具卡片展开 |
| `tool.result` | `{id, isError, preview, durationMs}` | |
| `block.stop` | `{blockIndex}` | |
| `message.stop` | `{messageId}` | |
| `usage.update` | `{turn:{in,out,cost}, period:{used,limit,pct}}` | 每次 api_call 结束推一次 |
| `turn.completed` | `{turnId, usage, durationMs}` | |
| `turn.error` | `{code, message, retryable}` | |
| `heartbeat` | `{ts}` | 每 15s，保活 + 检测断线 |

> ⚠️ **不要从 CLI 的 `assistant` 事件里累加 usage 来计费。** 同一次 API 响应含多个 content block 时会产生多个 assistant 事件，**每个都携带同一份完整 usage**，累加会虚高 2~3 倍（实测见 §7.6）。计费一律以网关为准；CLI 事件只用于渲染。

`messages.blocks` 的持久化格式（turn 结束时由 api 汇总落库）：
```jsonc
[
  { "type": "thinking", "text": "..." },
  { "type": "text", "text": "我先看一下这个文件。" },
  { "type": "tool_use", "id": "toolu_1", "name": "Read",
    "input": { "file_path": "/workspace/a/main.py" },
    "result": { "isError": false, "preview": "...", "durationMs": 42 } },
  { "type": "text", "text": "问题出在第 12 行……" }
]
```

### 6.5 中断
`POST /api/conversations/:id/abort` → app 给那一轮的 `exec` 子进程发 `SIGINT`，3s 后 `SIGKILL`。
**已消耗的 token 照常计费**（网关早就记账了）。消息落库时标记 `aborted`。

### 6.6 会话 ID 管理
- 首轮不带 `--resume`；从 `{"type":"system","subtype":"init","session_id":"..."}` 事件取出 session_id 写入 `conversations.claude_session_id`
- 后续每轮从 `init` / `result` 事件**重新读取并更新** session_id（某些版本 `--resume` 会 fork 出新 id）
- 若 `--resume` 失败（jsonl 丢失/损坏）→ 降级为新会话，并把历史消息拼进 prompt 前缀，同时给前端一个 `session.reset` 提示

---

## 7. 计量网关（`ROLE=gateway`）★核心

### 7.1 职责与请求处理链

```
容器请求 POST http://gateway:8788/v1/messages
   Authorization: Bearer <runtime-token>
   ↓
 [1] verifyRuntimeToken   → 解出 {uid, cid, tid}；失败 401
 [2] modelGuard           → 模型白名单，非法则改写为默认模型
 [3] quotaGate            → 聚合该用户周期内的 usage_records；超额 → 402/429（Anthropic 错误格式）
 [4] concurrencyGate      → 全局 ≤3 in-flight 的信号量 + 公平队列（可能阻塞）  ★
 [5] forward              → undici 请求 api.deepseek.com/anthropic/v1/messages
                            注入真实 DEEPSEEK_API_KEY
 [6] streamTee            → SSE 边转发边解析 usage
 [7] settle (finally)     → 释放 slot + 记账 + 推 usage.update 事件
```

### 7.2 上游 usage 解析

Anthropic 协议的流式响应里，usage 分两处出现：
```
event: message_start
data: {"message":{"usage":{"input_tokens":1024,"cache_read_input_tokens":8192,
                           "cache_creation_input_tokens":0,"output_tokens":1}}}
...
event: message_delta
data: {"usage":{"output_tokens":523}}          ← 最终输出 token 数
```

网关维护一个轻量 SSE 解析器，**只窥探不修改**，原样把字节流透传给容器（避免破坏 CLI 的解析）：

```ts
async function tee(upstream: Readable, reply: FastifyReply, acc: UsageAcc) {
  let buf = '';
  for await (const chunk of upstream) {
    reply.raw.write(chunk);                    // 原样透传，零延迟
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = raw.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'message_start') {
          const u = ev.message?.usage ?? {};
          acc.input       += u.input_tokens ?? 0;
          acc.cacheRead   += u.cache_read_input_tokens ?? 0;
          acc.cacheWrite  += u.cache_creation_input_tokens ?? 0;
          if (!acc.ttftMs) acc.ttftMs = Date.now() - acc.startedAt;
        } else if (ev.type === 'message_delta') {
          acc.output = Math.max(acc.output, ev.usage?.output_tokens ?? 0);
        }
      } catch { /* 忽略非 JSON 的 keep-alive 行 */ }
    }
  }
  reply.raw.end();
}
```

非流式（`stream:false`）响应直接读 body 里的 `usage`。

### 7.3 计费公式

```ts
// price_*_micro 单位：每 1,000,000 token 的微元（1 元 = 1e6 微元）
cost_micro =
    (input_tokens        * P.in_miss
   + cache_read_tokens   * P.in_hit
   + cache_write_tokens  * P.in_miss      // DeepSeek 缓存写入按 miss 价，需实测确认
   + output_tokens       * P.out) / 1_000_000;

// 加权 token（用于 mode='tokens' 的配额）
weighted = input + cache_read * W.hit + cache_write * W.write + output * W.out;
// 默认权重按价格比：W.hit=0.1, W.write=1.0, W.out=1.5
```

`model_pricing` 表带 `effective_from`，改价只需插新行，历史账单不受影响。**上线前务必去 DeepSeek 官网核对当前价格填入。**

记账**同步**写一行 `usage_records`，没有计数器、没有队列、没有对账。

上游响应结束时，网关从解析出的 usage 算出计费 token 与金额，直接 insert 一行。
用量汇总一律从这张流水表现算（按 `user_id` + 时间窗聚合）。

不用计数器的理由：计数器省一次聚合查询，但一旦和明细对不上就无从查起，而对账逻辑本身
又是新的一类 bug。流水表在单机 SQLite 上按用户 + 时间窗聚合是索引命中，成本可以忽略，
换来的是任何一笔账都能一路追到具体是哪次请求。

### 7.4 全局并发闸门（≤3 in-flight）★

**目标**：任一瞬间打到 DeepSeek 的 in-flight 请求不超过 `MAX_UPSTREAM_CONCURRENCY`（默认 3），避免触发对方流控；同时不让单个用户的 agent 循环饿死其他用户。

#### 重要认知：3 并发 ≠ 只能服务 3 个用户

一次用户对话（turn）在 agentic 模式下会产生 **N 次** API 调用（模型思考 → 调工具 → 把结果喂回去 → 再思考……）。**工具执行期间不占用 slot**。所以：

```
用户 A: [API调用 3s] → [Bash执行 8s] → [API调用 4s] → [Read 0.2s] → [API调用 2s]
             ↑占slot        ↑不占slot       ↑占slot
```
典型 agentic turn 的 slot 占用率只有 30~50%，3 个 slot 实际可以流畅支撑 **6~10 个并发活跃用户**。真正需要担心的是纯长文本生成（几乎 100% 占 slot）。

#### 数据结构

```ts
type Waiter = {
  userId: string; turnId: string;
  priority: 0 | 1;            // 0=交互式对话  1=后台任务(标题生成/小模型)
  enqueuedAt: number;
  resolve: (lease: Lease) => void;
  reject: (e: Error) => void;
  signal: AbortSignal;        // 客户端断开 → 出队
};

class UpstreamGate {
  private max = 3;                              // 有效并发（会被熔断器动态调低）
  private active = new Set<Lease>();
  private queues = new Map<string, Waiter[]>(); // userId -> FIFO
  private rrCursor = 0;                         // 轮转游标
  private hiPri: Waiter[] = [];                 // 优先级 0 单独一条快车道
}
```

#### 调度策略：优先级 + 用户级轮转（DRR 简化版）

```
release() / acquire() 触发调度：
  while (active.size < max) {
    w = hiPri.shift()                        // 先清交互式快车道
        ?? pickRoundRobin(queues)            // 再按 userId 轮转取一个
    if (!w) break
    if (w.signal.aborted) continue           // 跳过已放弃的
    grant(w)
  }

pickRoundRobin:
  从 rrCursor 开始遍历 userId 列表，取第一个非空队列的队头，
  rrCursor 前移到下一个 user。
  → 保证 A 用户连续发 10 个请求也不会把 B 用户挤到后面。
```

**为什么要用户级轮转**：一个 agent 循环会连续快速地发起多次调用。若用全局 FIFO，一个用户跑长任务时会持续占满队列前排。轮转让每个活跃用户在每一"轮"里都能拿到一次机会。

#### Lease 生命周期与释放（最易出 bug 的地方）

```ts
const lease = await gate.acquire({ userId, turnId, priority, signal });
try {
  const res = await undici.request(upstreamUrl, { ... });
  await tee(res.body, reply, acc);       // ← 流式必须等到流真正结束
} finally {
  lease.release();                       // 无论成功/异常/客户端断开都释放
}
// 另外挂：
request.raw.on('close', () => { if (!finished) { abortUpstream(); lease.release(); } });
```

必须保证：
- **流式响应要等 SSE 流关闭才释放**，不能在 header 到达时就释放
- 客户端（容器）断连、超时、上游报错，三条路径都释放
- Lease 带 watchdog：持有超过 `LEASE_MAX_MS`（默认 600s）强制回收并 abort 上游，防止泄漏导致 slot 永久损耗

#### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `MAX_UPSTREAM_CONCURRENCY` | 3 | 全局 in-flight 上限，热更新（管理后台可调） |
| `MAX_QUEUE_DEPTH` | 200 | 超出直接 529 `overloaded_error` |
| `QUEUE_TIMEOUT_MS` | 120000 | 排队超时 → 429 + `retry-after` |
| `LEASE_MAX_MS` | 600000 | 单次上游请求最长持有时间 |
| `TTFT_TIMEOUT_MS` | 60000 | 首字节超时 |
| `PER_USER_INFLIGHT_MAX` | 2 | 单用户最多同时占 2 个 slot，防独占 |

#### 排队体验：把等待暴露给用户

网关在入队时发 `queue.waiting` 事件（带 turnId），app 转成 SSE 推给前端，界面显示"⏳ 排队中，前面还有 2 个请求"。**不要让用户对着空白转圈**。同时网关在排队期间对容器保持连接（HTTP 请求本来就在 pending，无需额外处理），但要注意如果排队 > 30s，先给容器发一个 SSE 注释行 `: keep-alive\n\n` 防止中间层超时。

#### 自适应熔断（AIMD）

DeepSeek 侧的实际限流阈值是黑盒，写死 3 可能仍然踩线，也可能太保守。加一个自适应环：

```ts
onUpstreamResponse(status, headers) {
  if (status === 429 || status === 503) {
    effectiveMax = Math.max(1, Math.floor(effectiveMax / 2));   // 乘性减
    cooldownUntil = now + (parseRetryAfter(headers) ?? 5000);
    metrics.inc('upstream_throttled');
  } else if (status < 400) {
    consecutiveOk++;
    if (consecutiveOk >= 20 && effectiveMax < MAX) {
      effectiveMax++; consecutiveOk = 0;                        // 加性增
    }
  }
}
```
熔断期间新请求继续排队而不是失败。管理后台展示实时 `effectiveMax`。

#### 多实例扩展（暂不需要，预留）
单机单进程用内存信号量即可。将来要多实例时换成 Redis 实现：
- `INCR upstream:inflight` + Lua 校验上限，拿到 lease 后写 `upstream:lease:<id>` 带 TTL
- 持有期间每 10s `EXPIRE` 续租（防进程崩溃后 slot 泄漏）
- 排队用 Redis Sorted Set + `BZPOPMIN`

### 7.5 配额闸门的错误返回

超额时必须返回 **Claude Code 能正确理解的 Anthropic 错误格式**，否则 CLI 会疯狂重试：

```jsonc
// HTTP 402（不可重试）
{ "type": "error",
  "error": { "type": "permission_error",
             "message": "Token quota exhausted for this billing period. Used 1,050,000 / 1,000,000." } }

// HTTP 429（可重试，带 retry-after）
{ "type": "error",
  "error": { "type": "rate_limit_error", "message": "Queued too long, please retry." } }
```
`permission_error` / `invalid_request_error` 类型 CLI 不会重试；`rate_limit_error` / `overloaded_error` 会带退避重试。**用错类型会导致超额用户的容器无限重试打爆网关。**

同时网关发出事件，app 结束该 turn 并推 `quota.updated`，前端立刻把输入框切成禁用态。

### 7.6 为什么不用 Claude Code 自带统计 / ccusage（已实测）

Claude Code 自身确实有用量统计，共三个来源：

| 来源 | 内容 | 粒度 |
|---|---|---|
| `~/.claude/projects/**/*.jsonl` | 每条 assistant 记录带 `message.usage` | 单次 API 调用 |
| `~/.claude/stats-cache.json` | `modelUsage` / `dailyModelTokens` 聚合 | 机器全局 |
| headless `--output-format json` 的 result 事件 | `usage` + `total_cost_usd` | 单次 turn |
| OTel（`CLAUDE_CODE_ENABLE_TELEMETRY=1`） | `claude_code.token.usage` metric | 可导出 |

`ccusage` 走的是第一条：扫 jsonl → 按 `messageId + requestId` 去重 → 按模型名查 LiteLLM 价格表 → 按天/会话/5h 窗口聚合。

**基于本机 6928 条真实记录的实测结论（2026-08-17，ccusage 20.0.20）：**

1. **usage 会重复**。一次响应含多个 content block 时落成多行 JSONL，**每行都带同一份完整 usage**。
   `6934 行 → 仅 2517 个唯一 message.id`；朴素求和 output `3,630,248` vs 实际 `1,103,988`，**虚高 3.29×**。

2. **第三方端点下 `requestId` 为空，ccusage 去重失效**。6928 条中仅 608 条（8.8%）有 requestId。
   以 `deepseek-v4-pro` 验证：实际（按 message.id 去重）`460,082`，**ccusage 报 `1,059,292`，虚高 2.3×**。

3. **成本字段全空，只能靠模型名查表，而模型名不可靠**。`costUSD` 100% 为 null，stats-cache 中所有模型 `costUSD` 均为 0。ccusage 实测输出：
   ```
   deepseek-v4-pro  cost=$4.54  ✅        deepseek_v4_pro  cost=$0.00  ❌ 下划线写法未匹配
   auto             cost=$0.00  ❌        /mnt/.../Kimi-K3/ cost=$0.00 ❌
   ```
   同一模型两种写法拆成两个桶，一个计费一个静默归零且不报错。

4. **是事后统计，不是闸门**。文件在 turn 结束后才落盘，天然滞后；且文件位于**用户容器内、用户可写**，可篡改可删除。

**结论**：transcript 类方案适合做「观测与对账」，**不能做「计费与配额执行」**。网关直接解析上游 HTTP 响应体的 usage，具备 transcript 不具备的三个属性——单次、实时、用户不可触碰——且不依赖模型名匹配（价格表 key 就是我们自己注入的 model 值）。

**但保留它做第三口径**：定时把容器内 jsonl（按 `message.id` 正确去重后）汇总，与 §9.2 的自计费、余额差做三方对账，任意两方偏差 > 5% 即告警。这能兜住"网关 SSE 解析漏了某种事件"这类 bug。

### 7.7 `/v1/messages/count_tokens` 兼容

Claude Code 会调用这个端点估算上下文长度。DeepSeek 兼容层**可能不支持**。网关做兜底：
```ts
if (upstreamStatus === 404 || upstreamStatus === 400) {
  // 本地粗估：中文 ~1.5 char/token，英文 ~4 char/token
  return { input_tokens: estimateTokens(body) };
}
```
该端点**不占用并发 slot、不计费**。

### 7.8 回给 CLI 的额度，是这个用户自己的

上游是**一份共享订阅**，所以上游说的"还剩多少"讲的是**池子**。原样转发就等于把全平台的
消耗摊给每个用户看，而且那个上限根本不是他的。网关的做法是：上游的额度信息一律不外传，
换成问话人自己的配额。

三条通道，三种处理：

| 通道 | 上游给的 | 我们给的 |
|---|---|---|
| `/v1/messages` 响应头 `anthropic-ratelimit-unified-*` | 池子的 5h / 7d 利用率 | 丢弃。改写成该用户配额换算的一组同名头 |
| `GET /api/oauth/usage`（`/usage` 面板读它） | 池子的五个窗口 | 网关自己应答，不透传，数据来自 `quota.status(userId)` |
| Codex 响应体里的 `rate_limits` | 池子的 `used_percent` | 从流里摘掉 |

**两种格式的标度不一样**，都是从 claude 二进制里读出来的，不是猜的：

```
响应头            utilization 是 0..1 的小数，reset 是 unix 秒
/api/oauth/usage  utilization 是 0..100 的百分比，resets_at 是 ISO 8601 字符串
```

在响应头那侧发百分比不是四舍五入的小问题：客户端按 `max(0, min(1, n))` 夹取，
于是任何超过 1% 的用量都显示成额度打满。

**用户自带 CLI 怎么接进来。** 凭据写进 CLI 自己的配置目录（`CLAUDE_CONFIG_DIR` 指向
`~/.agentlodge/claude`），不走环境变量、不放 URL。`ANTHROPIC_BASE_URL` 不是认证——空配置
目录下 `claude auth status` 回 `{"loggedIn": false, "authMethod": "none"}`；放好文件之后回
`{"loggedIn": true, "authMethod": "claude.ai"}`。**那个文件就是"登录态"，而它由我们签发。**
脚本由 `app/cli-install.ts` 生成，在 `GET /api/cli/install.sh` 上**公开**（不含密钥，人人
一份，可以先读再跑），密钥作为参数传进去、单独落在 `~/.agentlodge/key`；包装脚本每次运行
从那个文件重建凭据，所以换密钥是改一行、不用重装。整条链由集成测试真跑一遍
（`cli-install.test.ts`：装 → 跑 wrapper → 换 key → 卸载 → rc 精确还原）。

由此，三条通道各自的实际归宿：

**窗口的边界归上游，窗口里的量归用户。** CLI 那两条线是**平台的**窗口——一份订阅就是一个
5 小时窗口和一个周窗口，重置时刻对所有人是同一个，而上游在每个响应里都会讲这两个时刻
（`-5h-reset` / `-7d-reset`，网关本来就记着，见 §上面的管理员视图）。所以：

```
边界   上游给的真实 reset —— 谁看都一样
数量   这个用户自己在这段区间里的消耗（usage_records 按 created_at 过滤）
分母   这个用户的配额按窗口长度折算（日配额 10M → 5 小时约 2.08M，7 天 70M）
```

**为什么不能用「用户自己的窗口」**：假设上游 2 点重置、窗口到 7 点，而某人 4 点才发第一条
消息。按他自己算，窗口到 9 点——但 7 点池子可能就空了，他会带着大把没用完的配额被拒。
边界必须是平台的。

分母是折算出来的**速度**，不是第二道限额：真正拦人的仍然是配额本身，超了 402，网页
`/usage` 显示的也还是配额。上游还没回过任何响应时（网关刚重启、假上游）回落到配额周期本身
——那是个更差的答案，但它是诚实的：宁可给用户真实的上限配一个大致贴切的标签，也不要
自己编一套窗口边界。

**响应头 —— 经过我们，而且被采信。** Claude Code 只在 claude.ai 订阅会话下认这些头
（`extractQuotaStatusFromHeaders` 开头就是
`if (!Oqr(ds())) { this.rawUtilization = {}; return null }`），而上面那份凭据正好让会话算
订阅会话。把利用率回成 0.98，CLI 就发出
`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.98,"rateLimitType":"five_hour"}}`
—— 这个数字是网关按该用户配额算的。

**`/usage` 面板 —— 不经过我们，也不需要。** 实测：挂 HTTPS_PROXY 抓 CONNECT，那个请求直连
`api.anthropic.com:443`，用本机的 claude.ai 凭据，`ANTHROPIC_BASE_URL` 对它无效。而这条
接法下那个 profile 没登录任何 claude.ai 账号，所以面板既没有额度数字，也不产生任何外联
（CONNECT 记录为空）。网关上的 `GET /api/oauth/usage` 因此不是给面板用的，它的价值是
**这条路径永远不会被透传**：真有客户端问过来，答的是他自己的配额。

**Codex 的 `rate_limits` —— 经过我们，在流里摘掉。** 它没有账号 API，额度跟着响应体走，
而响应体是逐字节转发的，所以这是唯一真的会漏的通道。

**管理员是例外，而且只有他看得到。** 池子的真实数字对某一个用户没有意义，对管理员却是唯一
要紧的事——套餐还剩多少。所以那些头在丢弃之前先留一份：`gateway/upstream-allowance.ts`
按原样存下所有 `anthropic-ratelimit*` / `x-codex-*` 头，外加一份解析好的窗口视图，Codex 的
`rate_limits` 在摘除时顺手交给同一个存储。

存在**网关进程的内存里**，理由和并发闸门一样：这些头只有它看得见，所以后台通过转发来读
（`app/routes/admin/upstream.ts` → 网关的 `GET /upstream-allowance`）。重启即丢，下一次上游
响应就填回来——对一个「截至上一次调用」的数字来说这是对的取舍。

原始头和解析视图都存，是因为这是唯一一块「读错比读不出更糟」的屏幕，而上游随时可能加字段。

同一次响应两个答案，实测：

```
客户端收到   anthropic-ratelimit-unified-5h-utilization: 0.0900   ← 他自己的配额
管理员看到   5h 0.22 · 7d 0.59 · overage rejected                  ← 上游真实值
```

Codex 那条与登录方式无关：它没有用量端点，额度跟着响应体走
（`rate_limits.primary/secondary`，各带 `used_percent` / `window_minutes` / `resets_at` /
`plan_type`），而响应体是逐字节转发的。所以那条是**唯一真的会漏**的通道，必须在流里摘。
摘掉而不是替换：字段形状来自抓包，往客户端要解析的流里写一个错的 `resets_at`，
比让它没得显示更糟；等有一份能对照的抓包再谈替换。

一个周期不结束的配额（`total`）在响应头那侧什么都不报 —— 客户端会丢掉只有利用率没有
reset 的窗口；它在 `/api/oauth/usage` 里照常出现，那边 `resets_at` 允许为 null。

代码：`apps/server/src/gateway/quota-report.ts`。

---

## 8. 配额系统

### 8.1 三层防御

| 层 | 位置 | 时机 | 作用 |
|---|---|---|---|
| L1 软提示 | 前端 | 实时 | 用量条变黄/红，>90% 弹提示 |
| L2 准入 | app（发消息时） | 每 turn | 聚合 usage_records，超额直接 402，不启动 turn |
| L3 硬闸门 | 计量网关 | 每次上游调用 | 唯一无法绕过的拦截点，turn 中途也能刹住 |

L2 拦不住"一个 turn 内跑了 50 次调用把额度打爆"，L3 能。两者都要有。

### 8.2 三个窗口，边界全平台统一

一个用户有**三个上限**：5 小时、周、月，任一超了就拦，单个留空表示那个窗口不限。

**窗口是平台的，不是每个人自己的。** 一份订阅只有一个 5 小时窗口、一个周、一个月，起止
时刻对所有人是同一个：

| 窗口 | 边界从哪来 |
|---|---|
| 5 小时 | 上游响应头里的 `-5h-reset`。网关收到就写进 `settings`（两个容器唯一共享的存储），app 和 gateway 都从那儿读，切在同一个时刻。没观测到时按锚点小时切，仍然全局一致 |
| 周 / 月 | 已有的全局锚点设置（周几 / 几号 / 几点），本来就是全局的 |

**为什么不能按用户自己的窗口算**：上游 2 点重置、窗口到 7 点，某人 4 点才发第一条消息。
按他自己算窗口到 9 点——可 7 点池子就空了，他会带着大把没用完的配额被拒。

上游那个 reset 可能是几小时前观测到的（网关闲置），这时**按 5 小时步长往前推**而不是丢弃：
要紧的是相位，相位不会漂。注意 5 小时不整除一天，所以窗口会绕着钟走——上游自己的窗口也是
这样。

**充值 = 给某一个窗口临时抬高上限**，窗口一重置就失效。它以前是「一次性额度 + 自己的
小时数 + 可自动续」，那正是这套模型要消灭的每用户滚动窗口：4 点充值的人会拥有一套只有他
有的边界。挂到窗口上之后，它保住了「临时放行某个人」这个用途，而过期时刻是大家共用的。

**手动清零**只把计数起点往窗口内部挪（`max(窗口起点, reset_at)`），**不动边界**——下一个
窗口照样在自己的边界开始。

**没有归档任务，也没有要清零的计数器**：窗口起点是算出来的时间边界，聚合时按它过滤
`usage_records` 就行（`core/db/period.ts`，`core/quota.ts` 26 个单测）。

**CLI 上报因此变得精确**：Claude Code 的面板正好也是一个 5 小时窗口加一个周窗口，直接一一
对应，不需要任何折算（`gateway/quota-report.ts`）。月上限在面板里没有对应的行，只在网页
`/usage` 里显示。

### 8.3 管理后台能力
- 用户列表：用量 / 配额 / 剩余 / 容器状态 / 最后活跃
- 单个用户：改三个上限、给某个窗口充值、清零当前窗口用量、暂停账号、强制回收容器、查看其会话与消费明细
- 批量：给一组用户设置统一配额
- 邀请码：生成 / 撤销 / 查看使用情况
- 全局：`MAX_UPSTREAM_CONCURRENCY` 热调、模型价格表、默认配额
- 总览：全站今日/本月 token 与花费、DeepSeek 余额、并发闸门实时状态（active/queued/effectiveMax）、Top 10 消耗用户
- 所有变更写 `audit_logs`

---

## 9. DeepSeek 余额与花费

### 9.1 余额：官方就有 API，不用爬网页

```http
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
```
响应：
```json
{ "is_available": true,
  "balance_infos": [
    { "currency": "CNY", "total_balance": "110.00",
      "granted_balance": "10.00", "topped_up_balance": "100.00" } ] }
```

定时任务每 60s 拉一次，结果放进进程内缓存供后台读取。
失败时保留上次值并标记 `stale`，前端显示"数据更新于 X 分钟前"。

### 9.2 「花了多少钱」的三条独立口径

| 口径 | 来源 | 特点 | 用途 |
|---|---|---|---|
| **A. 自计费** | 网关累计的 `cost_micro` | 实时，可下钻到用户/会话/单次调用 | **计费与配额的唯一依据** |
| **B. 余额差** | `balance(t0) - balance(t1)` | 与 DeepSeek 账单一致，是"真值" | 校准 A 的绝对精度 |
| **C. transcript** | 容器内 jsonl，按 `message.id` 去重后汇总 | 滞后、可被篡改 | 只做交叉校验，见 §7.6 |

每日对账任务：`drift = |A - B| / B`，`> 5%` 告警（价格表配错或 usage 字段映射有误）；`|A - C| / A > 5%` 也告警（网关 SSE 解析可能漏事件）。
⚠️ C 口径**必须自己按 `message.id` 去重**，不能直接用 ccusage 的数字——第三方端点下它会虚高 2~3 倍，实测见 §7.6。

> DeepSeek 的"用量明细"页面需要登录 Cookie 才能抓，不稳定且可能违反 ToS。**不建议爬网页**，用「自计费 + 余额差对账」这套即可，精度足够且完全合规。

### 9.3 展示给用户
- 普通用户：只看自己的「本周期已用 / 配额 / 剩余」+ 折算金额，**不展示平台总余额**
- 管理员：额外看 DeepSeek 账户余额、全站花费、余额耗尽预估天数（按最近 7 日均速外推）
- 余额低于阈值（如 ¥20）→ 管理员邮件/Webhook 告警

---

## 10. 前端设计

### 10.1 布局

```
┌────────────┬────────────────────────────────────────┐
│  ☰ 新对话   │  对话标题                    ⋯ 更多     │  ← 移动端侧栏变抽屉
│            ├────────────────────────────────────────┤
│ 今天        │                                        │
│ · 修复登录  │   [用户消息气泡 - 右对齐/淡背景]        │
│ · 分析日志  │                                        │
│            │   [助手消息 - 无气泡，全宽 Markdown]    │
│ 昨天        │     ▸ 💭 思考中… (可折叠)               │
│ · ...      │     正文流式打字…                       │
│            │     ┌──────────────────────────────┐   │
│            │     │ ▸ 📖 Read  main.py           │   │  ← 工具卡片
│            │     │   已读取 120 行         42ms  │   │
│            │     └──────────────────────────────┘   │
│            │     ```python  (Shiki 高亮 + 复制按钮) │
│────────────│                                        │
│ ▓▓▓▓▓░░ 62%│  ┌──────────────────────────────────┐ │
│ 62万/100万 │  │ 输入消息…            📎  ⏹/↑     │ │
│ ≈ ¥12.40   │  └──────────────────────────────────┘ │
│ ⚙ 设置      │  ⏳ 排队中（前面 2 个）  ← 闸门排队时   │
└────────────┴────────────────────────────────────────┘
```

### 10.2 关键交互
- **流式打字机**：`text.delta` 累加，用 `requestAnimationFrame` 批量刷新，避免每个 token 都 re-render
- **工具调用卡片**：默认折叠成一行摘要（图标 + 工具名 + 关键参数 + 耗时），点开看完整 input/output。`Edit`/`Write` 类工具渲染成 diff 视图
- **思考块**：灰色斜体，默认折叠，带 "思考了 12 秒"
- **虚拟滚动**：长会话用 `@tanstack/virtual`，配合"跳到最新"悬浮按钮
- **自动滚动**：仅当用户在底部附近（<100px）时跟随，否则显示"↓ 有新内容"
- **中断**：生成中把发送按钮变成 ⏹
- **重试/编辑重发**：编辑用户消息 → 从该点截断后续消息 → 重新发起 turn（Claude Code 侧对应新 session，用截断后的历史重建）
- **附件**：拖拽/粘贴上传 → api 写入 `/var/lib/agentlodge/ws/<uid>/<conv>/uploads/` → prompt 里注入文件路径
- **用量条**：`usage.update` 事件实时更新；hover 显示本次 turn 明细（输入/输出/缓存命中/费用）
- **额度耗尽**：输入框禁用 + 明确文案 + "联系管理员"

### 10.3 主题
深/浅色，跟随系统。配色向 Claude.ai 靠拢：暖白 `#faf9f5` / 深灰 `#1f1e1d`，主色琥珀 `#d97757`，正文字体 Inter / 思源黑体，代码字体 JetBrains Mono。

---

## 11. HTTP API 概览

```
# 认证
POST   /api/auth/register            { email, username, password, inviteCode }
POST   /api/auth/login               { email, password, totp? }
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/auth/sessions            # 已登录设备
DELETE /api/auth/sessions/:id

# 会话
GET    /api/conversations                        ?cursor&limit
POST   /api/conversations                        { title? }
GET    /api/conversations/:id
PATCH  /api/conversations/:id                    { title, status }
DELETE /api/conversations/:id
GET    /api/conversations/:id/messages           ?before&limit
POST   /api/conversations/:id/messages           { text, attachments[] } → 202 {turnId}
POST   /api/conversations/:id/files              multipart
GET    /api/conversations/:id/stream             SSE  ?ticket=&lastEventId=
POST   /api/turns/:id/abort
GET    /api/stream-ticket                        # 换取 SSE 一次性票据

# API 密钥（把本机 CLI 指过来）
GET    /api/me/api-keys                 列表 + 每把的累计用量 + 该填的 BASE_URL
POST   /api/me/api-keys                 创建，明文只在这一次返回
DELETE /api/me/api-keys/:id             撤销（软删，历史用量还指得到）

# 用量
GET    /api/usage/summary            # 本周期 已用/配额/剩余/折合金额
GET    /api/usage/daily              ?from&to
GET    /api/usage/conversations      # 按会话排行

# 管理员
GET    /api/admin/overview
GET    /api/admin/users              ?q&sort
PATCH  /api/admin/users/:id/quota
POST   /api/admin/users/:id/reset-usage
POST   /api/admin/users/:id/suspend
POST   /api/admin/users/:id/container/restart
GET    /api/admin/invites
POST   /api/admin/invites
DELETE /api/admin/invites/:id
GET    /api/admin/balance            # DeepSeek 余额 + 趋势
GET    /api/admin/gate               # 并发闸门实时状态
PATCH  /api/admin/gate               { maxConcurrency }
GET    /api/admin/pricing
POST   /api/admin/pricing
GET    /api/admin/audit-logs
```

---

## 12. 部署

### 12.1 目录布局

npm workspaces，没有 Turborepo：

```
AgentLodge/
├── apps/
│   ├── web/              # React SPA
│   └── server/           # 一个包，内部分三层（§2.1b），靠 ROLE 决定跑哪一半
│       └── src/{core,app,gateway}/
├── trace-proxy/          # 审计代理，零依赖，纯 Node 内置模块
├── credential-proxy/     # 独立的凭据注入网关，可选
├── authkey-sync/         # Go 写的凭据同步 sidecar，可选
├── docker/               # Dockerfile、compose、Caddyfile
└── scripts/              # 结构检查、假上游、冒烟自测
```

app 和 gateway 不拆成两个包：代码本就是两个独立的 Fastify app，同包分层 + 边界检查
已经能保证互不依赖，拆包只是多一层 workspace 配置。拆容器时靠 `ROLE` 切，零成本。

### 12.2 compose

两份，都在 `docker/`：

| 文件 | 用途 |
|---|---|
| `compose.yml` | 从源码构建，开发和自建部署用；`compose.docker.yml` 是 Docker 引擎的覆盖层（主文件按 podman 写） |
| `compose.release.yml` | 自包含，跑发布好的镜像，部署只需要它 + 一个 `.env` |

五个服务：`caddy` / `app` / `gateway` / `audit` / `authkey-sync`（最后一个可选）。
没有 postgres 也没有 redis —— 库是 SQLite，一个文件，app 和 gateway 共享（WAL）。

三张网络：

```
frontend   caddy ↔ app ↔ gateway
backend    app / gateway / audit 之间，以及出网
agent-net  agent 容器 ↔ gateway
```

**`agent-net` 不是 `internal`，它有外网出口**，理由见 §2.6b。agent 够不到的是 app 和
内网 —— 那两个不在这张网上。gateway 同时挂在三张网上：收 agent 的请求、收 caddy 转来的
用户自带 CLI 的请求、以及出网到上游。

### 12.3 容器生命周期
- **惰性创建**：用户首次发消息时创建，前端显示"正在准备环境…"（~2s）
- **保活**：每次 turn 更新 `last_active_at`
- **空闲回收**：定时任务每 5min 扫描，`now - last_active_at > 30min` 且无运行中 turn → `stop`（保留容器和 volume，下次 `start` 只需 ~0.5s）
- **深度回收**：停止超过 7 天 → `rm` 容器（volume 永久保留）
- **健康检查**：容器里没有常驻进程，所以探的是容器本身 —— `podman exec` 失败即视为不健康，下一轮重新拉起。空闲 `CONTAINER_IDLE_MS` 后 stop 但不 rm，下次 start 只要 ~0.5s
- **全局上限**：`MAX_RUNNING_CONTAINERS`（按内存推算），达到上限时优先回收最久未活跃的

---

## 13. 安全清单

| 风险 | 缓解 |
|---|---|
| 用户诱导 Claude 执行恶意命令 | 容器隔离 + 非 root + CapDrop ALL + no-new-privileges + 只读 rootfs |
| 容器逃逸 | Podman rootless 模式；不挂载任何 socket 到 agent 容器 |
| 窃取 API Key | Key 只存在于计量网关进程里；容器只有 20 分钟有效、绑死 (user, conversation, turn) 的 runtime token |
| 绕过计量 | agent-net 是 internal 网络，唯一可达目标是 proxy |
| 挖矿/资源滥用 | CPU/内存/PID/文件描述符全部限死；异常 CPU 持续高占用告警 |
| 磁盘打满 | 每用户 volume 配额 + 定时 du 检查 |
| 越权访问他人会话 | 所有查询强制 `where user_id = :me`；用 UUID 而非自增 ID |
| 暴力破解 | 登录接口 IP + 账号双维度限流；失败 5 次锁定 15 分钟 |
| SSE ticket 泄漏 | 60s 有效、一次性、绑定 user + IP |
| 提示注入导致数据外泄 | 容器无外网，Claude 拿不到数据也发不出去 |
| 依赖供应链 | 镜像 pin 版本 + `npm ci` + 定期 `npm audit` |

---

## 14. 可观测性

- **指标**（Prometheus 格式，`/metrics`）：
  - `upstream_gate_active` / `_queued` / `_effective_max`
  - `upstream_queue_wait_ms`（直方图）
  - `upstream_requests_total{status}`、`upstream_throttled_total`
  - `turn_duration_ms`、`turn_api_calls`
  - `container_running`、`container_cold_start_ms`
  - `tokens_total{user,type}`、`cost_micro_total`
  - `deepseek_balance`
- **日志**：pino JSON 结构化，全链路 `traceId = turnId`
- **告警**：余额低、drift > 5%、闸门排队 p95 > 30s、容器重启风暴、上游 429 激增

---

## 15. 实施里程碑

| 阶段 | 内容 | 产出验收 |
|---|---|---|
| **M0** 骨架（2d） | monorepo、schema.sql、compose、Caddy | `docker compose up` 全绿 |
| **M1** 认证（3d） | 邀请码注册、登录、refresh 轮转、设备管理、前端登录页 | 可注册登录，移动端可用 |
| **M2** 打通链路（4d） | agent 镜像、容器编排、exec 拉起 CLI、stream-json 解析、SSE、最简聊天页 | 能对话，能看到流式输出和工具调用 |
| **M3** 计量网关（4d） | 转发、usage 解析、流水计账、**并发闸门 + 公平队列 + 熔断** | 压测：10 用户并发，上游 in-flight 恒 ≤3，无 429 |
| **M4** 配额（2d） | 三层防御、周期滚动、超额错误格式、前端用量条 | 超额用户被正确拦截且提示清晰 |
| **M5** 高仿 UI（5d） | 侧栏、Markdown/Shiki、工具卡片、diff、虚拟滚动、附件、中断、PWA | 桌面/移动体验达标 |
| **M6** 管理后台 + 余额（3d） | 用户/配额/邀请码管理、余额轮询、对账、闸门看板 | 管理员可完整运营 |
| **M7** 加固（3d） | 安全项逐条落实、指标告警、压测调优、备份 | 上线 |

约 **26 人日**。M2 和 M3 是风险最高的两块，建议先做 M2 的技术验证 spike（见下）。

---

## 16. 几个只能靠实测回答的问题，以及答案

设计阶段有一批问题无法凭空确定，都已经跑出结论：

| 问题 | 结论 |
|---|---|
| 兼容端点会不会返回完整 usage | 会。`cache_read_input_tokens` / `cache_creation_input_tokens` 的语义与 Anthropic 一致，§7.3 的计费公式不用退化 |
| `--include-partial-messages` 能不能用 | 能，token 级 delta 正常。所以打字机效果是真的逐字，不是整段出现 |
| `/v1/messages/count_tokens` 支不支持 | 支持，网关单独实现了这个端点（不占并发 slot、不计费，但**必须鉴权** —— 它是拿真 key 往外转发的） |
| `--resume` 跨容器重启可不可靠 | 可靠，前提是 `~/.claude` 落在持久卷上。所以整个 HOME 都挂出来了（§6.2），写入层随 `rm` 消失而会话记录不能 |
| 上游真实限流阈值 | 3 是保守初值；AIMD 熔断器会自动适应，后台也能改。见 §7.4 |
| 当前模型价格 | 价格表里是占位值，**部署后必须按上游官网单价核对一遍**（后台 → 系统设置 → 价格表） |
| 容器引擎兼容性 | podman 和 docker 都验过。不走 dockerode，直接调 CLI —— `exec` 的 stdout 就是 CLI 的 stdout，少一层 API 抽象也就少一批引擎差异 |

唯一仍需按部署环境确认的是价格表：它是唯一一个填错了不会报错、只会让账单静悄悄算错的东西。

---

## 附：并发闸门参考实现

```ts
// apps/proxy/src/gate.ts
export interface Lease { release(): void; readonly waitedMs: number }

export class UpstreamGate {
  private effectiveMax: number;
  private active = new Set<symbol>();
  private queues = new Map<string, Waiter[]>();
  private hiPri: Waiter[] = [];
  private userInflight = new Map<string, number>();
  private cursor = 0;
  private consecutiveOk = 0;
  private queuedCount = 0;

  constructor(private readonly cfg: GateConfig) {
    this.effectiveMax = cfg.maxConcurrency;
  }

  acquire(req: AcquireReq): Promise<Lease> {
    return new Promise((resolve, reject) => {
      if (this.queuedCount >= this.cfg.maxQueueDepth)
        return reject(new OverloadedError());

      const w: Waiter = { ...req, enqueuedAt: Date.now(), resolve, reject };

      if (this.canGrantNow(req.userId)) return this.grant(w);

      (req.priority === 0 ? this.hiPri : this.queueFor(req.userId)).push(w);
      this.queuedCount++;
      this.emitQueueEvent(w);

      w.timer = setTimeout(() => this.drop(w, new QueueTimeoutError()),
                           this.cfg.queueTimeoutMs);
      req.signal?.addEventListener('abort', () => this.drop(w, new AbortError()));
    });
  }

  private canGrantNow(userId: string) {
    return this.active.size < this.effectiveMax
        && (this.userInflight.get(userId) ?? 0) < this.cfg.perUserInflightMax;
  }

  private grant(w: Waiter) {
    clearTimeout(w.timer);
    const key = Symbol(w.turnId);
    this.active.add(key);
    this.userInflight.set(w.userId, (this.userInflight.get(w.userId) ?? 0) + 1);

    const watchdog = setTimeout(() => { w.onLeaseExpired?.(); release(); },
                                this.cfg.leaseMaxMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(watchdog);
      this.active.delete(key);
      const n = (this.userInflight.get(w.userId) ?? 1) - 1;
      n <= 0 ? this.userInflight.delete(w.userId) : this.userInflight.set(w.userId, n);
      this.schedule();
    };
    w.resolve({ release, waitedMs: Date.now() - w.enqueuedAt });
  }

  /** 优先级 0 快车道 → 用户级轮转 */
  private schedule() {
    while (this.active.size < this.effectiveMax) {
      const w = this.takeHiPri() ?? this.takeRoundRobin();
      if (!w) break;
      this.queuedCount--;
      this.grant(w);
    }
  }

  private takeRoundRobin(): Waiter | undefined {
    const users = [...this.queues.keys()];
    for (let i = 0; i < users.length; i++) {
      const u = users[(this.cursor + i) % users.length];
      if ((this.userInflight.get(u) ?? 0) >= this.cfg.perUserInflightMax) continue;
      const q = this.queues.get(u)!;
      const w = q.shift();
      if (q.length === 0) this.queues.delete(u);
      if (w) { this.cursor = (this.cursor + i + 1) % Math.max(users.length, 1); return w; }
    }
  }

  /** 上游反馈驱动的 AIMD */
  reportUpstream(status: number, retryAfterMs?: number) {
    if (status === 429 || status === 503 || status === 529) {
      this.effectiveMax = Math.max(1, Math.floor(this.effectiveMax / 2));
      this.consecutiveOk = 0;
      setTimeout(() => this.recover(), retryAfterMs ?? 5000);
    } else if (status < 400 && ++this.consecutiveOk >= 20) {
      this.recover();
    }
  }

  private recover() {
    if (this.effectiveMax < this.cfg.maxConcurrency) this.effectiveMax++;
    this.consecutiveOk = 0;
    this.schedule();
  }

  stats() {
    return { active: this.active.size, queued: this.queuedCount,
             effectiveMax: this.effectiveMax, max: this.cfg.maxConcurrency };
  }
}
```

网关 handler 里的用法：

```ts
app.post('/v1/messages', async (req, reply) => {
  const claims = verifyRuntimeToken(req.headers.authorization);   // uid/cid/tid
  const verdict = await quota.check(claims.uid);
  if (!verdict.allow) return reply.code(402).send(anthropicError('permission_error', ...));

  const ac = new AbortController();
  req.raw.on('close', () => ac.abort());

  const isBackground = req.body.max_tokens <= 512 && !req.body.tools;  // 标题生成等
  const lease = await gate.acquire({
    userId: claims.uid, turnId: claims.tid,
    priority: isBackground ? 1 : 0, signal: ac.signal,
  });

  const acc = newUsageAcc(claims, lease.waitedMs);
  try {
    const res = await pool.request({
      path: '/v1/messages', method: 'POST', signal: ac.signal,
      headers: { authorization: `Bearer ${DEEPSEEK_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    gate.reportUpstream(res.statusCode, parseRetryAfter(res.headers));
    reply.raw.writeHead(res.statusCode, passthroughHeaders(res.headers));
    await tee(res.body, reply, acc);
  } catch (e) {
    acc.error = String(e);
    throw e;
  } finally {
    lease.release();          // ★ 一定在 finally
    await metering.settle(acc);
  }
});
```
