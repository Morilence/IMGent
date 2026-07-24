# IMGent v1 implementation status

本仓库按 `imgent-product-design.md` 的 v1 边界实现，并采用后续确认的
pnpm monorepo 结构：

- 根包：单进程运行时、SQLite、身份、审批、记忆、队列、CLI、管理端点与备份。
- `packages/im-adapters/qq`：QQ 官方 Gateway、Resume、消息规范化和回复限制。
- `packages/im-adapters/wechat-ilink`：QR 授权、长轮询、cursor、媒体与
  `context_token`。
- `packages/agent-drivers/codex`：Codex app-server stdio JSON-RPC。
- `packages/agent-drivers/claude-code`：Claude Agent SDK。
- `packages/contracts`：跨包类型、集中错误码、错误 descriptor 和协议。
- 根 `skills/` 与 `src/skills/`：IMGent 托管的内置技能包、两层注册表、启动
  快照和 per-turn 只读物化。

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

## 验证

标准验证命令：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
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
- Codex fake app-server 双向 RPC 与 Claude SDK mock 合约。

Codex 还通过真实本机 app-server smoke，包括 initialize、登录态读取、新
thread、新 turn 和最终输出。按当前交付约定，Claude Code 不执行真实 CLI /
模型验证，只执行构建与 mock/contract 验证。

Dockerfile 与 Compose 配置已提供。容器不包含外部 Agent 登录目录，部署者需
自行提供已安装、已登录的 Codex / Claude CLI。
