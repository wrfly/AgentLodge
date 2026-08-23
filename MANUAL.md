# AgentLodge

把 **Claude Code CLI** 和 **Codex CLI** 的能力，包装成一个多租户的 Web 对话服务 ——
高仿 Claude 的界面，底下跑 DeepSeek。

当前处于 **M3：计量网关 · 并发限速 · 容器隔离** —— 完整架构见 [DESIGN.md](./DESIGN.md)。

## 跑起来

```bash
npm install
JWT_SECRET=$(openssl rand -base64 32) npm run dev
```

> 这条命令每次都现生成密钥 —— 开发够用，但后台填的 API key 每次重启都得重填。
> 嫌烦就固定一个值（`export JWT_SECRET=...` 写进 shell 配置）。为什么见[部署](#部署)。

打开 http://localhost:5173

**首次启动**：控制台打印一个 bootstrap 管理员邀请码，用它注册第一个账号（自动是 admin）。

```
╭─────────────────────────────────────────────╮
│  首个管理员邀请码                            │
│  BXZX-C5YK-JWWX                             │
╰─────────────────────────────────────────────╯
```

前置条件：本机装了 `claude` 和/或 `codex`（`npm i -g @openai/codex`）。
没装的 agent 页面会说明原因，不影响另一个。

只提供其中一个也可以 —— 后台「系统设置 → Agent」把另一个关掉即可，见[只提供一个 agent](#只提供一个-agent)。

## 零成本测试

不想在调试界面、计量、限流的时候烧真 token —— 用内置的假上游：

```bash
npm run dev:free        # 假上游 + 后端 + 前端 一起起
```

然后进 `/admin` → 系统设置：

```
DeepSeek Base URL   http://127.0.0.1:9998
DeepSeek API Key    随便填（网关只要求非空）
```

整条链路照跑：真的 `claude` / `codex` CLI → 网关 → 假上游。CLI 不知道自己在跟假的说话，
所以流式渲染、工具卡片、逐次记账、配额拦截、并发闸门全都是真的在工作，只是不花钱。

假上游会**回显你的问题**，并按请求体大小编一份像样的 usage（缓存读占 80%），
这样价格表和配额才测得出区别。实测两轮对话记到 21540 计费 token / ¥0.0431。

| 环境变量 | 用途 |
|---|---|
| `MOCK_TPS` | 每秒吐几个 token（默认 25），设 0 则整段一次吐完 |
| `MOCK_DELAY_MS` | 首字节前的思考延迟，用来观察排队 |
| `MOCK_FAIL` | 注入 `429` / `500` / `timeout`，测限速退避和错误处理 |
| `MOCK_FAIL_RATE` | 注入比例 0..1 |

`GET http://127.0.0.1:9998/__stats` 能看到假上游侧记录的**真实峰值并发** ——
用来验证「同时最多 3 个打到上游」这条到底有没有生效。

## 上游 provider

网关往哪儿转发是**存库可配的**，后台增删改切，不用改代码也不用重启。

| kind | 用途 | 需要 key |
|---|---|---|
| `anthropic-native` | 原生说 Anthropic Messages 的端点：**官方 Anthropic**、DeepSeek 兼容层、自建 LLM 网关 | ✓ |
| `openai-chat` | 只会 `/chat/completions` 的端点：Ollama / LM Studio / vLLM / 多数第三方 | 视端点 |
| `mock` | **内置假上游**，不出网不花钱，切过去就能测全链路 | — |
| `local-agent` | 宿主机上的 CLI，**只出文本**，仅供冒烟测试 | — |

同一时刻只有一条生效。key 用 AES-256-GCM 加密存库，接口只返回 `hasKey`，生效中的那条不允许删除。

### key 也可以放在文件里

后台那个 API Key 框有两种模式：

| 模式 | 存的是什么 | 什么时候用 |
|---|---|---|
| 直接填写 | 密文（AES-256-GCM）进库 | 手上就一把长期 key |
| 从文件读取 | **只存路径**，每次发请求前现读 | key 由别的东西产出：docker/podman secret、secret manager sidecar、另一个容器写进共享卷 |

「从文件读取」解决两件事：密钥不经过浏览器、也不多一份拷贝进我们的库；
**别人轮换了那个文件，下一次请求就用新值** —— 不重启、不改配置、不用有人记得去后台改一遍。

能读哪些目录是白名单，默认两个：

| 目录 | 说明 |
|---|---|
| `<DATA_DIR>/secrets` | 数据卷里的子目录 —— app 和 gateway 本来就都挂了它，不用改 compose |
| `/run/secrets` | docker / podman secret 的约定位置 |

别的挂载点用 `SECRET_FILE_ROOTS` 加（冒号分隔，语义同 `PATH`）。
**真正读 key 的是 gateway**，所以那个卷至少要挂给 gateway；app 挂不挂都行 ——
不挂的话后台会提示「文件不存在（这是 app 容器看到的）」，保存不受影响，
少一个进程能碰到密钥反而更好。

把另一个容器的卷 share 进来，compose 里大致长这样：

```yaml
services:
  gateway:
    volumes:
      - vault-out:/data/secrets/vault:ro   # 白名单里已经有 <DATA_DIR>/secrets
  vault-agent:                              # 那个往里写 key 的容器
    volumes:
      - vault-out:/out
volumes:
  vault-out:
```

为什么要白名单：路径是管理员填的，读出来的内容会被当成 `Authorization` 发到**同样由管理员填的**
上游地址 —— 不限制的话「任意路径」就等于「把容器里任意文件传到管理员自己的服务器」。
路径不在白名单里、写成相对路径、或者是指向白名单外的软链接，保存时直接拒。

后台会显示文件的大小、更新时间、掩码和**内容指纹**（sha256 前 8 位）——
换过文件之后靠指纹确认服务端看到的是不是新的那份。内容本身任何接口都不返回。


### `anthropic-native` 的 Base URL 要带完整前缀

`/v1/messages` 直接拼在 Base URL 后面，所以厂商自己的路由前缀得写进去：

| 上游 | Base URL |
|---|---|
| 官方 Anthropic | `https://api.anthropic.com` |
| DeepSeek 兼容层 | `https://api.deepseek.com/anthropic` |
| 自建 LLM 网关 | 看它把 `/v1/messages` 挂在哪儿 |

这一层不认识任何厂商：Base URL 填什么就用什么，不会替你补 `/anthropic` 之类的前缀。
接兼容层时前缀自己写全，接官方地址时不要写。

模型名**原样透传**，网关不做映射：DeepSeek 兼容层自己会把 Claude 的模型名映射过去，
接官方 Anthropic 时透传本来就是对的。只有 `openai-chat` 那类端点不认 `claude-*` 的名字。

### 模型清单归 provider

每条 provider 自己带一份**模型清单**和**默认模型** —— 模型名是端点的属性，
换上游就是换一套名字。前端的模型选择器直接用生效中那条的清单；留空则退回 agent 的内置默认
（Claude 的 `opus`/`sonnet`/`haiku` 别名、Codex 的 `models.json`）。

> 早先这是两个全局设置项（`agent.claude.models` / `agent.codex.models`）。全局配的问题是
> 切回上一个上游还得把清单再改一遍，而且切换的那一瞬间清单和端点是对不上的。
> 存量配置由启动时的一次性迁移搬到当时 active 的那条 provider 上（两个 agent 的清单取并集）。

### openai-chat 是怎么通的

本地模型只会 chat 协议，而两个 CLI 都不说这个协议 —— **网关负责翻译**：

| CLI 说的 | 翻成 | 回程 |
|---|---|---|
| Anthropic Messages（Claude Code） | `/chat/completions` | chat SSE → Anthropic 事件流 |
| OpenAI Responses（Codex） | `/chat/completions` | chat SSE → Responses 事件流 |

覆盖 system / 多轮 / 工具定义 / tool_use / tool_result / 流式增量 / usage，不覆盖图片和 thinking 块。
**记账用的是上游那份原始 usage**，不是翻译出来的那份。

> Codex 0.147 起移除了 `wire_api = "chat"`，所以 Codex 这侧也只能由网关翻。

### local-agent 的边界

它把上游那一跳换成宿主机上的 `codex exec`，**强制只读沙箱、只取最终文本**。

为什么不能让它出工具调用：外层 codex 是另一个完整 agent，它自己的工具循环会跑在**宿主机**上——
容器隔离在这条路径上就没了。所以它退化成一个纯文本模型，容器里的 agent 永远收不到 `tool_calls`。

**只适合冒烟测试。** 多用户生产流量指到这里既跑不动（一次一个进程），也超出个人订阅的使用范围。

## 审计代理（可选，默认关）

审计代理落盘出网请求/响应的全文。**默认不启用** —— 后台（审计代理卡片）里打开它，
从那一刻起出网必经代理。

开与关是两种完全不同的链路，不只是「记不记录」的差别：

| | 开 | 关（默认） |
|---|---|---|
| 出网路径 | 网关 → 代理 → 上游 | 网关 → **上游（直连）** |
| 路由头 | 带 `x-forwarded-host` / `-proto` 告诉代理转给谁 | **不发** —— 直连时发出去只会让上游以为前面还有反代 |
| 没配 `AUDIT_PROXY_URL` 时 | `egressTarget()` 返回 null，网关 503，**不静默直连** | 无所谓，本来就直连 |
| 记录 | 请求头体 / SSE 逐事件 / 重建结果 / usage | 无 |

```
③ 计量网关 ──x-forwarded-host──▶ 审计代理 ──▶ ④ 真实模型 API
                                     │
                                     └─▶ /traces/  请求头体 · SSE 逐事件 · 重建结果 · usage
```

`trace-proxy/` 这份代码归本仓库维护，不再从外部同步。

### 一个实例，服务所有上游

审计代理是本项目的一部分（`docker/compose.yml` 里的 `audit` 服务），**全局只有一个**。
网关逐请求用 `x-forwarded-host` / `x-forwarded-proto` 告诉它这条转给谁，
所以换上游、加上游都不用动它，provider 上也没有什么代理地址要填。

服务端配一次：

```
AUDIT_PROXY_URL=http://audit:8796      # 网关和 app 侧（必须同值）
AUDIT_ADMIN_TOKEN=<随机串>              # 后台配置面板要用，app 和代理同值
PROXY_DYNAMIC_UPSTREAM=1               # 代理侧，不开会 403 掉带路由头的请求
```

> 早先设计过「每条上游一个代理实例、provider 上填各自的地址」，那是因为
> `pickUpstream()` 只认固定 `UPSTREAM_URL`。加了按 forwarded host 分流之后
> 这套就多余了，而且有害 —— 能给某条上游单独指别的代理等于绕过统一审计，所以删了。
> 单实例仍然可以把 `UPSTREAM_URL` 钉死，那时固定值优先于路由头。

### 为什么不是直接改 `Host`

`curl 1.2.3.4 -H "Host: api.deepseek.com"` 那套语义是对的，但网关用 Node 的 `fetch`，
**undici 把 `Host` 当 forbidden header 静默丢掉** —— 设了也不发，还不报错（实测确认）。
要改 Host 就得把出站从 `fetch` 换成 `node:http`，那要重写 SSE 透传和 usage 嗅探那一段。
`x-forwarded-*` 是反代链路的标准写法，语义一样而且 fetch 放行。Host 本身也带不动
scheme，proto 无论如何都得单独有个头。

### 后台可配

管理后台 → 上游 provider 下面有一块「审计代理」，能改：

| 项 | 说明 |
|---|---|
| **启用开关** | 出网走不走代理（默认关）。**这一条存在我们库里**，不是代理的配置 —— 所以代理不在线也能改 |
| **上游白名单** | 一行一个 `host[:port]`。留空 = 不限制（等于关掉 SSRF 防护） |
| **动态分流开关** | 关掉后带 `x-forwarded-host` 的请求一律 403 |
| **保留策略** | 天数 / 条数 / GB，任一触发就清理最旧的 |
| 状态 | 已存条数、占用、trace 目录、是否钉死了上游 |

改动**立刻生效**，并落盘到代理自己卷里的 `.proxy-config.json` —— 重启以文件为准，
env 只当初值。每次改动记进 `audit_logs`（白名单直接决定数据能发去哪儿，必须留痕）。

配置的源头放在代理那边而不是主服务的库里：代理是执行方，主服务只是客户端。
反过来做的话，代理重启到主服务把配置推下去之间有个窗口，那段时间它按 env 跑 ——
可能比管理员设的更宽。审计组件不该有这种窗口。

需要 `AUDIT_ADMIN_TOKEN`（app 和代理同值）。不配的话代理**不挂载**控制 API，
后台那块变成只读 —— 一个能改白名单的端点等于能把审计代理指向任意地址，默认开放不可接受。

### 换上游前记得先加白名单

后台切换上游时会**先问一次代理认不认这个 host**，不认就 400 并告诉你当前允许哪些：

```
PATCH /api/admin/providers/<id>  {"baseUrl":"https://api.zhipu.cn/anthropic"}
→ 400 审计代理不允许转发到 api.zhipu.cn。先在「审计代理」里把它加进白名单，
      当前允许：api.deepseek.com、api.anthropic.com
```

没这道检查的话，切换会成功，然后用户发消息时吃一个 403 —— 而那个 403 长得像上游故障。

### SSRF 防护

能被 header 指定目标 = 开放转发器。四道：

| 输入 | 结果 |
|---|---|
| `x-forwarded-host: api.deepseek.com` | 转发（在白名单里） |
| `x-forwarded-host: evil.example.com` | **403** 不在白名单 |
| `x-forwarded-host: host/../evil` | **403** 不是合法 host[:port] |
| `x-forwarded-host: host@evil.com` | **403** userinfo 混淆 |
| `x-forwarded-proto: file` | **403** 只允许 http / https |

另外 `PROXY_DYNAMIC_UPSTREAM` 默认关闭，代理只接内网，路由头在转发前摘掉不泄漏给上游。

### 三道闸（**启用之后**才生效）

| 位置 | 拦什么 |
|---|---|
| 后台 `activate` | 切到没配代理的出网上游 → 400 |
| 后台 `patch` | 把生效中那条的代理清空 → 400（否则先激活再清空就绕过去了） |
| 网关 `handleProxy` | 前两道被绕过（比如直接改库）→ 503，且在**拿并发 slot 之前**拒 |

开关关着的时候这三道全部让行 —— 判据的第一句就是「没启用就不需要代理」。

判据收在 `core/egress.ts`，两层共用一份 —— 分家的话会出现「后台说能切、网关说不许发」。

### 豁免与开关

回环上游（`127.0.0.1` / `localhost` / `::1`）和不出网的 kind（`mock` / `local-agent`）豁免：
流量根本没离开这台机器，没有审计对象。所以 `npm run dev:free` 和 `npm run selftest` 照常跑。

**启不启用是后台开关**：管理后台 → 审计代理 → 「启用审计代理」，**默认关**。
`USE_AUDIT_PROXY` 是它的初值 —— 改环境变量意味着重建容器，而运维出状况时得能当场切。

开着的时候「凡是出去过的都有记录」才成立，所以这个开关本身做了三件事：

| | |
|---|---|
| 存在库里（`egress.useAuditProxy`），读的时候**绕过设置缓存** | app 和 gateway 是两个进程，设置缓存各存各的。不绕过的话后台关了、网关要等重启才认 |
| 每次改动进 `audit_logs`，动作名直接写明方向 | `admin.egress.audit-on` / `admin.egress.audit-off`，不用去 detail 里翻 |
| 代理连不上时**照样能改** | 代理挂了正是最需要临时放行的时候。要求代理在线才能关掉强制，等于死锁 |

### 部署上的四个约束

1. **`PROXY_RETRY=0` 和 `PROXY_MAX_CONCURRENT=0` 不是调优项。**
   代理自带重试会把上游的 429 悄悄吃掉，网关的 AIMD 就再也收不到降并发的信号，
   反而因为「连续成功」抬高并发 —— 上游在限流我们却在加压。并发同理：两级队列
   串联会让槽位对不上账，而且代理认不出用户，做不了单用户上限和公平队列。
2. **`/__trace` 界面默认关掉**（`PROXY_UI_PREFIX=""`）。它现在有鉴权（见下），但里面是
   所有用户的完整 prompt，而 compose 里这个容器只接 backend 网络，开着也没人够得着 ——
   要看数据用离线 viewer（见「怎么看审计记录」）。
3. **代理只接 `backend` 网络**，Caddy 和公网都够不着。浏览器不直接连它 ——
   后台那页是 app 通过控制 API 读出来再渲染的。
4. **代理挂了 = 所有 LLM 流量挂了。** 这是 fail closed 的代价，也是审计要的语义。
   错误信息会明说是代理不可达，不会伪装成上游故障 —— 否则运维会去查 DeepSeek 状态页。

### `/__trace` 界面的鉴权

部署形态下这个界面是关着的（看数据走后台，见下一节）。它主要服务本机抓包那种用法
（`npm run trace`）—— 那时它放行两种请求，其余一律 401：

| | |
|---|---|
| **回环地址** | 本机浏览器、本机 curl、`docker exec` 进容器里访问 |
| **admin token** | `Authorization: Bearer <PROXY_ADMIN_TOKEN>`、cookie `trace_admin`，或一次性的 `?token=` —— 命中后种 HttpOnly cookie 并 302 掉查询串，token 不留在地址栏和 referer 里 |

判「回环」看的是 **socket 对端，不看 `X-Forwarded-For`** —— 那是客户端能随便写的，
拿它鉴权等于没鉴权。代价是代理跑在容器里、你从宿主机走发布端口访问时对端是网桥地址，
**不算回环**，那种情况要带 token。没配 `PROXY_ADMIN_TOKEN` 时就只剩回环这一条路。

### 怎么看审计记录

三份「audit」数据是分开的，前两份在网页里，第三份要另外开：

| 数据 | 入口 |
|---|---|
| 管理动作（`audit_logs`） | 后台 → **审计日志** |
| 每用户「我发了什么」 | 用户自己的 **`/traces`** |
| **出网流量全文** | 后台 → **出网 trace** |

后台那页走 `/api/admin/traces`：app 拿服务端的 `AUDIT_ADMIN_TOKEN` 去问代理的控制 API
（`GET /__admin/traces`），再渲染给管理员。**浏览器不直接连代理** —— 所以代理不用暴露到
前端网络，也不用往浏览器种代理的 token。页面上还有一个**一键清空**（会记进 `audit_logs`）。

不开浏览器也能看：

```bash
docker exec agentlodge-audit-1 node trace-proxy/view.js         # 列表
docker exec agentlodge-audit-1 node trace-proxy/view.js 11      # 展开第 11 条
docker exec agentlodge-audit-1 node trace-proxy/view.js 11 --events   # SSE 逐事件
```

### 落盘了什么

请求头体、SSE 逐事件、重建后的响应、usage。凭据在 `authorization` / `x-api-key` /
`cookie` 上按 `SECRET_HEADERS` 脱敏（长串留首 12 尾 4，短串整个 `***`）。

**请求体是全文，不脱敏** —— 里面是所有用户的完整 prompt。这是审计要的，
也意味着那个卷的备份和访问权限得按合规要求处理。保留策略默认 30 天 / 10 万条 / 10GB，
`AUDIT_MAX_DAYS` / `AUDIT_MAX_COUNT` / `AUDIT_MAX_MB` 可调。

## 只提供一个 agent

机器上装了两个 CLI，不代表两个都要对外提供。后台 **系统设置 → Agent** 给每个 agent 一个开关，
关掉的那个从界面上彻底消失：切换器不画它（只剩一个时连切换器本身都不画）、深链到它的地址会
跳回还开着的那个、新会话也不会落到它上面。

**这跟「装没装 CLI」是两件事，卡片上分开显示：**

| | 谁回答 | 用户看到什么 |
|---|---|---|
| 装没装 | 探测（spawn 一下 CLI） | 「没找到 CLI」—— 这是**故障**，页面会说原因 |
| 提不提供 | 管理员开关 | 什么都看不到 —— 这是**决定**，不该让用户去问「另一个哪儿去了」 |

分开的理由就在最后一列：故障要解释，决定不需要。把关掉的 agent 显示成「不可用」，
等于让每个用户都去猜是不是坏了。

**已有的会话不会删**，只是够不着了 —— 重新打开那个 agent，它们还在。

**至少要留一个开着。** 后台不让你关掉最后一个（开关会置灰），接口那边也拦：
`agents.enabled` 存空值会被拒。这条约束在写入那一刻挡住，而不是等到界面上一个 agent 都没有
才发现。

初值可以用 `ENABLED_AGENTS=claude` 这样的环境变量给，但**改过之后以后台设置为准** ——
和其它「后台可配」的设置一样。

## 用自己的 CLI 接进来

除了网页对话，用户可以把**本机的 Claude Code / Codex** 指到本服务，共用同一个账号和额度。
在 `/api-keys` 建一把密钥（明文只显示一次），页面上给出一条命令：

```bash
curl -fsSL https://你的域名/api/cli/install.sh | sh -s -- al_xxxxx
```

脚本本身在那个地址上公开可读（不含任何密钥，人人一份），界面上也折叠着全文，可以先看再跑。
它落下这些东西：

```
~/.agentlodge/key            密钥，单独一个文件，权限 600 —— 换 key 只改这里
~/.agentlodge/claude/        CLI 的配置目录，凭据由包装脚本每次运行时重建
~/.agentlodge/bin/claude     包装脚本：读 key 文件、写凭据、设好 BASE_URL，再 exec 真正的 claude
你的 shell rc                加一行，把上面那个 bin 放到 PATH 最前
```

之后**照常敲 `claude`** 就是连本服务。脚本会把这个配置目录标记成「已完成引导」——
独立 profile 里没有这个标记的话，Claude Code 会跑首次引导（选主题、然后**要求登录**），
凭据明明已经放好了也一样。**换密钥不用重装**——把新的写进 `~/.agentlodge/key`
就行，下一次运行自动生效。卸载执行 `~/.agentlodge/uninstall.sh`，rc 那一行和整个目录一起
删掉。

Codex 没有对应的配置目录机制，仍然走环境变量：

```bash
export OPENAI_API_KEY=al_xxxxx
codex -c model_provider=agentlodge \
      -c model_providers.agentlodge.base_url=https://你的域名/v1/ \
      -c model_providers.agentlodge.wire_api=responses
```

`Authorization: Bearer` 和 `x-api-key` 两种头都认。

### 凭据为什么放在配置目录里

**`ANTHROPIC_BASE_URL` 不是认证**。空配置目录下 `claude auth status` 回
`{"loggedIn": false, "authMethod": "none"}`，所以只设 BASE_URL 它仍然要你登录。凭据文件
就是那次"登录"，而它由我们签发：放好文件之后同一条命令回
`{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}`。

`CLAUDE_CONFIG_DIR` 是这件事安全的前提：文件写在我们自己的目录里，用户 `~/.claude` 下的
登录一个字节都不碰，两者并存。代价是这个会话是**独立的 profile**——自己的 settings.json、
MCP、历史记录。

一句提醒：**这用的是未公开的文件格式**（字段来自 CLI 自己的 OAuth 保存逻辑：`accessToken`、
`refreshToken`、`expiresAt`、`scopes`、`subscriptionType`）。两个 scope 少不得，
`user:inference` 决定会话算不算已登录，`user:profile` 是账号面板要检查的。CLI 改结构这条
就会断，所以它是便利，不是契约。

### 和网页对话的差别只有一处

**工具在用户自己机器上执行**，读写的是他本地的文件。容器隔离在这条路径上不参与 ——
也不需要参与，那是他自己的机器。这符合本项目那条规律：
**谁消费 `tool_calls`，工具就在谁那儿执行**。

| | 网页对话 | 自带 CLI |
|---|---|---|
| CLI 跑在哪 | 我们的容器 | 用户笔记本 |
| 工具在哪执行 | 容器里 | **用户机器上** |
| 会话与文件 | 我们存 | 我们没有 |
| SSE 事件（排队位置等） | 有 | 无（没有会话可推） |
| 认证 / 配额 / 限流 / 记账 / trace | ✅ | ✅ **同一套代码** |

用量记在同一个账上，`/usage` 和 `/api-keys` 都看得到；`/traces` 里每条会标「网页对话」还是「自带 CLI」。

### CLI 里看到的额度，是他自己的

上游是一份共享订阅，所以上游返回的"还剩多少"是**整个平台**的。网关不转发它，改成回这个
用户自己的配额：

- `claude` 的 `/usage` 面板读 `GET /api/oauth/usage` —— 网关自己应答，不透传
- 每个 `/v1/messages` 响应上的 `anthropic-ratelimit-unified-*` 头，按该用户的配额重写
- Codex 的额度跟着响应体走（`rate_limits`），在流里摘掉

CLI 那两条线是**平台的**窗口，不是每个人自己的：边界取上游响应头里的真实 reset
（所有人一致），窗口里的数量是这个用户自己的消耗，分母是他的配额按窗口长度折算
（日配额 10M → 5 小时约 2.08M，7 天 70M）。

这一点很重要：上游 2 点重置、窗口到 7 点，某人 4 点才发第一条消息——按他自己算窗口到 9 点，
可 7 点池子就空了，他会带着没用完的配额被拒。边界必须是平台的。

上游还没回过响应时（网关刚重启、用的是假上游）回落到配额周期本身，按长度落位：24 小时
以内进「Current session」，其余进「Current week」。

`claude` 的 `/usage` 面板是个例外：它**不经过我们**。实测——挂 HTTPS_PROXY 抓 CONNECT，
那个请求直连 `api.anthropic.com:443`，用的是本机的 claude.ai 登录，`ANTHROPIC_BASE_URL`
对它无效。

而这条接法里那台机器在这个 profile 下没登录任何 claude.ai 账号，所以面板既没有额度数字，
也不产生任何外联（实测：CONNECT 记录为空）。**用不着我们覆写，它根本不去问。**

限额提醒走的是响应头，那条确实经过我们，而且确实被采信。把利用率回成 0.98，CLI 就发出：

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed_warning","utilization":0.98,"rateLimitType":"five_hour","resetsAt":1787485541}}
```

这个 0.98 是网关按**该用户自己的配额**算出来的，跟共享订阅用了多少无关。

### 部署时要打通的三件事

1. **Caddy 把 `/v1/*` 转到网关**（`docker/Caddyfile` 已写好，`flush_interval -1` 别漏）。
   只放 `/v1/*` —— 网关上的 `/gate` 能改并发上限，虽自带鉴权，也没理由出现在公网路由表里。
2. **网关接上 `frontend` 网络**，否则 Caddy 够不着（`docker/compose.yml` 已改）。
   不开这个功能就把它删回去，网关退回只有内网可达。
3. **`PUBLIC_GATEWAY_URL`** 告诉用户 BASE_URL 填什么。这是**第三个**网关地址，跟
   `GATEWAY_URL`（容器里的 agent 用）和 `GATEWAY_INTERNAL_URL`（本进程读闸门用）都不是一回事。

### 密钥怎么存的

`al_` + 32 字节随机数，库里**只存 sha256**，明文创建时返回一次。

用 sha256 不用 bcrypt/argon2：key 是 256 位随机数，不存在弱口令；而每个请求都要按哈希做
等值查找，慢哈希会逼着全表扫描。撤销是软删 —— 留着才能让历史用量还指得到某一把 key。

## 路由

| 路径 | 说明 |
|---|---|
| `/claude` `/codex` | 对话，各自独立的会话列表、工作目录、模型选择 |
| `/usage` | 个人用量：额度、30 天趋势、按 agent/模型/会话拆分 |
| `/memory` | 记忆：看/改/删/加，可撤销 |
| `/profile` | 使用画像 + 会话总结 |
| `/api-keys` | API 密钥：把本机 CLI 指到本服务 |
| `/settings` | 改密码、登录设备管理 |
| `/admin` | 管理后台：总览 / 用户 / 邀请码 / 系统设置 / 审计日志 |
| `/register?code=` | 邀请注册（邮件链接会预填邀请码和邮箱） |
| `/reset-password?token=` | 密码重置 |

### 项目页

`site/index.html` 是项目的展示页，发布在 GitHub Pages 上（`.github/workflows/pages.yml`，
改动 `site/` 就自动发布）。它**不由本服务提供**——展示页放在自己的域名上，等于要公开这个
域名才能介绍项目。

- 一个自包含的 HTML：内联样式和脚本、中英双语（跟随浏览器）、深浅色跟随系统，没有构建步骤
- 资源引用一律相对路径，因为 Pages 把它放在仓库名的子路径下（本仓库是
  <https://wrfly.kfd.me/AgentLodge/>，账号配了自定义域名；没配的话是
  `<owner>.github.io/<repo>/`）
- **截图**：丢进 `site/`，命名 `shot-chat.png`、`shot-usage.png`、`shot-memory.png`、
  `shot-admin.png`。没放的会自己从页面上消失，四张都没有的话整节都不显示
- 页面上没有通往应用的链接：它不知道、也不该知道谁把这个项目部署在哪

## 功能

**认证**
- 邀请码注册；**邮件邀请**（SendGrid）：定向绑定邮箱，只有被邀请人能用
- scrypt 口令哈希；登录失败 IP + 邮箱双维度锁定
- access token（JWT / 15 分钟 / 只存内存）+ refresh token（30 天 / httpOnly cookie / 存库仅哈希）
- **refresh token 轮转 + 重放检测**：旧 token 被二次使用即判定泄漏，撤销该用户全部会话
- 修改密码（自动登出其它设备）、忘记密码 → 邮件重置链接（30 分钟一次性）
- 多设备管理、账号停用即时踢线
- 所有查询强制按 `userId` 过滤，越权一律 404

**计量网关（M3）**
- agent 的所有上游请求强制经过网关，**真实 API key 只存在于网关进程**，
  agent 拿到的是绑定 `(user, conversation, turn)` 的 20 分钟 runtime token
- 逐次调用记账：从 SSE 流里旁路解析 usage，不改写字节流
- **配额硬闸门**：在一个 turn 内部也能刹住（M2 的 turn 级拦截做不到）
- **全局并发闸门**：任一瞬间打到上游的 in-flight ≤ 3（可在后台热调）
  - 用户级轮转而非全局 FIFO —— 否则一个用户的 agent 循环会把别人饿死
  - 单用户最多占 2 个 slot，防独占
  - AIMD 自适应：上游返回 429 就把并发砍半，连续成功 20 次再加回来
  - 排队时把「前面还有几个」推给前端，不让人对着转圈猜
- 同时兼容两种协议（实测抓包确认）：Claude Code 走 Anthropic Messages，
  Codex 走 OpenAI Responses
- **两种凭据打同一个网关**：容器用 20 分钟票据，用户自带的 CLI 用长期 API key；
  认完之后配额、限流、记账、trace 走的是同一套代码

**容器隔离（M3）**
- 每用户一个常驻容器，CLI 通过 `podman exec` 在里面跑，30 分钟空闲自动停
- 非 root（uid 10001）· CapDrop ALL · no-new-privileges · 内存/CPU/PID 限额
- 只挂载该用户自己的工作目录，用户之间互不可见
- 容器环境里没有任何凭据 —— 只有一张绑定 `(user, conversation, turn)` 的短期票据
- **有外网**：agent 要能装包、查资料。计量绕不过去靠的是没有 key，不是没有网

**配额与用量**
- 每个用户有**三个上限**：5 小时 / 周 / 月，任一超了就拦，留空表示那个窗口不限
- **窗口边界全平台统一**：5 小时窗口跟着上游响应头里的 `-5h-reset` 切（网关写进设置表，
  app 和 gateway 都读它），周和月用已有的全局锚点。上游 2 点重置、7 点结束的窗口，谁看都是
  7 点结束——不会出现「4 点发第一条消息的人以为自己能用到 9 点」这种事
- **充值 = 给某一个窗口临时抬高上限**，窗口一重置自动失效，不需要设有效期
- **手动清零**只把计数起点挪到窗口内部，不动边界
- **后台里额度一律以百万 token（M）为单位输入**：用户额度、邀请码预置额度、充值、
  新用户默认额度，四处一致。`5000000` 里少一个零看不出来，`5` 里少一个看得出来。
  存储、计费、比较仍然是 token —— 只有输入框换算，服务端一个字节都没变
- **重置时刻可配**：月度不必是 1 号、周不必是周一，都能精确到小时（全局设置，对所有人生效）
  - 31 号锚点遇 2 月自动取当月最后一天；锚点小时未到时"本期"从上一个锚点算起
  - 这段日期推算有 26 条边界用例覆盖：`npm -w @agentlodge/server run test:period`
- **没有定时 reset 任务**：用量是「查 `created_at >= 周期起点` 的和」，
  跨过边界后旧数据自然不再计入 —— 也就没有「reset 任务挂了把所有人卡住」的故障模式
- 管理员可手动清零某个用户的当期用量（**不删账单**，只把统计起点往后挪，可撤销）
- 计费 token = 输入 + 缓存读取×0.1 + 缓存写入 + 输出×1.5（权重可在后台改）
- 超额时 402 拦截并禁用输入框；用量过 90% 自动发提醒邮件（每周期一封）
- **上游套餐额度只给管理员看**：后台总览有一张卡，显示这份共享订阅自己报的
  5h / 7d 利用率、重置时刻、overage 状态，外加原始响应头。用户那侧看到的是各自的配额
  —— 同一次响应，两个答案（`§ CLI 里看到的额度`）
- 个人页：**今天/昨天/本周/本月/近 7 天/近 30 天/本配额周期/全部/自定义区间**
  - 短跨度按小时出图，长跨度按天出图
  - 每个区间都给：总量、剩余、按 agent+模型拆分、按会话拆分
- 后台：全站趋势、消耗排行、DeepSeek 余额

**记忆**

用的是 **Claude Code 自带的记忆存储**——一条事实一个文件，外加一份索引：

```
workspaces/<userId>/memory/MEMORY.md      索引：- [标题](文件.md) — 一句话
workspaces/<userId>/memory/<slug>.md      一条事实：YAML frontmatter + 正文
workspaces/<userId>/<convId>/memory   ─→  指向它的符号链接，codex 也能写
workspaces/<userId>/<convId>/AGENTS.md    上面这些渲染成一整份，给 codex 加载
```

- **它自己会记**。不用说「记住」，你在对话里说「以后回答用中文」，它当场就写一条
  `type: feedback` 的记忆，还会自动把「今天」这种相对时间转成绝对日期
- **跨会话召回**。下一个会话、不同工作目录，照样读得到
- **靠 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 指到用户级目录**。不指的话，它的记忆目录是
  从 cwd 推导的，而我们的 cwd 是每个会话一个——那样每个会话都会有一份自己的记忆，谁也
  带不到下一个会话
- **codex 没有这套机制**，所以给它两样：`./memory/` 目录链接（能改），和把所有事实
  内联展开的 `AGENTS.md`（能读）。每轮重新渲染
- **`/memory` 页面**：看它记了什么、改任何一条、删、手动加一条它推不出来的事
- **可以撤销**：页面上一键回到上一次改动之前。快照在我们自己写入的前后各记一份；agent
  直接改文件不走我们的代码，所以每轮开始和页面每次读取时也补一次

**你怎么用它（`/profile`）**

从自己的对话和用量记录里数出来的一页，不经过模型，只有本人看得到：

- **什么时候在用**：24 小时 + 星期分布。服务端按 UTC 的「周内小时」分 168 个桶，浏览器按
  自己的时区旋转 —— 所以图永远是**看的人**的时间，跟服务端 `TZ` 无关
- **怎么用**：动了手的轮次占比（assistant 消息里有 `tool_use` 块）、被打断的、出错的、
  每个对话几条消息、每轮几秒（中位和 90 分位）、多少来自自带 CLI
- **怎么提问**：每条字数中位/90 分位、中日韩文字占比（取最近 500 条）
- **选了什么**：agent / 模型 / effort 分布

**会话总结与画像**（同一页，按钮触发）

分两步，中间那层是关键：

```
每个对话 ──总结一次，存进 conversations.summary──→ 几行字
                                                    ↓
                       所有总结 + 上面那些数字 ──→ 一段画像 + 若干「值得记住的」候选
                                                    ↓
                                          你点「记下来」才进入记忆
```

- **总结自动进行**：每 30 分钟扫一次，挑出**安静了 15 分钟以上**、且总结落后于内容的对话
  （每次最多 24 个，全站合计）。判据是安静而不是"这一轮结束了"——十分钟后回来接着聊的还是
  同一个对话，每轮都总结等于为同一个对话反复付钱
- **顺手改标题**：标题一开始是第一条消息截出来的（「hello」「pin」），总结的时候同一次
  调用会给一个真正说明内容的名字。**你自己重命名过的不动**（`title_custom`）
- **总结是一次性的**，存在 `conversations.summary`，只在对话又长了（`summary_upto` 小于
  当前消息数）时才重做
- **画像读的是总结，不是原始消息**。一年的对话到画像这步也只有几百行输入，永远是一次
  便宜调用。这一步是按钮触发的：它是"读给你听"的东西，你想看的时候再生成
- **画像不写记忆**。它给出候选，你点「记下来」才变成一条正常的记忆记录
- **总结本身有用**：页面底部「每个对话一句话」列出最近 20 条，这也是画像的原料，
  可以核对而不是只能相信
- 两步都走网关、计你自己的配额。一次总结的开销大约是被总结那个对话的 1%

**工作区文件**
- agent 生成的代码/报告/数据可以浏览、预览（语法高亮）、下载、删除
- 支持上传（拖拽 / 点击，最大 20MB），上传后 agent 可直接读写
- 路径穿越防护：所有路径必须解析在会话目录之内

**模型列表**
- 三层回退：**provider 的 `models` 字段** → 环境变量 `CLAUDE_MODELS` / `CODEX_MODELS` →
  各自内置默认（claude 是 `opus`/`sonnet`/`haiku` 三个别名，codex 读 `~/.codex/models.json`）
- 模型名放在 provider 上而不是全局：型号是**端点的属性**，换上游就是换整套名字
- 后台 provider 表单里有「从上游拉取」——网关拿这个 provider 的 key 去问它的
  `/v1/models`（openai-chat 是 `/models`），把结果填进列表。DeepSeek 那种
  `…/anthropic` 兼容层前缀会自动去掉，因为模型列表在根上
- 上游答不上来时给的是**原因**而不是空列表（404 / 连不上 / 没配 key / 内置假上游），
  否则「问不到」和「没有模型」在界面上长得一样、意思相反
- **每小时自动拉一次**，开关在后台**上游 provider 卡片底部**（不在通用设置列表里——一个关于
  模型列表的开关，摆在一堆无关设置中间没人找得到），**默认关**：
  打开等于把手工维护的列表交给上游。只拉**当前启用的那个 provider**（选择器用的就是它；
  配置别的 provider 时管理员就在界面上，有手工按钮）。上游答不上来**什么都不改**，不会
  把能用的列表清空；列表没变也不写库，免得 `updated_at` 每小时动一次、审计日志里全是
  没改动的改动。真的变了会记一条 `provider.models.refresh` 审计（带改前改后），
  没有 actor —— 不是人做的
- 自带 CLI 也可以直接 `GET /v1/models`（同样的凭据鉴权，不计费、不占并发 slot）
- 列表只是候选：对话框永远允许手输型号
- **对话框里按前缀分组**：`claude-opus-5 / claude-opus-4-8 / claude-sonnet-5 …` 归成
  opus / sonnet / fable / haiku，每族默认只露**最新的那个**，旧版本折在「N 个旧版本」后面，
  点开随时可选。版本按数字段比较（`4-10` 新过 `4-8`），别名排在自己的日期快照前面
  （`claude-opus-4-5` 在 `claude-opus-4-5-20251101` 之前）。族的顺序**保持管理员配置的顺序**，
  不重排——那一栏的说明写着「模型选择器直接用这个列表」。分组规则在
  `core/protocol.ts` 的 `groupModels`（17 条测试），没有任何一族多于一个版本时不分组，
  界面跟以前一样
- 「默认用哪个」是 provider 的 `defaultModel` 字段，不是分组决定的：会话没指定型号时用它
  （`turns.ts:204` 的回退链是 会话 → provider.defaultModel → `MODEL` 环境变量 → 交给 CLI）

**模型与推理强度**
- 输入框内两个下拉，只影响后续消息；新会话继承当前选择
- Claude 模型走别名（`opus`/`sonnet`/`haiku`），接第三方端点时由 `ANTHROPIC_DEFAULT_*_MODEL` 映射
- Codex 模型读 `~/.codex/models.json`
- 强度取值实测得到：Claude `low|medium|high|xhigh|max`；Codex 另有 `none|minimal`

**后台可改，无需重启**
- **上游 provider**：地址、API Key（直接填或**从文件读**）、模型清单、默认模型，增删改切。有一条 active 的就启用计量网关，
  agent 从此只能经网关访问上游；一条都没有则沿用本机 CLI 自己的配置，用量退化为按轮次粗记
- **审计代理**：启用开关（默认关）、上游白名单、保留策略
- **并发闸门**：全局上限热调
- 系统设置：SendGrid Key / 发件人 / 站点地址（带「发测试邮件」按钮）、新用户默认额度、计费权重
- 密钥用 AES-256-GCM 加密后存库，接口只返回掩码

**对话**
- 多轮上下文、SSE 断线续传、同会话串行、中断（SIGINT → 3s → SIGKILL）
- 导出为 Markdown
- 流式打字机（rAF 批处理）、Markdown + Shiki 高亮、工具卡片、思考块折叠
- 移动端抽屉侧栏、`100dvh`、安全区、中文输入法组字保护

## 仓库结构

```
apps/server/          AgentLodge 后端（三层，见下）
apps/web/             React SPA
trace-proxy/          抓包用的透明代理（独立上游项目，可整个替换）
credential-proxy/     凭据注入代理（独立项目，管钥匙不管人）
scripts/              假上游 · 分层检查 · trace-proxy 的 CJS 标记
docker/               镜像与 compose
```

**「网关」这个词只指一个东西**：`apps/server/src/gateway`，AgentLodge 的计量网关。

历史上有三个东西都叫过 gateway，混淆过好几次，现在按职责区分开了：

| 现名 | 曾用名 | 它管什么 | 认得出「谁」在调用吗 |
|---|---|---|---|
| `src/gateway` | — | 计量、配额、并发、协议翻译 | ✅ 票据里有 userId |
| `credential-proxy/` | `gateway/auth` | 保管 API key / 订阅凭据，自动刷 token | ❌ 单一 `GATEWAY_TOKEN` |
| `trace-proxy/` | `proxy` | 抓报文，只观察不决策 | ❌ 看到的票据是不透明的 |

判据就一条：**认不认得出用户**。认得出才谈得上按人计费、单用户配额、公平队列；
认不出的那两个各管一层别的事，可以串在计量网关的上游侧。

## 代码结构

`apps/server` 一个包，三层，靠 `ROLE` 环境变量决定跑哪半边：

```
apps/server/src/
├── core/       3.3k 行  两边都能用，谁都不依赖
│   config · protocol · quota · events · runtime-token
│   auth/{crypto,guard,tokens}  ·  db/（13 张表 + schema.sql）
├── app/        3.6k 行  管「人」和「事」
│   routes/{auth,conversations,me,admin/}  ·  agents/（两个 CLI 适配器）
│   turns · containers · workspace · memory · mail
├── gateway/    1.7k 行  管「钱」和「上游」
│   index（处理链）· gate（并发闸门）· translate（协议翻译）
│   upstream（provider 解析）· usage-parser
└── index.ts             装配点，两边都 import
```

**边界靠机器守**，不靠自觉：

```bash
node scripts/check-layers.mjs
# ✓ 分层边界 OK（core ← app / gateway，两侧互不依赖）
```

规则一句话：**core 谁都不依赖，app 和 gateway 不许互相依赖**。已挂进
`npm run typecheck`，越界直接退出码 1。

为什么要机器查：两层现在同进程跑（`ROLE=all`），随手 import 一下也能跑通，
等拆成两个容器部署才发现越界 —— 那时候的表现是「dev 好好的，线上静悄悄少了点
东西」，最难查。第一次跑这个检查就抓出三处历史越界。

几条不显然的归属：

| 文件 | 在哪 | 为什么 |
|---|---|---|
| `runtime-token.ts` | core | app 签、gateway 验，是两层之间的**契约** |
| `events.ts` | core | gateway 要往里推 `queue.waiting`（见 §已知限制） |
| `agents/provider.ts` | app | 只有 app 需要知道「agent 该往哪连」 |
| `gate.ts` | gateway | 并发决策只有一个地方做，proxy 和 agent 都不参与 |

## 数据

SQLite（`node:sqlite`，零依赖），文件在 `data/agentlodge.db`。
所有访问收在 `src/core/db/` 下，迁 Postgres 只需替换这一层。
启动时会自动把 M1/M2 的 JSON 数据导入并归档源目录。

```
data/
├── agentlodge.db          用户/会话/消息/用量/设置/审计
└── workspaces/<userId>/
    ├── MEMORY.md        记忆（+ CLAUDE.md / AGENTS.md 镜像）
    └── <convId>/        每个会话的工作目录
```

## 忘记密码，又没配邮件

邮件没配的话，「忘记密码」那条路是断的——重置链接发不出去。所以有一个只能在部署机器上跑的命令：

```bash
# 列出所有账号
docker exec agentlodge-app-1 node apps/server/dist/cli/reset-password.js

# 设一个随机密码，打印出来
docker exec agentlodge-app-1 node apps/server/dist/cli/reset-password.js admin@example.com

# 或者自己指定（至少 8 位）
docker exec agentlodge-app-1 node apps/server/dist/cli/reset-password.js admin@example.com '换一个密码'

# 开发时
npm -w @agentlodge/server run reset-password -- admin@example.com
```

- **它不校验任何身份，也不需要**：能跑到这一步就已经拿着数据目录了，拿着数据目录的人能干的事
  比改密码严重得多。真正重要的是它**不经过 HTTP** —— 是一个独立入口，不是一条路由
- 跟应用内改密码同一套语义：写同样的哈希、撤销该用户**全部会话**、记一条审计（`via: console`）
- 账号被停用的话它会告诉你，但**不会顺手启用**——要启用得显式加 `--activate`

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | |
| `DATA_DIR` | `./data` | |
| `TZ` | `UTC` | **部署机器的时区**。按时间分桶的东西都用它：用量记录算哪一天、配额窗口落在哪。启动横幅会打印实际解析到的时区，对不上就是没生效。取值 `cat /etc/timezone`。⚠️ 别用挂 `/etc/localtime` 代替：`date` 会显示对，Node 仍然是 UTC |
| `JWT_SECRET` | 随机 | ⚠️ 不设置则每次重启换密钥，已加密的设置项（API key）解不开，需重填 |
| `SECURE_COOKIES` | `false` | 生产设 `true` |
| `TRUST_PROXY` | `1` | 信任几跳反代。反代后面不设就等于**所有人共用一个 IP**：审计追不到来源，而且登录锁定按 IP 分桶会变成全站锁。别设 `true`（Caddy 是追加 XFF，信任整条链等于让客户端自己填 IP）|
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | |
| `ENABLED_AGENTS` | `claude,codex` | 这个部署对外提供哪几个 agent，逗号分隔。只是**初值** —— 后台改过之后以设置为准。跟「装没装 CLI」是两回事，见下 |
| `PERMISSION_MODE` | `bypassPermissions` | Claude Code，⚠️ 见下 |
| `CODEX_SANDBOX` | `workspace-write` | Codex 原生沙箱 |
| `SECRET_FILE_ROOTS` | `<DATA_DIR>/secrets:/run/secrets` | 允许「从文件读 key」的目录白名单，冒号分隔。app 和 gateway 要配同一份。写 `/` 等于不限制（想清楚再写，见「key 也可以放在文件里」）|
| `DEEPSEEK_API_KEY` | — | 只在**首次启动**（provider 表为空）时用来播一条 DeepSeek 上游并激活。之后一切以 provider 表为准，网关启不启用只看有没有 active 的那条 |
| `GATEWAY_PORT` | `8788` | |
| `ROLE` | `all` | `app` / `gateway` 只跑一半，compose 拆两个容器时用 |
| `HOST` | `127.0.0.1` | 跑在容器里必须改成 `0.0.0.0`，否则反代进不来 |
| `GATEWAY_URL` | 自动推导 | **agent** 访问网关的地址；compose 部署时设成 `http://gateway:8788` |
| `GATEWAY_INTERNAL_URL` | 自动推导 | **本进程**访问网关的地址（后台读闸门）；同上 |
| `MAX_UPSTREAM_CONCURRENCY` | `3` | 全局 in-flight 上限，后台可热调 |
| `PER_USER_INFLIGHT_MAX` | `2` | 单用户最多占几个 slot |
| `USE_CONTAINERS` | `false` | 开启每用户容器隔离 |
| `AGENT_NETWORK` | 空 | 容器网络名；Linux 上设成 internal 网络 |
| `CONTAINER_IDLE_MS` | `1800000` | 空闲多久停掉容器 |
| 配额锚点 | 后台设置 | `quota.anchorDayOfMonth` / `anchorDayOfWeek` / `anchorHour` |
| `SENDGRID_API_KEY` / `MAIL_FROM` | — | 同上 |
| `APP_BASE_URL` | `http://localhost:5173` | 邮件里的链接前缀 |

> ⚠️ **`bypassPermissions` 允许 agent 执行任意命令。** 这在容器里是安全的（容器就是沙箱），
> 但 `USE_CONTAINERS=false` 时 agent 直接跑在宿主机上，工作目录只是路径隔离而非安全隔离。
> **公网部署必须开容器隔离**，见下。

## 下一步

| 里程碑 | 内容 |
|---|---|
| M4 | 余额趋势与三口径对账、会话搜索、附件在对话内引用 |
| M5 | 多实例部署（并发闸门换成 Redis 信号量） |

计量为什么必须放在网关而不是读 CLI 的 transcript，见 [DESIGN.md §7.6](./DESIGN.md)（附 6928 条记录的实测数据）。

## 容器隔离怎么开

```bash
npm run build:agent-image          # 构建 agent 镜像（约 1.7GB，装 claude + codex）
npm run dev:containers             # = USE_CONTAINERS=true npm run dev
```

启动日志会打印探测结果，缺镜像或 podman 不可用会明说，不会静默降级：

```
容器隔离         ✓ podman 5.4.0 · 镜像 agentlodge/agent:1.0
```

第一轮对话时才会拉容器（`agentlodge-agent-<uid 前 12 位>`），之后常驻，
空闲 `CONTAINER_IDLE_MS` 后 stop 但不 rm —— 下次 start 只要 ~0.5s。

### 目录布局

一个用户一个目录，容器起停、重建都不影响里面的东西：

```
data/workspaces/<userId>/
├── .agent-home/          → 挂成容器里的 /home/agent
│   ├── .claude/          Claude 的 settings.json、会话记录
│   ├── .claude.json      Claude 的主配置（目录信任、历史）
│   └── .codex/           Codex 的 config.toml、rollouts
├── CLAUDE.md  AGENTS.md  MEMORY.md
└── <conversationId>/     一个会话一个子目录，agent 的产出落在这里
```

`/workspace` 挂的是用户目录本身，所以 agent 在 `/workspace/<会话 id>` 里干活，
跨会话共享同一份 MEMORY.md，但看不到别的用户任何东西。

两个决定值得说一下：

- **HOME 整个挂出来，而不是只挂 `.claude` / `.codex`。** Claude Code 的主配置是
  `~/.claude.json`，在 HOME 根上而不是 `~/.claude/` 里 —— 只挂子目录的话它会留在
  容器可写层，`podman rm` 一次目录信任和历史就归零。
- **`.agent-home` 放在用户目录里，但不放 `/workspace` 根上。** Claude Code 会把工作
  目录**及其祖先**的 `.claude/settings.json` 当项目级设置读，放根上就会和 HOME 里
  那份撞车，两套语义混用。

万一 CLI 侧的会话记录还是没了（CLI 大版本升级、手工清目录），服务端会丢掉
`agent_session_id` 自动重开一轮，并在回答前面挂一条说明 —— 否则那条会话会因为
每轮都拿一个不存在的 id 去 resume 而永久卡死。

**agent 容器是有外网的**，这是刻意的 —— 定位就是「一个跑在沙箱里的 Claude Code」，
要能 `npm install`、`git clone`、查资料。隔离靠容器本身，不靠断网：

| 靠什么挡住 | 怎么挡 |
|---|---|
| 花别人的钱 | 真实 API key 不进容器，里面只有绑定 `(user, conversation, turn)` 的 20 分钟票据 |
| 看别人的数据 | 只挂载该用户自己的目录，用户之间互不可见 |
| 搞坏宿主机 | 非 root（uid 10001）· CapDrop ALL · no-new-privileges · 内存/CPU/PID 限额 |
| 摸到内网 | `agent-net` 上只有网关，app 和 caddy 都不在这个网络里 |

也就是说，agent 对外网的权限 ≈ 任意一台外部机器，但对**你的钱和别人的数据**没有权限。

> ⚠️ **云主机上记得挡掉 `169.254.169.254`**（实例元数据端点），否则容器里的 agent
> 能读到云厂商下发的机器凭据。这是有外网这个选择唯一需要额外动手的地方。

要彻底断网的版本，把 `docker/compose.yml` 里 `agent-net` 的 `internal: true` 打开即可
（代价是 agent 装不了包）。注意 macOS 上这个模式**不可用**：podman 跑在虚拟机里，
internal 网络下容器连宿主机都够不着，而开发时网关就在宿主机上。

> macOS 另一个坑：podman machine 只挂载 `$HOME`，`DATA_DIR` 必须在 home 目录下，
> 否则卷挂载会报 `no such file or directory`。

**macOS 上容器怎么找到网关**：不用改 `GATEWAY_HOST`。podman machine 的 gvproxy 会把
`host.containers.internal`（`192.168.127.254`）转发到宿主机，**包括宿主机的 127.0.0.1**，
所以网关继续只监听回环就行，不用暴露到 `0.0.0.0`。

> ⚠️ 代价是这条路是**双向通的**：容器里的 agent 同样能访问宿主机上任何监听回环的服务
> （app 的 8787、你本地的数据库……）。开发机上可以接受，但这也是为什么**正式部署要走
> Linux + `agent-net`** —— 那边 app 根本不在 agent 的网络里，够不着。

## 抓包：trace-proxy/ 透明代理

`trace-proxy/` 是个零依赖的透明转发代理，落盘每一个请求的头/体、SSE 逐事件、重建结果和
usage。链路上任意一段都能塞进去，被抓的两端**察觉不到**（只改 `Host` 和
`accept-encoding`，响应字节原样回传）。

```bash
npm run trace       # 代理，127.0.0.1:8796，落盘到 trace-proxy/traces-chain/
npm run dev:trace   # 代理 + 服务端 + 前端，已经串好（见下面「位置 B」）
```

界面**挂在代理端口下**，不用单独起：<http://127.0.0.1:8796/__trace>
（`npm run trace:ui` 仍在，是独立跑 `server.js` 的旧路子，代理没跑时翻历史用；
另有 `trace:view` 命令行看、`trace:probe` 抓 TLS 指纹。）

> **`trace-proxy/` 是纯上游目录，可以整个替换。** 集成逻辑全在仓库根：npm scripts 负责
> 端口/落盘目录/`PROXY_RETRY=0`，`.gitignore` 负责挡住 traces。
>
> 唯一的例外是 `trace-proxy/package.json` —— proxy 是 CommonJS，而仓库根是
> `"type": "module"`，Node 按最近的 package.json 判定模块类型，缺了它会报
> `require is not defined in ES module scope`。这个文件由
> `scripts/ensure-trace-proxy-cjs.mjs` 在每次 `npm run trace` 前**自动补**，替换目录后
> 会重建，不用手工维护（已在 `.gitignore` 里）。

trace 自动清理，默认留 **1000 条 / 1 GB / 7 天**，超了删最旧的
（`TRACE_MAX_COUNT` / `TRACE_MAX_MB` / `TRACE_MAX_DAYS`）。

> `trace-proxy/README.md` 里建议的端口是 8799，那个留给你手工抓 CLI→官方 API。
> 链路内的这个用 **8796** + 独立的 `traces-chain/`，两种流量不混在一个 index 里。

### 两个可以插的位置

**位置 A —— 网关 ⇄ 上游**（看我们发出去的是什么）

后台把 provider 的 Base URL 指到代理，代理再转给真上游：

```bash
UPSTREAM_URL=<真上游> npm run trace
# 后台 → provider → Base URL 改成 http://127.0.0.1:8796
```

**位置 B —— 容器 CLI ⇄ 计量网关**（看 agent 到底发了什么）—— `npm run dev:trace` 就是这个

```
GATEWAY_URL=http://host.containers.internal:8796   # 告诉 agent 往代理发
UPSTREAM_URL=http://127.0.0.1:8788                 # 代理再转回计量网关
```

`GATEWAY_URL` 本来是给「网关在另一个容器」的部署形态用的，这里借它把 agent 引到代理上，
不用改代码。

### ⚠️ 链路内要关掉代理的「自作主张」

代理有三个默认或可选的主动行为，**放进我们链路里都会和计量网关打架**。
`npm run trace` 已经把它们钉死，这里说明为什么：

| 开关 | 我们钉成 | 为什么 |
|---|---|---|
| `PROXY_RETRY` | `0` | 见下 —— 会架空网关的 AIMD |
| `PROXY_MAX_CONCURRENT` | `0` | 两级队列串联会导致槽位对不上账 |
| `PROXY_TRACE_SKIP` | `HEAD /api/hello` | Claude Code 的连通性探测，纯噪音 |

**并发那条**：代理自己排队、超时返 429。而网关排队最多 120s —— 请求卡在代理队列里时，
网关的计时器照常跑，到点判超时、以为 slot 空了放下一个进来，实际代理那边还堵着。
而且网关的闸门有代理没有的东西：**单用户上限、用户级公平队列、AIMD**，因为代理认不出用户。

> 代理默认就是 `0`（作者自己也写了「为什么默认关闭」），我们显式钉死是防默认值哪天变了。
> 你手工抓 CLI→官方 API 时不受影响，那边该开开。

**`PROXY_DEVICE_ID` 我们不用。** 它是给「每次 docker run 换新 HOME、device_id 就变」
那个场景准备的；我们的容器 HOME 持久化在 `.agent-home`，每个用户的 device_id 天然稳定 ——
而且多租户下每个用户本来就该是不同 device，统一改写反而是错的。

### ⚠️ 重试为什么必须关（`PROXY_RETRY=0`）

代理自带重试（默认 2 次，读上游的 `x-should-retry`，退避 500ms→30s）。这对**手工抓
CLI→官方 API** 是好功能，但**放进我们链路里会破坏计量网关的背压**：

```
gate.reportUpstream(status):
  429 / 503 / 529  →  effectiveMax 砍半 + 进入冷却
  <400 连续 20 次  →  effectiveMax +1
```

代理若把 429 悄悄重试成功，网关只看到最后那个 200 —— **不但不会降并发，还会往「连续
成功」里记一笔，反过来抬高并发**。上游正在限流，我们却在加压。

所以 `npm run trace` 已经写死 `PROXY_RETRY=${PROXY_RETRY:-0}`。链路里代理的定位是
**观察者**，重试决策归网关（§7.4 的 AIMD 闸门）。

> 同理，位置 B 也不该重试：网关返回的 429/402 是给 agent 的背压信号，替它吞掉
> 只会让配额和并发限制失去意义。

### 传输层：默认 HTTP/1.1，压缩透传

代理不改写 `Accept-Encoding` —— 压缩字节原样透传给客户端，只在落盘时解压
（gzip/deflate/br/zstd）。每个请求多落一个 `forwarded.headers.json`（实际发给上游的
header + `protocol` 字段），`request.json` 里多一份 `raw_headers`（客户端原始大小写与
顺序），两边一对就知道代理改了什么。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_HTTP2` | `0` | 默认 h1，与 Claude Code 直连一致；`1` 改用 h2 |
| `PROXY_IDENTITY` | `0` | `1` = 要求上游别压缩（省解压，但流量不保真） |

> `ja3-probe.js` 实测 Claude Code 的 ClientHello，得到两条结论，代理的默认值就是据此定的：
> **① 它直连走的是 HTTP/1.1**（ALPN 只报 `["http/1.1"]`），所以代理默认也用 h1。
> **② 它的 TLS 栈是 BoringSSL（Bun 编译的单文件），不是 Node 的 OpenSSL**，
> cipher 数 17 vs 52、扩展顺序不同，**JA3 无法通过配置对齐**。代理把能对齐的对齐了
> （显式声明 ALPN，Node 默认根本不发这个扩展）。

**这一层对本项目没有影响。** 链路里代理只出现在本机明文 HTTP 段（上游是 `http://` 的
网关或你的 proxy），既不协商 h2 也不过 TLS —— 实测 `upstream_http_version=HTTP/1.1`。
指纹那部分能力是给你手工抓 CLI→官方 API 用的（`npm run trace:probe`）。

### 实测抓到的东西

一轮带工具调用的对话（假上游回 `tool_use`），位置 B 抓到两个请求，正好是 agent 循环的两半：

```
#10  200 /v1/messages  http=HTTP/1.1  stop=tool_use   in=3020  out=22
#11  200 /v1/messages  http=HTTP/1.1  stop=end_turn   in=3032  out=18
```

展开 #4 的请求体，能看到工具**下发**和**回报**的完整往返：

```
→ tool_use    Write {"file_path":"mock-tool-probe.txt","content":"WRITTEN-BY-AGENT\n"}
← tool_result "File created successfully at: mock-tool-probe.txt"
```

而文件落在 `data/workspaces/<用户>/<会话>/mock-tool-probe.txt` —— **工具在容器里执行**，
代理只是看着，没碰任何字节。

> `trace-proxy/traces*/` 里是完整 prompt 和响应明文（密钥已脱敏），已在 `.gitignore` 里，别提交。

## ⚠️ 上游必须是「模型」，不能是「agent」

这条是实测出来的，值得单独记一笔 —— 因为两种上游在配置上长得一模一样，
都是往 provider 里填一个 Base URL，但结果差一个隔离边界。

| 上游类型 | 返回什么 | 工具在哪执行 |
|---|---|---|
| **模型端点**（DeepSeek / Ollama / 你的 claude proxy） | `tool_calls` | ✅ **容器里** |
| **另一个 agent**（把某个 CLI 封成 API 的服务） | 只有最终文本 | ❌ **那个 agent 所在的机器** |

拿一个把 codex CLI 封成 OpenAI 接口的服务当上游，实测结果：

```
让容器里的 agent「创建 probe.txt」，它回了 done，但

data/workspaces/<用户>/<会话>/probe.txt      ← 不存在
<那个服务>/workspaces/th_xxx/probe.txt       ← 在这儿，跑在宿主机上
界面「工作区文件」                            ← 空
```

容器里那个 agent 这一轮**一个工具都没调**（消息 block 里只有 text，没有 tool_use）。
因为 agent 上游自己就把 `tool_calls` 消费掉了，就地执行完只吐最终文本。

**规律**：谁消费 `tool_calls`，工具就在谁那儿执行；谁发起模型调用，凭据就得在谁那儿。
所以把 agent 塞在容器里的 agent 后面，会同时丢掉容器隔离和用户对自己产出的可见性。

对照实验见「零成本测试」那节的 `MOCK_TOOL` —— 假上游回真 `tool_use` 时，
文件就落在 `data/workspaces/<用户>/<会话>/` 里，界面上看得到。

## 部署

### 从镜像部署（推荐）

镜像由 GitHub Actions 构建后发到 Docker Hub，按组件拆开：

| 镜像 | 内容 |
|---|---|
| `agentlodge-server` | 主服务与计量网关，同一个镜像靠 `ROLE` 决定跑哪一半 |
| `agentlodge-web` | 前端产物 + Caddy |
| `agentlodge-agent` | 每用户 agent 容器，装了 claude 与 codex |
| `agentlodge-audit-proxy` | 审计代理（trace-proxy） |
| `agentlodge-authkey-sync` | 凭据同步 sidecar，可选 |

标签规则：

| 触发 | 产出的标签 |
|---|---|
| 推 master | `master` |
| 打 `v1.2.3` | `1.2.3`、`latest` |

**标签里不带 commit id。** 一个 commit 一个标签会无限堆积，没人按 SHA 部署，最后仓库里
一千个标签谁也分不清。分支名说明它是什么，具体是哪个 commit 构建的，镜像的 `revision`
label 里有。

**`latest` 跟的是最新的发布 tag，不是 master。** 它是人们不假思索就会拉的那个标签，
所以它得表示「最近一次发的版本」，而不是「今天下午合进 master 的东西」。想跑滚动构建就
显式用 `master`。

也没有 `1.2` 这种浮动的次版本标签：它回答不了「`latest` + 精确版本号」之外的任何问题，
却长得像钉死的版本而实际会移动 —— 和 `latest` 是同一类事故，只是少了那块警示牌。
0.x 上尤其如此，semver 里 0.x 的 minor 号本来就允许破坏兼容。

**agent 镜像的 label 里写着实际装的版本**，构建时会核对 npm 真的装了那个版本，
对不上就直接构建失败 —— label 说的和里面装的不一致，比没有 label 更糟：

```bash
docker inspect docker.io/wrfly/agentlodge-agent:latest \
  --format '{{index .Config.Labels "dev.agentlodge.claude-code.version"}}'
```

部署本身不需要 clone 仓库，两个文件就够：

```bash
curl -fsSLO https://raw.githubusercontent.com/wrfly/AgentLodge/master/docker/compose.release.yml
curl -fsSL  https://raw.githubusercontent.com/wrfly/AgentLodge/master/docker/env.release.example -o .env
$EDITOR .env
sudo install -d -o 10001 -g 10001 "$DATA_DIR"     # 目录得归 uid 10001，见下面的 compose 说明
docker compose -f compose.release.yml up -d
docker pull docker.io/wrfly/agentlodge-agent:latest   # ← 不能省，见下
```

**agent 镜像必须单独 pull。** 它不是 compose 起的服务，是 app 通过挂进来的 socket 用
`docker run` 现拉起来的，所以 compose 不会替你拉。没拉的话后台「容器隔离」那栏会说
镜像缺失，并把该敲的命令打出来。

`compose.release.yml` 是**自包含**的，不需要叠加别的文件，写的是 Docker（rootless podman
把 app / gateway 的 `user:` 和 `group_add:` 去掉即可）。凭据同步 sidecar 走 profile，
默认不起：

```bash
docker compose -f compose.release.yml --profile authkey up -d
```

**fork 友好**：流水线用的 namespace 是 `github.repository_owner`，不是写死的 `wrfly`。
fork 之后什么都不用改，镜像会发到你自己的账号下 —— 在仓库 Settings → Secrets 里配好
`DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN` 即可（**用访问令牌，不要用账号密码**：
令牌可以单独吊销，能限定权限，泄漏了也不等于把账号交出去）。没配 secret 的 fork 照样会
构建镜像，只是不推送 —— 这样 Dockerfile 写坏了是在 PR 上红，而不是在别人半年后的发布上红。

发布前会先跑 `npm run typecheck`、`npm test`、`npm run build`，全过了才构建镜像。
发一个没人验过的镜像比不发更糟，因为它看起来像个发布。

### 先把 JWT_SECRET 定下来

**这是部署里唯一必须提前想清楚的东西。** 它签三样：登录态（access token）、
agent 的计费凭据（网关 runtime token），以及派生出加密系统设置的 AES 密钥。

```bash
openssl rand -base64 32          # 生成一次，存进密码管理器，别进 git
```

| | |
|---|---|
| **不设置** | 每次重启随机生成 → 后台填的 DeepSeek / SendGrid key **永久解不开**，得重填 |
| **换掉** | 同上。密文用的是旧密钥派生的 AES key，换了就是一堆解不开的字节 |
| **泄漏** | 对方可以伪造 `role: admin` 的登录态，也可以伪造 runtime token 拿你的 key 白嫖上游 |

两点澄清：

- **换它不会把人登出。** refresh token 是库里的随机串，不是 JWT，重启后会自动续上
- **它跟密码无关。** 口令是 scrypt，salt 编在哈希串里，自包含

### compose（Linux）

```bash
export JWT_SECRET=$(openssl rand -base64 32)     # ← 存好，下次 up 要用同一个
export SITE_ADDRESS=chat.example.com             # 有域名 Caddy 会自动签证书；留空则 localhost
export APP_BASE_URL=https://chat.example.com     # 邮件里的链接前缀

npm run build:agent-image                        # agent 镜像，约 1.7GB
podman compose -f docker/compose.yml up -d --build
```

容器：

```
caddy   ── 443/80，前端静态资源烤在镜像里，/api 反代给 app，/v1/* 反代给 gateway
app     ── ROLE=app，主服务 8787。挂 podman.sock，负责给每个用户拉 agent 容器
gateway ── ROLE=gateway，计量网关 8788。同时接 agent-net、frontend 和 backend
audit   ── 审计代理 8796，出网流量必经，只接 backend
agent   ── 每用户一个，只在 agent-net 上
```

（另有可选的 `authkey-sync`，不接任何网络。）

**agent-net 是有外网出口的，这是刻意的。** 定位是「一个跑在沙箱里的 Claude Code」，
要能 npm install、git clone、查资料 —— 隔离靠容器本身，不靠断网。它够不到的是
app 和内网：那两个不在这张网上，所以 agent 的可达范围跟任意一台外部机器一样。
想要彻底断网，给 `agent-net` 加 `internal: true`，代价是 agent 从此装不了包。

> ⚠️ 云主机上记得在宿主机防火墙挡掉 `169.254.169.254`（实例元数据），
> 否则容器里的 agent 能读到云厂商下发的机器凭据。

`app` 和 `gateway` 是**同一个镜像**，靠 `ROLE` 决定跑哪一半。拆开的唯一目的是让网关
单独接进 internal 网络 —— agent 容器除了网关哪儿都去不了，而真实 key 只在网关进程内。
两个容器共享同一个 SQLite 文件（WAL 模式，`busy_timeout=5000`）。

拆容器时**两个网关地址要分别配**，它们指向不同的东西：

| 变量 | 谁用 | 拆容器时填 |
|---|---|---|
| `GATEWAY_URL` | 容器里的 **agent** | `http://gateway:8788` |
| `GATEWAY_INTERNAL_URL` | **app 进程**（后台读闸门状态） | `http://gateway:8788` |

单机开发两个都不用填。之所以分开：`GATEWAY_URL` 可能是 `host.containers.internal`
或被指到 trace 代理，那些地址宿主机自己连不通。

### 起来之后

1. 看 `podman compose -f docker/compose.yml logs app`，里面打印了 **bootstrap 管理员邀请码**
2. 用它注册第一个账号（自动是 admin）
3. 进 `/admin` → 系统设置 → **上游 provider**，给要用的那条填 Base URL 和 API Key 再激活 ——
   有一条 active 的 provider 才会启用计量网关
4. 同一页把 **价格表**核对一遍（默认值是我填的占位数，按官网单价改）
5. 需要邮件邀请就填 SendGrid，页面上有「发测试邮件」按钮

### 哪些我验过、哪些没验

| | |
|---|---|
| ✅ 已验证 | `npm run build` 两端产物齐全；`ROLE=app` / `ROLE=gateway` 双进程共享一个库，WAL 生效，读写正常；换 JWT_SECRET 后登录/续期正常 |
| ✅ 已验证 | **容器模式全链路**（macOS + podman 5.4）：两个用户各自起容器、各自只挂到自己的目录、互相看不见；claude 和 codex 都能从容器里穿过网关拿到回答并被计量；容器内无任何凭据、无 key 环境变量；landlock ABI 5 在 CapDrop ALL 下仍可用（codex 的 `workspace-write` 沙箱能初始化） |
| ✅ 已验证 | **镜像构建与整套 docker compose 起停**（Linux + docker）。`podman-remote` 那个包 Debian 里根本没有，改成装 podman 本体再按 `podman-remote` 的名字调用（podman 认 argv[0]），server.Dockerfile 里记了原委 |

`app` 也可以从 compose 里摘出来直接跑在宿主机上（`ROLE=app node apps/server/dist/index.js`），
它本来就要用宿主机的容器引擎；`gateway` / `caddy` / `agent` 保持在容器里，安全模型不变。

## 已知限制

- Codex **没有 token 级增量**，回答整段出现（CLI 侧没有对等能力）
- 并发闸门是**单进程内存实现**，多实例部署需要换成 Redis 信号量（DESIGN.md §7.4 有方案）
- 网关和主服务同进程（不同端口）。代码分在 `src/gateway/` 与 `src/app/`，有分层检查兜底，
  拆容器直接靠 `ROLE` 切
- **拆进程后网关推的事件到不了浏览器**：`events.ts` 是进程内总线，SSE 连接都在 app 进程上。
  受影响的是 `queue.waiting`（排队第几位）和 turn 内的 `quota.updated`
  —— turn 结束时 app 侧还会统一推一次，所以只是少了实时性。真修法是把总线换成
  跨进程实现（同 M5 Redis 那件事）
- 长会话没有虚拟滚动
- 标题用首条消息截断，不是 AI 生成
- `protocol.ts` 在 server 和 web 各有一份副本，改动要同步两处 —— `npm run typecheck` 会逐字比对这两份，漂了就报错
