# ChatGPT 网页版设置

打开 DSH 的「设置 → ChatGPT 网页版」。

1. 点击「登录网页版」，在弹出的 Chrome 中完成 ChatGPT 登录。
2. 点击「登录控制台」，在浏览器中完成 OpenAI Platform 登录。
3. 点击「连接隧道」。没有配置时创建 OpenAI Secure MCP Tunnel 和专用 Runtime API Key；只有测试 Key 时，在原 Tunnel ID 下升级为正式 Key；已有正式 Key 时复用。正式 Key 选择 Never，并用 Windows CurrentUser DPAPI 加密保存。连接或网页安装失败不会触发重复创建；创建提交结果不明时会停止创建，避免产生多把密钥。
4. 插件启动官方 tunnel-client，绑定本机 MCP，等待健康检查及控制面轮询成功。
5. 自动搜索同名的个人 Nexus DSH 插件。已有定义时先卸载，再删除个人插件定义；随后通过 Tunnel ID 重新创建、连接，并设置「允许使用所有工具」及刷新工具。

账号登录、验证码和人机验证始终由用户完成。遇到登录页时，配置任务显示「等待手动登录」；完成后再点击连接。配置失败可以重试，已保存的隧道及密钥不会重复创建。

已有 Tunnel ID / Runtime API Key 可以在「隧道与 API Key」中填写。Runtime Key 仅需 Tunnels 的 **Read、Use**。这与 ChatGPT 对 DSH 工具的授权是两个不同的权限面；网页插件允许使用当前 DSH 会话的全部可用工具，执行仍经过 DSH 的权限与工具执行器。

「高级设置」提供系统代理、直连、自定义代理、断线自动重连和工具自动刷新。存在多个 ChatGPT 工作区时，在此填目标工作区 ID；默认 API 项目名称为 Default project。

## 隧道与 Nexus 的对应关系

- 官方 `tunnel-client-runtime-cloudflared` v0.0.14，启动参数和环境变量与 Nexus 相同。
- 优先使用插件打包或已经安装的 Nexus runtime；缺少时下载官方固定版本，并校验 Nexus 固定的 ZIP SHA-256，保留 LICENSE / NOTICE。
- 隧道客户端主动向 OpenAI 建立连接，不需要用户拥有公网 IP、域名或开放入站端口。
- API Key 只通过子进程环境变量传入，本机 MCP Bearer 通过独立请求头注入；两者都不会进入命令参数或设置页状态。
- 外网代理只用于控制面，本地 MCP 始终通过回环直连。
- 连接状态同时检查 `/readyz` 与最近一次成功轮询指标；失败按 5、10、20、30、60 秒重连，认证错误停止自动重试。

## 图片与文件

DSH 原始用户附件在模型适配器投影前保留，通过附件服务取得存储位置。只上传本轮新发的附件，助手消息与过去的附件不会重复发送。文件和图片由 WebBridge 自己的 Playwright Page 使用原生文件选择接口上传，保留文件名和字节内容；上传失败时不提交缺少附件的消息。

发送顺序为填写用户文字、从加号菜单检查额度并选择 Nexus DSH、最后上传附件，然后发送。只含系统上下文 TXT 时，额度耗尽会跳过 TXT 并继续发送用户文字；用户图片或文件受限时显示 OpenAI 原提示，保留重试时间，不静默省略附件。临时文件保留到本轮结束。

续聊回到同一网页会话，只发送新增用户内容。生成中的正文以 text-delta 进入 DSH；完成后用网页正文重建 Markdown。默认一直等待到停止按钮消失、页面回到空闲状态，保留用户取消和登录错误。

同一 DSH 会话内串行，不同会话通过各自的 Page 并行；设置页操作使用独立的默认 Page。当前官方 MCP 请求尚未提供经过验证的会话标识：多个网页请求同时活跃时，DSH 工具调用会明确返回 ambiguous-tool-scope，避免在错误的会话中执行。需要工具的网页任务请串行运行。

WebBridge 不会补丁 BrowserOperator。上传、点击、输入和页面读取全部由插件自己的 `BrowserDriver` 完成；Codex 的 BrowserOperator 保持独立运行。

## 本机数据

- `~/.dsh/webbridge/tunnel-config.enc`：DPAPI 加密的隧道配置与 Runtime Key。
- `~/.dsh/webbridge/setup.json`：非敏感的插件 ID、资源名称、刷新时间和偏好设置。
- `~/.dsh/webbridge/mcp-token.key`：本机 MCP 的独立 Bearer，供隧道客户端在本地请求中注入。
- `~/.dsh/webbridge/chrome-profile`：WebBridge 独立 Chrome 持久 Profile（首次需要重新登录）。
- `~/.dsh/webbridge/sessions.json`：会话与独立 Page 的登记信息，插件启动时自动恢复。
- `~/.dsh/webbridge/browser-mode.json`：Headed 调试模式开关状态。

测试密钥可以使用一天有效期；设置页明确显示其到期时间。保存替换密钥时清除旧测试有效期。长期正式密钥保留到用户在控制台撤销为止。

## 开发验证

```powershell
npm run build:client
npm test
```

隧道健康检查与单元测试之外，还需要在 DSH 中发送真实消息，确认 ChatGPT 调用本地工具、DSH 展示工具卡片且返回当前轮次的答案。工具历史必须包含调用声明，重启后通过 DSH V4 恢复校验。
