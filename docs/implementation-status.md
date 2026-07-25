# IMGent v1 implementation status

本仓库按 `imgent-product-design.md` 的 v1 边界实现，并采用后续确认的
pnpm monorepo 结构：

- 根包：单进程运行时、SQLite、身份、审批、记忆、队列、CLI、健康端点与备份。
- `packages/im-adapters/qq`：QQ 官方 Gateway、Resume、消息规范化和回复限制。
- `packages/im-adapters/wechat-ilink`：QR 授权、长轮询、cursor、媒体与
  `context_token`。
- `packages/agent-drivers/codex`：Codex app-server stdio JSON-RPC。
- `packages/agent-drivers/claude-code`：Claude Agent SDK。
- `packages/contracts`：跨包类型、集中错误码、错误 descriptor 和协议。
- 根 `skills/` 与 `src/skills/`：IMGent 托管的内置技能包、两层注册表、启动
  快照和 per-turn 只读物化。

构建使用 pnpm workspace、TypeScript project references 和 `tsc -b` 做类型检查
与测试编译；npm 发布时由 esbuild 合并内部 workspace 包，第三方运行时依赖保持
external。CLI 与常驻服务共享 `dist/src/cli/main.js` 入口，进程形态由子命令
决定而不是由不同构建产物决定。

不包含飞书、Telegram、动态插件市场、云端记忆或向量数据库。

当前 schema version 为 3。task、outbound、memory outbox 和 dead letter
保存结构化错误 descriptor，不保存本地化文本；task 支持 retry_wait，Principal
支持 locale。v2 数据在独立备份后通过事务内表重建升级，历史错误映射为
`LEGACY_RECORDED_ERROR`。

错误系统使用 `DOMAIN_SUBJECT_REASON` 稳定错误码、单一 `IMGentError` 和
`normalizeError()`。中文/英文 ICU 目录覆盖错误、恢复动作、doctor/status 和
language 命令；CLI 支持 `--locale`、`--json` 与固定退出码，IM 支持未配对用户
执行 `/imgent language zh-CN|en-US`。

记忆记录包含来源 task 和 `explicit` / `curated` 标记；召回只使用生成
`search_text` 的 SQLite FTS5，中文连续文本在写入和查询时生成 bigram，不存在
正则显式记忆识别或汉字 `LIKE` 旁路。

## CLI 与常驻服务边界

[CLI 与常驻服务架构](cli-service-architecture.md) 的 v0.3 决策已经实现：

- 仍只有一个 `imgent` 可执行入口；`imgent start` 是响应 SIGINT/SIGTERM 的前台
  常驻服务，其他命令是短生命周期 CLI。
- `src/service` 负责 composition、生命周期、readiness 和管理 application
  service；`src/control` 与 `src/health` 分别承载本地管理面和 loopback 健康面。
- Linux/macOS 使用权限为 `0600` 的 Unix socket；Windows 走用户范围 Named
  Pipe，名称优先由当前账户 SID 派生。稳定 instance key 来自规范化 `dataDir`
  与操作系统用户。Windows 的实际 Pipe ACL 仍是对应平台发布 smoke 门禁，Linux
  CI 不替代该验证。
- Control Server 绑定是单实例锁；只清理当前用户拥有且确认无监听者的 stale
  socket。`dataDir/run/instance.json` 以 `0600` 保存诊断元数据。
- offline/dual 命令确认服务停止后，会在同一 endpoint 上持有短生命周期 ownership
  lease，关闭“探测 stopped”与“打开本地数据”之间的启动竞争窗口。
- 本地协议为 HTTP/1.1 + JSON `/v1`，包含版本、instance ID、生命周期状态和不含
  secret 的 canonical config hash。协议不兼容、实例不匹配和 endpoint 失联均有
  独立 ErrorCode，不会静默回退。
- `status`、`doctor`、identity/group/skill 列表与校验、在线备份在服务运行时只走
  Control Client；停服时 dual 命令使用受限离线 application service，并明确返回
  `mode`。offline doctor 只做存储、skill、Agent 命令/登录协议和凭据齐备性探测，
  不启动 Adapter，也不伪装实时状态。
- `pair` 和 `group authorize` 是 online mutation；配置、Bot/Profile/skill
  修改、微信授权与 `restore` 是 offline mutation，活动实例存在时明确拒绝。
- 在线备份复用服务持有的 SQLite connection，并先写入 `dataDir` 下受控临时文件；
  Control API 只返回 opaque artifact 名称，CLI 校验受控目录、owner/mode 后原子
  交付。`restore --force` 不能绕过活动实例检查。
- 服务启动只因配置、单实例、控制/健康监听、凭据主密钥、SQLite/迁移/FTS5 等本地
  核心错误退出。平台凭据、连接或 Agent readiness 失败进入 `degraded`，控制面和
  health 仍可诊断。
- TCP 配置仅接受 `127.0.0.1`、`::1` 或 `localhost`，且只注册 `/healthz` 与
  `/readyz`，没有管理 mutation。

因此服务运行时是 SQLite、credential store 和运行快照的唯一在线所有者。配置和
用户 skills 仍采用启动快照；v1 不实现通用热重载或 `imgent start --daemon`。

## 验证

标准验证命令：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm verify:package
pnpm verify:codex
```

当前实现的自动化测试覆盖：

- 配置拒绝未知字段、未知适配器和未知驱动。
- SQLite 原子入站、dedupe、checkpoint、每会话 FIFO、重启恢复和危险操作保护。
- ErrorCode 唯一性、归一化、序列化、incident ID、诊断脱敏和未知错误回退。
- 双语目录完整性、ICU、占位符、locale 优先级、CLI JSON/退出码、IM language
  和 HTTP `Accept-Language`。
- Scheduler safe retry、三次上限、retry_wait FIFO、unknown/unsafe 不重放、
  取消和 Driver 缺失终态。
- Outbound 429/5xx/4xx/context 分类、重启恢复、最终死信，以及投递失败不改变
  succeeded task。
- 配对、人工身份绑定、群授权、审批所有权与幂等。
- 两层 skill 覆盖、Profile 过滤、严格包校验、启动快照、只读物化和清理。
- Codex / Claude Code 的同构 developer instructions 与 per-turn Host Tool 白名单。
- 五类记忆边界、factKey 替换、敏感内容拒绝、中英混合 FTS5、显式工具回执、
  无正则识别、Curator 重试幂等和 full 群 7 天清理。
- schema v1→v2→v3 的数据保留、独立备份、legacy error 映射、foreign-key
  校验和失败回滚。
- QQ / 微信 payload、QQ 回复上限、微信 cursor、疑似群消息拒绝。
- 一致性备份、校验和、敏感文件权限和空目录恢复。
- 控制协议版本/实例握手、endpoint 故障不回退、Unix socket/metadata 权限、
  stale socket 安全清理、offline ownership lease 和同一 `dataDir` 单实例。
- configuration drift、外部依赖 degraded、不安全 dataDir 与本地 health 绑定
  fatal 清理，以及 health/control DTO 隔离。
- 真实两进程 `imgent start` + CLI 验收：online status、pair、group authorize、
  online backup、offline mutation/restore 拒绝、第二实例冲突、SIGTERM 清理、
  停服 status、offline backup/restore。
- Codex fake app-server 双向 RPC 与 Claude SDK mock 合约。

Codex 还通过真实本机 app-server smoke，包括 initialize、登录态读取、新
thread、新 turn 和最终输出。按当前交付约定，Claude Code 不执行真实 CLI /
模型验证，只执行构建与 mock/contract 验证。

Dockerfile 与 Compose 配置已提供。容器不包含外部 Agent 登录目录，部署者需
自行提供已安装、已登录的 Codex / Claude CLI。
