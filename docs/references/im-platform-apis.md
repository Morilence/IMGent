# IM 平台接口事实手册

> `last_verified: 2026-07-23`
>
> 本文只记录会影响 Agent Pigeon 设计和实现的接口事实。官方接口可能变化，开发适配器前必须重新核对链接与权限，不在本仓库镜像完整厂商文档。

## 1. 能力矩阵

| 平台           | 产品阶段 | 私聊 | 群聊                   | 线程 / 话题         | v1 默认 Transport                      | 关键限制                                                         |
| -------------- | -------- | ---- | ---------------------- | ------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| QQ 官方机器人  | v1       | 支持 | 支持                   | v1 不处理频道线程   | Gateway WebSocket                      | 群聊默认只收触发消息；全量群消息需平台权限和群管理员显式开启     |
| 微信 iLink     | v1       | 支持 | 当前官方插件路径不支持 | 不支持              | HTTP 长轮询                            | 回复依赖 `context_token`；不保证主动发送；协议随官方插件演进     |
| 飞书应用机器人 | 待扩展   | 支持 | 支持                   | `thread_id`         | 官方 SDK 长连接优先                    | 自定义 Webhook 机器人只适合群内单向发送，不作为本产品适配目标    |
| Telegram Bot   | 待扩展   | 支持 | 支持                   | `message_thread_id` | 实现时在 long polling / webhook 中选择 | 默认 Privacy Mode 下只能收到命令、回复和其他与机器人相关的群消息 |

核心建模结论：

- Agent Pigeon 只接入平台官方机器人能力，不登录或模拟个人 IM 客户端；一个已配置机器人连接统一建模为 `BotInstance`。
- `botInstanceId` 是本地实例 ID，`platformBotId` 是平台分配的机器人 ID，消息发送者则使用 `actor.platformUserId`；三者不能混用。
- 私聊和群聊是不同的记忆安全边界，不能用同一个平台会话 ID 或昵称推断。
- 平台事件 ID、消息 ID、去重键和发送回复所需的上下文是四件不同的事。
- Feishu 和 Telegram 的 thread/topic 拆分 Agent session，但默认不拆分父群的共享记忆。
- 微信当前只能产生 `direct` 会话；即使 wire type 出现可选 `group_id`，也不能据此创建群聊和群记忆。

## 2. 统一字段映射

| Agent Pigeon 字段           | QQ                                            | 微信 iLink                     | 飞书                          | Telegram                                |
| --------------------------- | --------------------------------------------- | ------------------------------ | ----------------------------- | --------------------------------------- |
| `botInstanceId`             | 本地配置的 QQ 机器人实例 ID                   | 本地配置的 iLink 机器人实例 ID | 未来本地应用机器人实例 ID     | 未来本地 Bot 实例 ID                    |
| `platformBotId`             | QQ 开放平台 AppID                             | QR 授权返回的 `ilink_bot_id`   | 未来使用应用 / 机器人稳定标识 | 未来使用 Bot API 返回的 bot user ID     |
| `authorizingPlatformUserId` | 无                                            | QR 授权返回的 `ilink_user_id`  | 无                            | 无                                      |
| `eventId`                   | Gateway payload `id`                          | 无独立稳定事件 ID，可省略      | event header `event_id`       | 可省略                                  |
| `messageId`                 | message `id` / `msg_id`                       | `message_id`                   | `message.message_id`          | `message.message_id`，仅在 chat 内唯一  |
| `dedupeKey`                 | 适配器根据 `msg_id` 与接收序号 / 分片索引生成 | `seq + message_id`             | `message_id`                  | `update_id`                             |
| `sequence`                  | Gateway `s` 或消息 `msg_seq`                  | `seq`                          | 无                            | `update_id`                             |
| `conversation.id`           | `user_openid` 或 `group_openid`               | 对端 `from_user_id`            | `chat_id`                     | `chat.id`                               |
| `conversation.kind`         | `direct` / `group`                            | 固定 `direct`                  | `chat_type: p2p/group`        | `chat.type` 映射为 `direct/group`       |
| `conversation.threadId`     | v1 无                                         | 无                             | `thread_id`                   | `message_thread_id`                     |
| `actor.platformUserId`      | `user_openid`                                 | `from_user_id`                 | `sender_id.open_id` 等        | `from.id`                               |
| `actor.platformMemberId`    | 群聊 `member_openid`                          | 无                             | 群内仍使用发送者 ID           | `from.id`，匿名管理员另看 `sender_chat` |
| `replyContext`              | 原消息 ID、回复序号和场景信息                 | `context_token`                | 原消息 / thread 信息          | chat、message 与 thread 信息            |

所有 ID 入库时使用字符串，避免 QQ、微信或 Telegram 的大整数越过 JavaScript 安全整数范围。

## 3. QQ 官方机器人

### 3.1 官方来源

- [开发文档入口](https://bot.q.qq.com/wiki/develop/api-v2/)
- [接口调用凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)
- [事件订阅与通知](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
- [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [单聊消息事件 `C2C_MESSAGE_CREATE`](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/c2c/c2c-event.html)
- [群聊 @ 消息事件 `GROUP_AT_MESSAGE_CREATE`](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/group/group-at-message-event.html)

### 3.2 会话和事件

- 接入对象是在 QQ 开放平台创建的官方机器人：AppID 是机器人标识并映射为 `platformBotId`，AppSecret 用于取得 AccessToken。运行 Agent Pigeon 不需要、也不应登录部署者的个人 QQ 账号。
- QQ 官方机器人可在单聊、群聊和频道中收发消息；Agent Pigeon v1 只实现单聊和群聊。
- 单聊入口为 `C2C_MESSAGE_CREATE`。
- 群聊默认入口为 `GROUP_AT_MESSAGE_CREATE`，并结合回复机器人、命令和短期连续会话触发。
- `GROUP_MESSAGE_CREATE` 可以提供全量群消息，但需要相应事件权限。没有权限时订阅会失败或收不到事件，readiness 必须明确报错。
- Gateway payload 使用 `{ id, op, d, s, t }`；`s` 用于心跳和 Resume，处理完成后才能持久化为最新序号。
- WebSocket 断线后优先以 `session_id + seq` Resume；Resume 失败再重新 Identify。

### 3.3 身份、内容和去重

- 单聊用户以 `user_openid` 标识。
- 群聊成员以 `member_openid` 标识，群以 `group_openid` 标识；不能把二者与昵称混用。
- 消息可能包含 text、image、video、audio、file、emoji、card 等内容。Markdown 目前是发送能力，不应假设可从接收事件得到 Markdown。
- 同一 `msg_id` 可能重复推送；接收端结合事件中的序号 / 索引生成稳定 `dedupeKey`。
- 对同一消息多次回复需要递增发送 `msg_seq`；发送幂等不能只看 `msg_id`。

### 3.4 回复时效

| 场景 | 被动回复有效期 | 每条消息最多回复 |
| ---- | -------------- | ---------------- |
| 单聊 | 60 分钟        | 4 次             |
| 群聊 | 5 分钟         | 5 次             |

超出被动回复窗口时，只能在用户或群允许主动消息且当前配额允许时降级为主动发送；否则任务进入可诊断的发送失败状态，不能伪装成功。

### 3.5 Agent Pigeon 的群聊策略

- 每群保存 `triggered` 或 `full` 模式，默认 `triggered`。
- 切换 `full` 的发起者必须同时满足：已配对、已获授权、事件中可验证为群主或管理员。
- 无法取得角色或平台未授予全量事件权限时失败关闭。
- 切换成功后在群内提示采集范围、7 天原文保留期和关闭命令，并写审计记录。
- `full` 模式中的普通群消息可以写入短期群上下文并进入群记忆策展，但不会触发机器人回复。
- 关闭后立即停止接收或持久化新的普通群消息；历史原文按原到期时间删除，不回填开启前内容。

## 4. 微信 iLink

### 4.1 官方来源和稳定性

- [腾讯 `openclaw-weixin` 仓库](https://github.com/Tencent/openclaw-weixin)
- [npm 包 `@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
- [协议说明（README.zh_CN）](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md)
- [`2.4.6` 包元数据](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/package.json)
- [QR 授权字段映射（上游文件名 `login-qr.ts`）](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/auth/login-qr.ts)
- [入站 direct 类型](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/inbound.ts)
- [当前消息标准化实现](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/messaging/process-message.ts)
- [协议类型](https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/src/api/types.ts)

2026-07-23 查询到的 npm 最新版本为 `@tencent-weixin/openclaw-weixin@2.4.6`；本节字段结论绑定仓库提交 `cef0bfc390393f716903e16d50408118047f87e0`。它是腾讯维护的 OpenClaw 插件，也是当前最接近官方开发指南和协议实现的资料，但 iLink 尚不是独立版本化、承诺稳定的公共 Bot API。适配器兼容性必须记录“验证过的插件版本和提交”，不能只写“兼容微信”。

### 4.2 QR 授权与认证

1. 获取授权二维码，并在终端展示二维码或可打开的二维码地址。
2. 微信用户扫码确认后，长轮询取得 `bot_token`、`ilink_bot_id`、`ilink_user_id` 和 `baseurl`。
3. Agent Pigeon 将 `ilink_bot_id` 记录为 `platformBotId`，将扫码授权者 `ilink_user_id` 记录为 `authorizingPlatformUserId`，并将 bot token 写入 `credentialRef` 指向的本地凭据存储。
4. 上游 OpenClaw 插件把 `ilink_bot_id` 放入运行时 `accountId` 字段，并把每次扫码结果称为 account entry；这是上游宿主术语，不进入 Agent Pigeon 的公开配置、消息信封或身份模型。
5. 该流程是用户对 iLink Bot 的扫码授权，不是 Agent Pigeon 登录、接管或模拟扫码者的个人微信客户端会话。
6. 后续请求携带：
   - `AuthorizationType: ilink_bot_token`
   - `Authorization: Bearer <bot_token>`
   - `X-WECHAT-UIN`
7. token 只进入本地凭据存储，不能写入配置样例、日志、消息原文或长期记忆。

### 4.3 收发消息

- `getupdates` 使用 `get_updates_buf` 游标长轮询；收到响应并持久化消息后才推进游标。
- 服务端返回的 `longpolling_timeout_ms` 用于下一次请求超时。
- 收到会话失效错误时停止消费并要求重新 QR 授权，不能无限重试旧 token。
- `sendmessage` 回复到 `from_user_id`，必须带入站消息的 `context_token`。
- `getuploadurl` 提供媒体上传参数；图片、视频和文件按官方实现进行 AES-128-ECB 加密及 CDN 上传。
- 内容 item 至少包括 text、image、voice、file、video；不能把不理解的内容静默丢弃。

### 4.4 会话能力结论

- 当前可验证的腾讯官方 `2.4.6` 实现将入站 `ChatType` 和 peer 固定为 direct，群白名单为空，消息处理显式使用 `isGroup: false`。
- wire type 中可选的 `group_id` 没有配套的官方群事件、成员、权限和发送语义，当前实现也不读取它；因此它只能视为保留字段，不能据此声称支持群聊。
- 结论边界是“当前官方实现仅支持 direct，Agent Pigeon v1 不支持微信 iLink 群聊”，而不是推断底层协议未来永远不可能扩展群聊。
- v1 始终以 `botInstanceId + from_user_id` 建立私聊会话，不复用不同联系人之间的 Agent session。
- 微信 v1 不创建 `ConversationSpace(group)`，也不查询或写入任何群记忆作用域。
- 发送依赖近期 `context_token`，因此不承诺无上下文的主动推送；token 必须随任务短期持久化并在终态清理。

## 5. 飞书应用机器人（待扩展）

### 5.1 官方来源

- [飞书开放平台文档索引](https://open.feishu.cn/llms.txt)
- [接收消息事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)
- [发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)
- [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)
- [机器人回声示例](https://open.feishu.cn/document/develop-an-echo-bot/explanation-of-example-code?lang=zh-CN)

### 5.2 建模事实

- 未来适配目标是“应用机器人”，不是“自定义 Webhook 机器人”。后者主要面向群内单向发送，不能满足私聊、身份和审批闭环。
- `im.message.receive_v1` 同时覆盖 `chat_type: p2p` 和 `group`。
- 事件可能重试；消息业务去重使用 `message_id`，不能只使用 event header 的 `event_id`。
- 保留 `root_id`、`parent_id`、`thread_id`、`chat_id`、`message_type`、`mentions` 和 sender ID。
- 权限可以只覆盖私聊、群 @ 或全部群消息；未来适配器必须在 readiness 中报告实际授权范围。
- 官方 SDK 长连接适合自建应用且无需公网回调地址；Webhook 仍可作为未来可选 Transport，同一 BotInstance 只能启用一个入站 Transport。

## 6. Telegram Bot（待扩展）

### 6.1 官方来源

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Bots FAQ](https://core.telegram.org/bots/faq)
- [Bots introduction](https://core.telegram.org/bots)

### 6.2 建模事实

- Bot 可收到所有用户私聊消息。
- 群聊开启 Privacy Mode 时，只能收到命令、通过机器人发送的消息和回复机器人等相关消息；管理员或关闭 Privacy Mode 后可以收到更多群消息。
- `Chat.type` 包括 `private`、`group`、`supergroup`、`channel`。未来 v1-like 适配只把 private 映射为 direct，把 group/supergroup 映射为 group；channel 不自动视为群聊 Agent 会话。
- `Update.update_id` 用于更新去重和推进 long polling offset。
- `Message.message_id` 只在当前 chat 内唯一；必须与 `chat.id` 联合定位。
- `message_thread_id` 用于论坛 topic，也可能出现在私聊 topic；保留为 `threadId`。
- `getUpdates` 与 webhook 互斥；更新最长只保留有限时间，不能把 Telegram 当作永久队列。
- Webhook 实现时使用 `secret_token` 验证来源。

## 7. 开发前复核清单

- 重新记录官方文档更新时间、SDK / CLI / 插件版本和实际机器人应用权限。
- 用真实但脱敏的 direct、group、thread、reply、media 事件建立 fixture。
- 验证断线恢复、重复投递、回复超时和权限撤销，而不只验证 happy path。
- 新平台只有在适配器、配置、doctor、验收场景全部完成后，才能从“待扩展”改成“支持”。
