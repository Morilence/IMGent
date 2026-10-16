# WeChat reply delivery / 微信回复投递

## Agent attachments / Agent 附件

IMGent injects delivery instructions into every WeChat turn for both Codex and Claude Code.
The final-answer contract accepts a standalone `MEDIA: /absolute/workspace/path` line outside
code blocks. The service validates and snapshots the file, replaces the directive with a typed
attachment, and atomically queues the reply when completing the task. Existing sessions receive
the instructions on resume; no new dynamic tool registration is required.

IMGent 每轮向微信 Agent 注入发送说明。Agent 在最终回复中将 `MEDIA: /工作区绝对路径`
独占一行，服务读取并快照文件，将该行转为原生附件，与任务完成状态一同入队。代码块、行内代码
和缩进代码中的示例不会触发发送。最多 10 个附件，每个最多 100 MiB；PNG/JPEG/GIF/WebP
按内容识别为图片，常见 MP4 为视频，其他格式作为文件。

Only actual files within the resolved conversation workspace are accepted, including symlink
target checks. HTTP URLs are not fetched from final-answer syntax: the Agent must download them
using its permitted tools first. Missing, empty, oversized, or out-of-workspace files produce
`OUTBOUND_MEDIA_INVALID`, not a successful text-only reply. Queued snapshots survive restarts and
source-file changes. Cleanup preserves unsent/dead-letter attachments; sent or orphaned snapshots
become eligible for removal after one hour. Ordinary inbound-media cleanup remains separate.

附件必须位于当前会话的授权工作区内；符号链接按真实目标校验。远程资源需先由 Agent 使用获准的
工具下载。路径不存在、文件为空、超限或越界时，IMGent 明确报错。待发送或死信附件保留供重试；
已发送或孤立快照超过一小时后由清理任务回收。

## Text and protocol / 文本与协议

WeChat implements a Markdown subset, not an HTML or Markdown-image transport. IMGent keeps bold,
links, code, tables, lists and headings through H4; H5/H6 markers and CJK italic markers are removed.
An inline Markdown image becomes a normal link rather than a broken `!` link. Code examples are
left literal. A Markdown-aware tokenizer handles reference images and parentheses in URLs.

微信只支持部分 Markdown；`![图片](链接)` 不会上传图片。IMGent 保留可用格式，过滤不兼容写法，
图片 Markdown 回退为普通链接。真正的图片须走上述附件通道。

The iLink adapter is implemented in IMGent, not through an installed OpenClaw SDK. The protocol
was checked against Tencent's repository on 2026-10-16, commit
[`874637a0dbc24050f72d1385add4fc6170a2d726`](https://github.com/Tencent/openclaw-weixin/tree/874637a0dbc24050f72d1385add4fc6170a2d726)
(package version 2.4.10):

- [Media sender](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts):
  one item per `sendmessage` request; caption and media are separate messages; `aes_key` is the
  base64 encoding of the 32-character hexadecimal AES key.
- [Markdown filter](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/markdown-filter.ts):
  supported syntax is retained; inline images, H5/H6 and CJK italics require adaptation.
- [Upload flow](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/upload.ts):
  AES-128-ECB with PKCS#7, plaintext size/MD5, ciphertext size, CDN POST and `x-encrypted-param`.

IMGent uses stable per-item client IDs across retries and skips acknowledged items while the
adapter remains alive. This is not an exactly-once guarantee across a process crash or an
ambiguous server response. Delivery still requires the conversation's valid `context_token`;
successful API responses alone do not prove rendering in a particular WeChat client.

重试使用稳定的逐条 client ID，并在进程内跳过已确认发送的条目；进程崩溃或响应不确定时，不能
承诺严格只发送一次。发送仍受微信回复上下文有效期约束，客户端显示效果需实机验收。
