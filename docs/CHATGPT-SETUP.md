# ChatGPT 网页版设置

打开 DSH 的「设置 → ChatGPT 网页版」。

1. 点击「登录网页版」，在弹出的 Chrome 中完成 ChatGPT 登录。
2. 点击「登录控制台」，在浏览器中完成 OpenAI Platform 登录。
3. 点击「连接隧道」。没有配置时创建 OpenAI Secure MCP Tunnel 和专用 Runtime API Key；只有测试 Key 时，在原 Tunnel ID 下升级为正式 Key；已有正式 Key 时复用。正式 Key 选择 Never；Windows 使用 CurrentUser DPAPI 加密，macOS 保存到登录钥匙串。连接或网页安装失败不会触发重复创建；创建提交结果不明时会停止创建，避免产生多把密钥。
4. 插件启动官方 tunnel-client，绑定本机 MCP，等待健康检查及控制面轮询成功。
5. 首次连接时自动创建 Nexus DSH 网页插件，再设置「允许使用所有工具」并刷新工具。重试时复用已保存的插件 ID 和隧道关联；搜索结果按插件 ID 去重。发现无法确认属于当前隧道的同名定义时会停止，不覆盖或删除它。

账号登录、验证码和人机验证始终由用户完成。登录操作先检查已有会话，最多等待五分钟供用户手动登录；检测成功后显示「登录成功，可以连接隧道」。读取状态不会重启浏览器或关闭正在填写的表单。配置失败可以重试，已保存的隧道及密钥不会重复创建。

已有 Tunnel ID / Runtime API Key 可以在「隧道与 API Key」中填写。Runtime Key 仅需 Tunnels 的 **Read、Use**。这与 ChatGPT 对 DSH 工具的授权是两个不同的权限面；网页插件允许使用当前 DSH 会话的全部可用工具，执行仍经过 DSH 的权限与工具执行器。

「高级设置」提供系统代理、直连、自定义代理、断线自动重连和工具自动刷新。存在多个 ChatGPT 工作区时，在此填目标工作区 ID；默认 API 项目名称为 Default project。

安装流程使用固定选项值、表单属性和控件结构；工具授权使用 `full_access`，刷新使用页面的固定动作 ID。按钮显示语言不参与这些动作的定位。页面结构不符合预期时会显示具体步骤，并在提交前停止；不会通过反复创建资源来重试。

## 隧道与 Nexus 的对应关系

- 官方 `tunnel-client-runtime-cloudflared` v0.0.14，启动参数和环境变量与 Nexus 相同。
- 优先使用插件打包或已经安装的 runtime；Windows 也可复用 Nexus runtime。缺少时下载官方 v0.0.14，并校验固定的 ZIP SHA-256，保留 LICENSE / NOTICE 和 companion manifest。macOS 按 Node 进程架构选择 arm64 或 amd64，安装后设置可执行权限。
- 隧道客户端主动向 OpenAI 建立连接，不需要用户拥有公网 IP、域名或开放入站端口。
- API Key 只通过子进程环境变量传入，本机 MCP Bearer 通过独立请求头注入；两者都不会进入命令参数或设置页状态。
- 外网代理只用于控制面，本地 MCP 始终通过回环直连。
- 连接状态同时检查 `/readyz` 与最近一次成功轮询指标；失败按 5、10、20、30、60 秒重连，认证错误停止自动重试。

## 图片与文件

DSH 原始用户附件在模型适配器投影前保留，通过附件服务取得存储位置。只上传本轮新发的附件，助手消息与过去的附件不会重复发送。文件和图片由 WebBridge 自己的 Playwright Page 使用原生文件选择接口上传，保留文件名和字节内容；上传失败时不提交缺少附件的消息。

发送顺序为填写用户文字、从加号菜单检查额度并选择 Nexus DSH、最后上传附件，然后发送。只含系统上下文 TXT 时，额度耗尽会跳过 TXT 并继续发送用户文字；用户图片或文件受限时显示 OpenAI 原提示，保留重试时间，不静默省略附件。临时文件保留到本轮结束。

续聊回到同一网页会话，只发送新增用户内容。生成中的正文以 text-delta 进入 DSH；完成后用网页正文重建 Markdown。默认一直等待到停止按钮消失、页面回到空闲状态，保留用户取消和登录错误。若网页报错、插件重载或旧会话恢复后怀疑两边状态不一致，可点模型选择器旁的「同步」：当前网页线程会重建，provider 增量游标、DSH context snapshot 和该 DSH 会话对应的 MCP 路由绑定会一起失效；下一条消息按当前 DSH 历史重新加载完整上下文。

同一 DSH 会话内串行，不同会话通过各自的 Page 并行；设置页操作使用独立的默认 Page。MCP 同时支持旧式有状态连接和 `2026-07-28` 无会话调用：ChatGPT 读取 `dsh_get_context` 时由 `context_id` 解析真实 DSH `sessionId`；旧协议把这个映射记在 MCP session，新协议则在后续 DSH 工具的 MCP schema 中带 `dsh_context_id`，路由完成后立即剥离，真实 DSH 工具不会收到该字段。没有已验证路由 handle 且同时存在多个 DSH 请求时仍返回 `ambiguous-tool-scope`。

WebBridge 不会补丁 BrowserOperator。上传、点击、输入和页面读取全部由插件自己的 `BrowserDriver` 完成；Codex 的 BrowserOperator 保持独立运行。

## 本机数据

- Windows：`~/.dsh/webbridge/tunnel-config.enc` 保存 DPAPI 加密的隧道配置与 Runtime Key。
- macOS：登录钥匙串中服务名为 `DSH WebBridge` 的条目保存配置与 Runtime Key，账号由本地配置路径的 SHA-256 生成，不另写明文配置文件。首次访问可能需要解锁或允许访问钥匙串；不要把 Windows 的 DPAPI 文件当作可跨平台迁移的密钥。
- `~/.dsh/webbridge/tunnel-runtime`：当前平台的官方隧道程序、cloudflared 及许可证。
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
