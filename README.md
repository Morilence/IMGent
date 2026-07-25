# IMGent

IMGent 是一个自托管的单进程桥接器：通过 QQ 官方机器人或微信
iLink 接收消息，在严格的身份、审批、会话与记忆边界内驱动本地 Codex 或
Claude Code。

`imgent` 是统一的 CLI 入口：配置、诊断和维护命令是短生命周期进程，
`imgent start` 则前台启动常驻服务。进程边界、在线/离线命令和本地控制面见
[CLI 与常驻服务架构](docs/cli-service-architecture.md)，已交付范围见
[实现状态](docs/implementation-status.md)。

## 要求

- Node.js 24.18.0 或更高版本
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
src/
  cli/ service/ control/ health/ config/ runtime/
  queue/ storage/
  identity/ approvals/ memory/ skills/ security/ backup/
```

这些包最终仍组成一个进程、一个 SQLite 数据库和一个数据目录；不存在运行时
插件市场或动态第三方适配器加载。

仓库使用 pnpm workspace 管理依赖，使用 TypeScript project references 和
`tsc -b` 做类型检查与测试编译。发布时由 esbuild 把内部 `@imgent/*` workspace
包合并到 `dist/src/cli/main.js`，第三方运行时依赖仍由 npm 安装。CLI 与 Service
共享这一个可执行入口，不是两套构建产物。

## 安装

推荐把长期运行的 CLI 安装到全局：

```bash
npm install --global imgent
imgent --version
```

临时查看帮助或试用时也可以不安装：

```bash
npx imgent --help
```

## 开始

```bash
imgent init --workspace /absolute/path/to/workspace
imgent profile add main \
  --driver codex \
  --workspace /absolute/path/to/workspace

imgent skills init project-conventions \
  --description "Apply this project's local conventions"
imgent skills validate
```

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

配置和授权命令要求服务处于停止状态。先做离线检查，再以前台方式启动服务：

```bash
imgent doctor
imgent start
```

首次私聊会返回一次性配对码。保持服务运行，在另一个终端由部署者确认：

```bash
imgent pair <code>
```

`pair` 是在线命令，只通过运行中服务的本地控制面执行。确认后用户才能运行
Agent。

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
- 健康服务只允许配置 loopback 地址，默认监听 `127.0.0.1:8787`，提供
  `/healthz` 和 `/readyz`，不承载管理操作。
- 本机管理使用 HTTP/JSON over Unix socket 或 Windows Named Pipe；endpoint
  由规范化 `dataDir` 和操作系统用户生成，不开放管理 TCP 端口。
- `init`、Profile/Bot/skill 修改、微信授权和 `restore` 是 offline 命令，检测到
  活动实例时会拒绝；执行期间会短暂持有 ownership lease，阻止服务并发启动。
  `pair` 和 `group authorize` 是 online 命令。
- `status`、`doctor`、列表/校验和 `backup` 是 dual 命令，输出明确包含
  `mode: "online" | "offline"`；endpoint 异常时不会回退为直接访问 SQLite。
- 配置、数据库、备份、凭据与密钥按本地敏感数据处理。
- 内置 skills 位于仓库 `skills/`；本机自定义与同名覆盖位于
  `dataDir/skills/`，修改后重启生效。
- `AgentProfile.skills` 默认 `["*"]`，同一 skill 可用于 Codex 或 Claude
  Code；IMGent 不依赖厂商原生技能。
- 备份包含本地平台凭据、加密密钥与用户 skills，但不包含 Codex/Claude 的
  外部登录目录。运行中备份由服务使用现有 SQLite owner 创建，停服时走离线路径；
  `restore --force` 也不能绕过停服检查。
- 微信只支持 direct；任何带 `group_id` 的事件都会进入兼容性死信。
- QQ 群默认 `triggered`；`full` 只能由已配对且平台可验证的群主/管理员开启。

常用运维命令：

```bash
imgent status
imgent --locale en-US doctor
imgent --json status
imgent backup --output ./state.backup
imgent restore ./state.backup \
  --config ./restored.json \
  --data-dir ./restored-data
```

聊天内控制命令：

```text
/imgent cancel
/imgent bind [绑定码]
/imgent unbind
/imgent allow <requestId>
/imgent deny <requestId>
/imgent answer <requestId> <内容>
/imgent group full
/imgent group triggered
/imgent language zh-CN
/imgent language en-US
```

错误由稳定 `ErrorCode` 驱动。CLI 默认显示本地化的安全原因和恢复动作；
`--json` 返回稳定 envelope，不包含 cause、stack、本机路径或原始平台响应。
CLI locale 顺序为 `--locale`、系统 locale、配置默认值、`zh-CN`；IM 使用
Principal、BotInstance、全局默认值、`zh-CN` 的顺序。

## 开发与验证

从源码开发时需要 pnpm 11.16.0：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm link --global

pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm verify:package
```

安装依赖后 Husky 会启用本地 Git hooks：提交前只检查并格式化暂存文件，
提交信息按 Conventional Commits 校验，例如 `feat(codex): support host tools`。

测试覆盖配置、SQLite 事务与恢复、FIFO、身份绑定、审批、技能覆盖与只读物化、
五类记忆隔离、中文 FTS5、Curator 幂等、备份恢复、IM payload 规范化以及两个
驱动的协议合约。Codex 另有真实本机 app-server smoke；`doctor` 会对 Claude
Code 执行真实认证/协议探测，自动化测试仍使用 mock/contract 验证。

完整产品与安全约束见
[产品设计](docs/imgent-product-design.md)；技能格式与自定义流程见
[IMGent 托管技能](docs/imgent-skills.md)。

Docker 镜像不内置也不代管 Codex/Claude 的登录凭据；容器部署者需要在自己的
派生镜像中安装对应 CLI，或把受控的可执行文件与认证目录按最小权限挂载进容器。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。

## 发布

发布由 [Publish workflow](.github/workflows/publish.yml) 完成。先在 `main` 更新
`package.json` 版本并通过测试，再创建并推送同版本 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

workflow 会再次运行测试、构建 tarball、在临时目录全局安装并验证 CLI/内置
skills，最后把同一个 tarball 发布到 npm。首次发布需要仓库 secret
`NPM_TOKEN`；首次发布后可在 npm 包设置中把 `Morilence/IMGent` 的
`publish.yml` 配置为 Trusted Publisher，再移除长期写 token。
