# Agent 驱动协议事实手册

> `last_verified: 2026-07-24`
>
> IMGent v1 正式支持 Codex 与 Claude Code，但只统一产品语义，不假设二者共享 wire protocol。

## 1. 支持矩阵

| 能力       | Codex                                 | Claude Code                                                |
| ---------- | ------------------------------------- | ---------------------------------------------------------- |
| 集成入口   | `codex app-server`                    | `@anthropic-ai/claude-agent-sdk` TypeScript                |
| 底层进程   | 长生命周期 app-server                 | SDK 管理本地 `claude` 进程                                 |
| 协议       | 双向 JSON-RPC，stdio 为默认 Transport | SDK message stream / hook callback                         |
| 会话 ID    | thread ID                             | session ID                                                 |
| Turn       | `turn/start`                          | 一次 `query()` / streaming input                           |
| 流式输出   | `item/*`、`turn/*` notifications      | SDK assistant / stream event / result messages             |
| 审批       | app-server 发起 JSON-RPC request      | `canUseTool` 与 `PreToolUse` hook                          |
| 长等待审批 | 保持请求或持久化后恢复 thread         | TypeScript `permissionDecision: "defer"` 后按 session 恢复 |
| 取消       | turn interrupt / cancel               | AbortSignal / query interrupt                              |
| 登录       | 本地 Codex 登录态                     | 本地 Claude Code 登录态                                    |

本机调研基线：

- `codex-cli 0.145.0`
- 当前验证机未安装 `claude`；Claude Code 由 SDK mock/contract 测试验证。

Claude Code v1 驱动要求 `>= 2.1.89`。命令缺失或版本低于要求时，
`imgent doctor` 报 readiness 失败，而不是静默退化。

## 2. 统一 `AgentDriver` 语义

核心只依赖以下行为，不暴露厂商 wire object：

```ts
type AgentEvent =
  | { type: "output-delta"; text: string }
  | { type: "output-final"; text: string }
  | { type: "approval-request"; request: ApprovalRequest }
  | { type: "question"; request: UserQuestion }
  | { type: "session"; sessionId: string }
  | { type: "completed"; result: "success" | "cancelled" }
  | { type: "error"; error: ErrorDescriptor };

interface DriverReadiness {
  ready: boolean;
  version?: string;
  issues: ErrorDescriptor[];
}

interface AgentDriver {
  readonly id: "codex" | "claude-code";
  checkReady(profile: AgentProfile): Promise<DriverReadiness>;
  runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  answerRequest(requestId: string, answer: AgentRequestAnswer): Promise<void>;
  interrupt(turnId: string): Promise<void>;
}

interface AgentTurnInput {
  developerInstructions?: string;
  ephemeral?: boolean;
  hostTools?: string[];
  builtInTools?: "default" | "none";
}
```

这不是第三方插件 API。v1 只有两个内置实现，分别位于
`packages/agent-drivers/codex` 与 `packages/agent-drivers/claude-code`。

统一层负责：

- 将包含 `botInstanceId` 命名空间的会话键映射到厂商 session/thread ID；AgentDriver 不接收平台凭据，也不把不同机器人实例的会话合并。
- 将文本、图片和记忆上下文转换为厂商输入。
- 把同一份 IMGent skill catalog、developer instructions 与 Host Tool 白名单
  映射到厂商接口。
- 将输出、审批、问题、完成和错误转换为 `AgentEvent`。
- 把厂商认证、版本、网络和协议错误映射为集中注册的稳定 ErrorCode；原始厂商
  文本只进入统一脱敏诊断，不进入 AgentEvent 或用户文案。
- 在 SQLite 中保存 session/thread ID、当前 turn、待审批请求和恢复所需状态。
- 保证一个 conversationKey 同时只有一个 active turn。

驱动自身负责：

- 进程生命周期和 wire protocol。
- 厂商版本与能力协商。
- 解析厂商事件并保留未知事件的可诊断元数据。
- 无论正常、取消还是失败，必须产生 completed/error 终态；流结束但没有终态
  由 Scheduler 记录 `DRIVER_PROTOCOL_INCOMPLETE`。
- 取消和恢复的实际调用。

## 3. Codex app-server

### 3.1 官方来源

- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex 仓库](https://github.com/openai/codex)
- [OpenAI Codex 文档](https://developers.openai.com/codex/)

### 3.2 Transport 和 schema

- 默认以子进程 stdio 启动 `codex app-server`。
- 每行传输一个 JSON-RPC 消息；app-server 的 wire format 不等于 OpenAI Chat Completions，也不是 ACP。
- WebSocket 当前不作为 v1 生产 Transport，更不能直接暴露到公网。
- 开发和发布时使用当前 Codex 构建提供的 `generate-ts` 或 JSON Schema 生成命令取得匹配 schema；生成物属于实现阶段，不复制到本事实手册。
- 启动时先协商能力。新版本出现未知 notification 时记录类型并忽略，缺少必需 method 时 readiness 失败。

### 3.3 生命周期

1. 启动子进程并连接 stdin/stdout/stderr。
2. 发送一次 `initialize`。
3. 收到结果后发送 `initialized` notification。
4. 新会话使用 `thread/start`；已有会话使用 `thread/resume`。
5. 使用 `turn/start` 发送用户输入。
6. 消费 `item/started`、`item/completed`、delta 和 `turn/completed` 等通知。
7. app-server 发起审批 request 时，先持久化请求，再把审批发回原 IM 会话。
8. 用户决定后回写同一 JSON-RPC request；重复答复必须幂等。
9. 取消 active turn 时调用 app-server 的 interrupt/cancel 能力，不通过杀进程模拟正常取消。

IMGent 在 `thread/start` 和 `thread/resume` 传入相同语义的
`developerInstructions`。新 thread 通过 `dynamicTools` 只注册当前 turn
允许的 IMGent Host Tools；后台 Curator 使用 `ephemeral: true`、read-only
sandbox、`approvalPolicy: never`，并通过 thread config 关闭 Shell、统一执行器、
浏览器、应用、插件与其他厂商内置能力，只保留受控 memory dynamic tools。

### 3.4 恢复与故障

- thread ID 与 conversationKey 一一映射；不同 BotInstance 或不同平台的私聊即使共享个人记忆，也不自动共享 thread。
- app-server 异常退出时，当前 turn 标记 interrupted；重启后先尝试恢复 thread。
- 恢复能力不可用时建立新 thread，并注入最近会话摘要和当前允许作用域的记忆。
- stderr 只用于脱敏诊断；不能混入 JSON-RPC stdout parser。
- `doctor` 至少检查：命令存在、版本可读取、登录有效、app-server 可 initialize、工作目录存在且在允许边界内。

## 4. Claude Code Agent SDK

### 4.1 官方来源

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [审批与用户输入](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Session](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [认证](https://code.claude.com/docs/en/authentication)
- [法律与合规](https://code.claude.com/docs/en/legal-and-compliance)

### 4.2 选择 TypeScript SDK 的原因

- Streaming input 支持长生命周期交互、排队消息、实时输出、中断、session 和权限请求。
- `canUseTool` 可以把工具审批和 `AskUserQuestion` 转发到聊天。
- TypeScript `PreToolUse` hook 支持 `permissionDecision: "defer"`：非交互进程可以在工具调用处退出，保留调用并稍后恢复。
- 直接解析 `claude -p --output-format stream-json` 会重新实现 SDK 已提供的协议和兼容处理，因此 v1 不走这条路径。

### 4.3 Turn 和 session

- 每个 conversationKey 明确保存自己的 Claude session ID；conversationKey 已包含 `botInstanceId`，不能使用 `continue: true` 猜“当前目录最近一次 session”。
- 新会话调用 `query()`；已有会话通过 `resume: sessionId` 恢复。
- 工作目录必须与创建 session 时一致。目录变化或 session 文件丢失时 readiness / resume 明确失败，再按新 session + 摘要策略恢复。
- 从 init system message 或 result message 尽早捕获 session ID，并在可能出现审批前持久化。
- output stream 只将用户可读文本和状态转换为 `AgentEvent`；工具参数、内部思考和 token 不直接回发 IM。
- IMGent developer instructions 使用 preset system prompt 的 `append`，不替换
  Claude Code 基础提示；IMGent Host Tools 通过单 turn MCP server 暴露并由
  `allowedTools` 过滤。
- `ephemeral` turn 设置 `persistSession: false`；Curator 还把 SDK `tools`
  设为空数组，只允许 `memory.search` 与 `memory.remember`。

### 4.4 审批

短等待：

1. `canUseTool` 收到工具名、输入和建议权限。
2. 持久化审批请求并发送到原 IM 会话。
3. 回调保持 pending，收到用户答复后返回 allow 或 deny。

长等待或进程需要退出：

1. `PreToolUse` hook 返回 `permissionDecision: "defer"`。
2. 持久化 session ID、deferred tool use、原始请求和审批消息 ID。
3. turn 进入 `waiting_approval`，释放进程资源。
4. 用户答复后以同一 session 恢复并提交决定。
5. 重复、过期或来自错误会话的答复拒绝且不执行工具。

任何“始终允许”权限更新都必须受 AgentProfile 的权限上限约束；IM 用户不能通过 SDK suggestion 扩大宿主允许范围。

### 4.5 认证边界

- IMGent 只调用同一 OS 用户下已安装、已登录的 Claude Code。
- 不实现 Claude 登录页面，不读取、复制、返回或代管 Claude OAuth token。
- 不把部署者凭据提供给群成员，也不允许 IM 命令导出认证信息。
- Claude 的正式支持表示技术集成达到验收标准，不表示用户可以绕过 Anthropic 对第三方服务、订阅凭据或团队使用的条款。
- 部署者必须确认当前认证方式适用于自己的使用场景；不适用时该 profile readiness 失败。
- 为保留本地登录态，v1 不默认使用会跳过 OAuth/keychain 的 `--bare`。

### 4.6 `doctor` 检查

- `claude` 命令存在且版本 `>= 2.1.89`。
- Agent SDK 与本地 CLI 组合可启动一次无副作用的 readiness 查询。
- 本地认证有效；失败时只显示官方登录指引，不回显凭据。
- profile 工作目录存在、可访问且与 session 恢复目录一致。
- streaming input、session capture、defer hook 和 interrupt 能力可用。

## 5. 同等正式支持的验收

Codex 与 Claude Code 都必须通过：

- 新会话与指定会话恢复。
- 连续两轮对话不串 conversationKey。
- 流式文本与最终文本不重复发送。
- 工具审批允许、拒绝、超时和重复答复。
- 长等待审批跨进程恢复。
- 用户取消 active turn。
- Agent 进程异常退出后的明确状态和可控恢复。
- 登录失效、CLI 版本不兼容、工作目录丢失的 readiness 提示。
- 记忆工具失败时不得回复“已记住”。
- 新建与恢复 turn 得到相同 IMGent skills 指令；两个 Driver 都不能看到超出
  `hostTools` 白名单的 IMGent 工具。
- Curator turn 不持久化 session、不产生聊天输出，且不能使用 Shell、
  `memory.update` 或 `memory.forget`。

某一驱动未通过这些验收时，只能标记为 experimental，不能在文档或 CLI 中称为正式支持。
