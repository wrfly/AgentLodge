# AgentLodge

**[中文](./README.md) · [English](./README.en.md)**

把 Claude Code 和 Codex 包装成多租户的 Web 服务。每个用户有自己的沙箱 agent；
你只管一把上游 key，一把都不用发出去。

- **真实 API key 只存在于网关进程里。** agent 手上是绑定
  `(user, conversation, turn)` 的 20 分钟票据，计量绕不过去，容器被拿下也偷不到东西。
- **配额在一个 turn 内部就能刹住**，不只是门口拦一下 —— agent 循环跑飞了是当场停，
  不是事后记账。
- **每一条出网请求都可以留证**，经审计代理落盘，完整 prompt，留多久按你的合规要求。
- **agent 跑在容器里**，一人一个，各自独立的工作区。

## 功能

**账号**
- [x] 邀请码注册、邮件定向邀请（SendGrid）
- [x] access token + refresh token 轮转，**重放即判定泄漏**并撤销该用户全部会话
- [x] 改密码、忘记密码、多设备管理、停用即时踢线
- [x] 登录失败按 IP + 邮箱双维度锁定

**计量与配额**
- [x] agent 的上游请求强制经网关，逐次调用从 SSE 流里旁路解析 usage
- [x] 配额闸门在 turn 内部生效；日 / 周 / 月 / 总量周期，重置时刻精确到小时
- [x] 全局并发闸门（默认 ≤3 in-flight），用户级轮转 + AIMD 自适应，后台热调
- [x] 按 token 或按金额计费，价格表可改且历史账单锁定当时价格
- [x] **每个用户看到的是自己的额度**，不是共享订阅的池子——响应头按其配额重写
- [x] **管理员单独看得到上游套餐的真实利用率**与重置时刻

**隔离**
- [x] 每用户一个常驻容器，非 root、CapDrop ALL、内存 / CPU / PID 限额
- [x] 只挂载自己的工作目录，容器内无任何凭据
- [x] 工作区文件读写经真实路径校验，符号链接逃逸有测试覆盖

**接入**
- [x] 网页对话（高仿 Claude 界面）、记忆、附件、Markdown + 代码高亮
- [x] 自带 CLI 接入：一条命令装好，之后照常敲 `claude`
- [x] 同时支持 Anthropic Messages 与 OpenAI Responses 两套协议
- [x] 上游 provider 可增删改切，含内置假 provider（零成本试）

**运维**
- [x] 出网审计代理，完整 prompt 落盘，后台可开关、可清空
- [x] 后台改配置无需重启：额度、价格、并发、provider、站点信息
- [x] 界面与 API 错误文案支持中 / 英 / 日 / 俄
- [x] 镜像按组件拆开发布，`docker compose` 两个文件拉起

**还没做**
- [ ] 余额趋势与三口径对账、会话搜索、附件在对话内引用（M4）
- [ ] 多实例部署（并发闸门换成 Redis 信号量）（M5）

## 跑起来

```bash
npm install
JWT_SECRET=$(openssl rand -base64 32) npm run dev
```

打开 http://localhost:5173 控制台会打印一个 bootstrap 邀请码，用它注册的第一个账号
自动是管理员。

本机需要装 `claude` 和/或 `codex`。缺哪个，哪个页面会说明原因，不影响另一个。

只对外提供其中一个也是支持的 —— 管理员在**系统设置 → Agent**里把另一个关掉，
它会从界面上彻底消失，而不是杵在那儿看着像坏了。

想零成本试，把上游指到内置的假 provider —— 见手册。

## 从镜像部署

不用 clone，两个文件就够：

```bash
curl -fsSLO https://raw.githubusercontent.com/wrfly/AgentLodge/master/docker/compose.release.yml
curl -fsSL  https://raw.githubusercontent.com/wrfly/AgentLodge/master/docker/env.release.example -o .env
$EDITOR .env                  # 至少填 JWT_SECRET、AUDIT_ADMIN_TOKEN、DATA_DIR
docker compose -f compose.release.yml up -d
docker pull docker.io/wrfly/agentlodge-agent:latest
```

镜像按组件拆开发布在 Docker Hub 上。`:latest` 是最新的发布版本，`:master` 是分支的滚动构建。
fork 之后流水线自动改用你自己的账号名，不用改任何东西。
agent 镜像的标签里写着里面装的是哪个版本的 claude 和 codex。

## 接着看哪儿

| | |
|---|---|
| [MANUAL.md](./MANUAL.md) | 怎么跑、上游怎么配、审计代理、部署、环境变量 |
| [DESIGN.md](./DESIGN.md) | 为什么这么设计 |
