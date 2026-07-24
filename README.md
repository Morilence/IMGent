# IMGent

IMGent 是一个自托管的单进程桥接器：通过 QQ 官方机器人或微信
iLink 接收消息，在严格的身份、审批、会话与记忆边界内驱动本地 Codex 或
Claude Code。

## 要求

- Node.js 24.18.0 或更高版本
- pnpm 11.16.0（仓库通过 `packageManager` 固定版本）
- 已安装并登录的 `codex`；使用 Claude Code 时还需安装并登录 `claude`
- QQ 官方机器人凭据，或可完成微信 iLink QR 授权的微信账号

## Monorepo

```text
packages/
  contracts/
  im-adapters/
    qq/
    wechat-ilink/
  agent-drivers/
    codex/
    claude-code/
skills/
  imgent-conversation/
  imgent-memory/
  imgent-memory-curation/
src/
  cli/ config/ runtime/ queue/ storage/
  identity/ approvals/ memory/ skills/ security/ backup/
```

这些包最终仍组成一个进程、一个 SQLite 数据库和一个数据目录；不存在运行时
插件市场或动态第三方适配器加载。

## 开始

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm link --global

imgent init --workspace /absolute/path/to/workspace
imgent profile add main \
  --driver codex \
  --workspace /absolute/path/to/workspace

imgent skills init project-conventions \
  --description "Apply this project's local conventions"
imgent skills validate
```

不希望创建全局链接时，可把下文的 `imgent` 替换为
`pnpm imgent`。

添加 QQ 时，从环境变量读取 AppSecret 并立即加密落盘：

```bash
export IMGENT_QQ_APP_SECRET='...'
imgent bot add qq qq-main \
  --profile main \
  --app-id-env IMGENT_QQ_APP_ID
unset IMGENT_QQ_APP_SECRET
```

添加和授权微信：

```bash
imgent bot add wechat-ilink wechat-main --profile main
imgent bot authorize wechat-main
```

首次私聊会返回一次性配对码。部署者在本机确认后，用户才能运行 Agent：

```bash
imgent pair <code>
imgent doctor
imgent start
```

QQ 群需要先出现一次触发消息，随后由部署者查看本地群空间并授权：

```bash
imgent identity list
imgent group list
imgent group authorize <conversation-space-id> \
  --principal <paired-principal-id>
```

## 运行与安全

- 配置默认是当前目录的 `imgent.json`，可用全局
  `--config <path>` 指定。
- 管理服务默认监听 `127.0.0.1:8787`，提供 `/healthz` 和 `/readyz`。
- 配置、数据库、备份、凭据与密钥按本地敏感数据处理。
- 内置 skills 位于仓库 `skills/`；本机自定义与同名覆盖位于
  `dataDir/skills/`，修改后重启生效。
- `AgentProfile.skills` 默认 `["*"]`，同一 skill 可用于 Codex 或 Claude
  Code；IMGent 不依赖厂商原生技能。
- 备份包含本地平台凭据、加密密钥与用户 skills，但不包含 Codex/Claude 的
  外部登录目录。
- 微信只支持 direct；任何带 `group_id` 的事件都会进入兼容性死信。
- QQ 群默认 `triggered`；`full` 只能由已配对且平台可验证的群主/管理员开启。

常用运维命令：

```bash
imgent status
imgent backup --output ./state.backup
imgent restore ./state.backup \
  --config ./restored.json \
  --data-dir ./restored-data
```

聊天内控制命令：

```text
/imgent cancel
/imgent bind [绑定码]
/imgent allow <requestId>
/imgent deny <requestId>
/imgent answer <requestId> <内容>
/imgent group full
/imgent group triggered
```

## 开发与验证

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

安装依赖后 Husky 会启用本地 Git hooks：提交前只检查并格式化暂存文件，
提交信息按 Conventional Commits 校验，例如 `feat(codex): support host tools`。

测试覆盖配置、SQLite 事务与恢复、FIFO、身份绑定、审批、技能覆盖与只读物化、
五类记忆隔离、中文 FTS5、Curator 幂等、备份恢复、IM payload 规范化以及两个
驱动的协议合约。Codex 另有真实本机 app-server smoke；Claude Code 按当前
交付约定只执行 mock/contract 验证。

完整产品与安全约束见
[产品设计](docs/imgent-product-design.md)；技能格式与自定义流程见
[IMGent 托管技能](docs/imgent-skills.md)。

Docker 镜像不内置也不代管 Codex/Claude 的登录凭据；容器部署者需要在自己的
派生镜像中安装对应 CLI，或把受控的可执行文件与认证目录按最小权限挂载进容器。
