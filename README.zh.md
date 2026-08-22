# AgentLodge

**[火星文](./README.md) · [English](./README.en.md) · [中文](./README.zh.md)**

把 Claude Code 和 Codex 包装成多租户的 Web 服务。每个用户有自己的沙箱 agent；
你只管一把上游 key，一把都不用发出去。

- **真实 API key 只存在于网关进程里。** agent 手上是绑定
  `(user, conversation, turn)` 的 20 分钟票据，计量绕不过去，容器被拿下也偷不到东西。
- **配额在一个 turn 内部就能刹住**，不只是门口拦一下 —— agent 循环跑飞了是当场停，
  不是事后记账。
- **每一条出网请求都可以留证**，经审计代理落盘，完整 prompt，留多久按你的合规要求。
- **agent 跑在容器里**，一人一个，各自独立的工作区。

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
