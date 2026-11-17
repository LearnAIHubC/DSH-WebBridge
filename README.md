# DSH-WebBridge

把已登录的 ChatGPT 网页会话接入 DeepSeek Harness（DSH）。DSH 发送用户输入，插件读取网页生成中的正文并持续同步；网页真实调用 Nexus DSH 的 MCP 工具时，DSH 记录对应工具卡片。

当前版本支持 Windows 和 macOS（Apple 芯片 / Intel）、Google Chrome、DSH 0.2.2-rc.3。macOS 实机验证使用 Apple 芯片；Intel 安装包选择有回归测试，尚未在 Intel Mac 上实测。付费账号的模型和推理等级从网页动态读取；免费账号保留思考与非思考。

## 安装与设置

1. 克隆此仓库，安装 Node.js 22 或更新版本，以及 Google Chrome。
2. 在项目目录运行 `npm ci` 和 `npm run build:client`。
3. 在 DSH 插件管理中加载项目目录。
4. 打开「设置 → ChatGPT 网页版」，在 WebBridge 自己的浏览器窗口中手动登录 ChatGPT 与 OpenAI 控制台。
5. 点击「连接隧道」。插件创建或复用 OpenAI Secure MCP Tunnel，并配置 Nexus DSH 网页插件。
6. 在 DSH 会话中选择「ChatGPT 网页版」。免费账号提供思考和非思考两种模式。

macOS 桌面版也可以用安装包自带的命令加载本地插件：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$PWD"
```

在仓库目录执行。桌面版命令使用与 App 一致的 DSH 运行时；另装的 npm `dsh` 不负责管理 `desktop` profile。安装后可在「设置 → ChatGPT 网页版」查看。

详细操作见 [ChatGPT 设置](docs/CHATGPT-SETUP.md)。

## 工作方式

- DSH 模型列表只显示模型名，推理等级在原生下拉框中选择。发送前真实切换网页模型与滑块；设置页可刷新列表。当前会话使用 `webbridge-*` 网页模型时，模型选择器旁会显示「同步」按钮；点击后重建该会话的网页线程，并清掉旧的 DSH 上下文游标和 MCP 会话绑定，下一条消息重新读取完整上下文。
- 「浏览器调试」提供控制台、网络和截图汇总，命令也可通过 `webbridge_browser` 使用 `console`、`network`、`debug`、`pages`。诊断记录有数量限制，不保存请求正文。

- WebBridge 使用自己的 Playwright 持久化 Chrome Context。每个 DSH 会话有独立 Page，同一会话中的请求按顺序执行。
- 默认无头运行；登录由用户在可见窗口完成，确认登录成功后再切回无头。启动 DSH 或切换调试模式不会打开历史会话；网页任务按需打开页面，完成后关闭，续聊时恢复原会话。
- 网页输入框只发送新增用户内容和短初始化引导；完整的 DSH 模型输入通过 `dsh_get_context` 获取，包括系统提示、项目规则、技能与运行环境注入、历史 assistant 消息和工具结果。图片与文件按原文件名和字节上传。
- 正文在生成期间通过 text-delta 进入 DSH。网页的临时轮次 ID、消息 ID 和 Markdown 列表转换均有兼容处理；完成后使用完整网页正文构建 Markdown。
- 默认不设置 90 秒回复期限。停止按钮消失、页面回到空闲后才完成读取；取消、登录或验证错误仍会结束等待。
- 发送顺序是用户文字与上下文引用、加号菜单中的 Nexus DSH、用户附件、发送。ChatGPT 原生 MCP 路径不再上传 `dsh-context.txt`，用户附件不会静默丢弃。兼容路径仍支持系统 TXT，跳过上传时不会把上下文标记为已送达。
- 正式 Runtime Key 使用 Never 有效期。Windows 使用 CurrentUser DPAPI 加密，macOS 使用登录钥匙串；密钥不进入命令参数。连接失败不会反复创建资源；测试 Key 升级时保留 Tunnel ID。
- 工具执行通过 DSH 原执行器，沿用 DSH 的权限与审批机制。网页没有调用工具时，回复直接作为正文显示。

### 上下文初始化与更新

第一轮消息自动携带 `context_id`。网页模型先调用 Nexus DSH 的 `dsh_get_context`，按 `completeness.next_cursor` 读取至 `completeness.complete=true`，再处理用户任务。项目当前工作目录也在结果的 `workspace.cwd` 中；不需要手动把项目地址和系统提示复制到输入框。工具必须在现有 MCP 工具范围内允许使用，插件不会扩大已有 allowlist。

重复注入按来源、作用范围和实际内容计算 SHA-256 指纹；消息 ID、时间和步骤编号变化不会触发刷新。同一目录和相同规则的检查点只排入一次，规则发生变化或进入新的目录范围时再检查。规则改回先前内容仍视为变更。

每次实际模型请求都会保存独立快照，保留最终输入的消息顺序、角色、来源、内容块和工具定义历史。后续轮次可基于网页仍保留的完整快照获取增量；新建聊天、重置网页或旧快照失效时重新读取全量，并恢复需要的用户附件。只发送了网页消息、只读第一页或跳过旧 TXT 上传，都不会被当作初始化成功。

文件 `read`、`write`、`edit` 可能触发 DSH 的目录规则加载。工具完成后，网页会先结束这一轮，让 DSH 正常经过步骤边界并刷新规则，再自动继续同一任务；已完成的工具不会因此要求重做。工具返回的 `additionalContexts` 也会同步交给网页。这个过程可能增加一次网页往返，用于保证后续操作能看到新的有效规则。

这些内容作为 MCP 工具结果进入网页模型上下文，保留其在 DSH 中的来源；它们不会改变 ChatGPT 平台本身的系统消息优先级。上下文只保存在当前插件进程内，插件重载后会在下一次请求重新生成。升级后需要重载 DSH 插件并刷新 Nexus DSH 的工具元数据，确认能看到 `dsh_get_context`。

## 测试

```powershell
npm ci
npm run build:client
npm test
npm run test:smoke
npm run test:browser
```

`npm test` 包含回复轮次、增量、列表重排、格式转换、附件、隧道与 MCP 回归，以及完整上下文分页、增量重建、跨会话隔离、初始化交付和真实步骤续接。浏览器冒烟使用独立临时 Profile，不使用个人账号。

发布前必须在实际 DSH 中验证长回复在生成期间持续显示，不能只凭最终全文或离线测试通过判断。验证记录见 [发布验证](docs/RELEASE-VALIDATION.md)。

## 当前限制

- MCP 同时兼容旧式 `initialize + Mcp-Session-Id` 和 `2026-07-28` 无会话协议。`dsh_get_context.context_id` 是权威路由 handle：旧协议会把它绑定到 MCP session；无会话协议要求后续 DSH 工具在 MCP 参数中带 `dsh_context_id`，MCP 路由后会先剥离该字段，因此真实 DSH 工具仍只收到原业务参数。没有可验证 handle 且同时存在多个 DSH 请求时返回 `ambiguous-tool-scope`，不会猜测目标会话。
- macOS 的系统代理支持 HTTP / HTTPS；PAC 和仅 SOCKS 的配置需要在高级设置中填写 HTTP 代理。Linux 的密钥存储与隧道自动安装尚未实现。
- 页面结构可能改变。选择器可以校准，登录、验证码与站点额度由账号和页面决定。
- `docs` 中早期公网隧道与架构文档保留为开发记录；当前安装步骤以本文及 `CHATGPT-SETUP.md` 为准。

## 本机数据与许可证

账号 Profile、会话登记、日志及加密密钥保存在 `~/.dsh/webbridge/`，不包含在源码或发布包中。插件不读取或修改 Codex BrowserOperator 的 Profile。

项目使用 [AGPL-3.0-only](LICENSE)。Nexus 隧道移植说明、许可证和官方 runtime 来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。发布包不携带 Chrome Profile、密钥或历史代理工具。
