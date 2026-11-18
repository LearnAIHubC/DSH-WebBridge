# ChatGPT 网页版设置

打开 DSH 的「设置 → ChatGPT 网页版」。

1. 点击「登录网页版」，在弹出的 Chrome 中完成 ChatGPT 登录。
2. 在 OpenAI 控制台自行创建 Secure MCP Tunnel 和 Runtime API Key，把 Tunnel ID 填进「渠道」、密钥填进「API Key」。逐步说明见 [如何获取渠道与 API Key](CHANNEL-AND-API-KEY.md)。设置页不再代登录控制台，也不会自动创建隧道或密钥。
3. 点击「保存并连接」。插件用填写的 Tunnel ID 与 Runtime API Key 启动官方 tunnel-client，绑定本机 MCP，等待健康检查及控制面轮询成功。密钥在 Windows 上使用当前用户 DPAPI 加密，macOS 保存到登录钥匙串；输入框留空表示保留已保存的密钥。
4. 在 ChatGPT 网页里自行创建 Nexus DSH 插件：连接方式选 Tunnel、认证选「无需身份验证」、权限选「允许使用所有工具」，步骤见 [如何获取渠道与 API Key](CHANNEL-AND-API-KEY.md) 第三步。插件不会代为创建或修改网页插件。
5. 账号登录、验证码和人机验证始终由用户完成。读取状态不会重启浏览器或关闭正在填写的表单。

Runtime Key 仅需 Tunnels 的 **Read、Use**。这与 ChatGPT 对 DSH 工具的授权是两个不同的权限面；网页插件允许使用当前 DSH 会话的全部可用工具，执行仍经过 DSH 的权限与工具执行器。

「高级设置」提供系统代理、直连、自定义代理、断线自动重连和健康检查端口。

「保存并连接」只做三件事：加密保存两串值、启动官方 tunnel-client、检测 MCP 是否可达（`/readyz` 与控制面轮询）。隧道、密钥和网页插件的创建都在网页侧由你手动完成；网页端工具目录的维护（权限与刷新）也在 ChatGPT 网页里操作。

## 隧道 runtime 说明

- 官方 `tunnel-client-runtime-cloudflared` v0.0.14，启动参数和环境变量沿用上游项目（来源见 THIRD_PARTY_NOTICES.md）。
- 优先使用插件打包或已经安装的 runtime；Windows 也可复用上游项目的 runtime（来源见 THIRD_PARTY_NOTICES.md）。缺少时下载官方 v0.0.14，并校验固定的 ZIP SHA-256，保留 LICENSE / NOTICE 和 companion manifest。macOS 按 Node 进程架构选择 arm64 或 amd64，安装后设置可执行权限。
- 隧道客户端主动向 OpenAI 建立连接，不需要用户拥有公网 IP、域名或开放入站端口。
- API Key 只通过子进程环境变量传入，本机 MCP Bearer 通过独立请求头注入；两者都不会进入命令参数或设置页状态。
- 外网代理只用于控制面，本地 MCP 始终通过回环直连。
- 连接状态同时检查 `/readyz` 与最近一次成功轮询指标；失败按 5、10、20、30、60 秒重连，认证错误停止自动重试。

## 图片与文件

DSH 原始用户附件在模型适配器投影前保留，通过附件服务取得存储位置。只上传本轮新发的附件，助手消息与过去的附件不会重复发送。文件和图片由 WebBridge 自己的 Playwright Page 使用原生文件选择接口上传，保留文件名和字节内容；上传失败时不提交缺少附件的消息。

发送顺序为填写用户文字与短上下文引用、选择 Nexus DSH、上传用户本轮提供的附件，然后发送。DSH 上下文通过 MCP 读取，不生成或上传上下文 TXT。用户图片或文件受限时显示 OpenAI 原提示，保留重试时间，不静默省略附件。临时文件保留到本轮结束。

续聊回到同一网页会话，只发送新增用户内容。生成中的正文以 text-delta 进入 DSH；完成后用网页正文重建 Markdown。默认一直等待到停止按钮消失、页面回到空闲状态，保留用户取消和登录错误。若网页报错、插件重载或旧会话恢复后怀疑两边状态不一致，可点模型选择器旁的「同步」：当前网页线程会重建，provider 增量游标、DSH context snapshot 和该 DSH 会话对应的 MCP 路由绑定会一起失效；下一条消息按当前 DSH 历史重新加载完整上下文。

同一 DSH 会话内串行，不同会话通过各自的 Page 并行；设置页操作使用独立的默认 Page。MCP 同时支持旧式有状态连接和 `2026-07-28` 无会话调用：ChatGPT 读取 `dsh_get_context` 时由 `context_id` 解析真实 DSH `sessionId`；旧协议把这个映射记在 MCP session，新协议则在后续 DSH 工具的 MCP schema 中带 `dsh_context_id`，路由完成后立即剥离，真实 DSH 工具不会收到该字段。没有已验证路由 handle 且同时存在多个 DSH 请求时仍返回 `ambiguous-tool-scope`。

WebBridge 不会补丁 BrowserOperator。上传、点击、输入和页面读取全部由插件自己的 `BrowserDriver` 完成；Codex 的 BrowserOperator 保持独立运行。

## 发送失败时自动恢复

找不到输入框、发送按钮暂时不可用，或点击后消息仍留在输入框时，插件会先检查网页和本轮用户消息，再尝试恢复。一次发送最多尝试三次：确认未发出后清空重填，仍失败则重新打开原会话，恢复模型、桥接插件与本轮附件后再试。恢复旧会话时也会检查登录状态。

消息已经出现在对话中时，即使点击报告超时，也会继续等待这条消息的回复。页面短暂重绘或读取失败时会重新检查；输入框消失或变空本身不算发送成功。始终无法确认发送结果时，会保留现场并说明原因，避免重复发送或覆盖用户新写的内容。

重新打开空白会话可能让 ChatGPT 恢复上一次的旧对话，插件会重新创建空白会话并准备完整上下文。重试仍失败才把具体原因交给 DSH；取消请求会停止后续重试。登录失效、验证码、人机验证和附件额度限制仍按原有提示处理。

## 本机数据

- Windows：`~/.dsh/webbridge/tunnel-config.enc` 保存 DPAPI 加密的隧道配置与 Runtime Key。
- macOS：登录钥匙串中服务名为 `DSH WebBridge` 的条目保存配置与 Runtime Key，账号由本地配置路径的 SHA-256 生成，不另写明文配置文件。首次访问可能需要解锁或允许访问钥匙串；不要把 Windows 的 DPAPI 文件当作可跨平台迁移的密钥。
- `~/.dsh/webbridge/tunnel-runtime`：当前平台的官方隧道程序、cloudflared 及许可证。
- `~/.dsh/webbridge/setup.json`：非敏感的插件 ID、刷新时间和偏好设置。
- `~/.dsh/webbridge/mcp-token.key`：本机 MCP 的独立 Bearer，供隧道客户端在本地请求中注入。
- `~/.dsh/webbridge/chrome-profile`：WebBridge 独立 Chrome 持久 Profile（首次需要重新登录）。
- `~/.dsh/webbridge/sessions.json`：会话与网页地址的登记信息。启动时只加载登记，不启动 Chrome；任务开始时打开对应页面，结束后关闭页面，历史地址继续保留。
- `~/.dsh/webbridge/browser-mode.json`：Headed 调试模式开关状态。

密钥的有效期在 OpenAI 控制台里管理；填入新密钥并保存即可替换旧值。

## 开发验证

```powershell
npm run build:client
npm test
```

隧道健康检查与单元测试之外，还需要在 DSH 中发送真实消息，确认 ChatGPT 调用本地工具、DSH 展示工具卡片且返回当前轮次的答案。工具历史必须包含调用声明，重启后通过 DSH V4 恢复校验。
