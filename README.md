# DSH-WebBridge

把已登录的 ChatGPT 网页会话接入 DeepSeek Harness（DSH）。DSH 发送用户输入，插件读取网页生成中的正文并持续同步；网页真实调用 Nexus DSH 的 MCP 工具时，DSH 记录对应工具卡片。

当前版本支持 Windows 和 macOS（Apple 芯片 / Intel）、Google Chrome、DSH 0.2.2-rc.3。macOS 实机验证使用 Apple 芯片；Intel 安装包选择有回归测试，尚未在 Intel Mac 上实测。已验证 ChatGPT 免费账号；付费账号的模型菜单尚未验证。

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

- WebBridge 使用自己的 Playwright 持久化 Chrome Context。每个 DSH 会话有独立 Page，同一会话中的请求按顺序执行。
- 默认无头运行；登录由用户在可见窗口完成，确认登录成功后再切回无头。调试模式可以显示窗口。
- 续聊只发送新增用户内容，排除 assistant 消息；图片与文件按原文件名和字节上传。
- 正文在生成期间通过 text-delta 进入 DSH。网页的临时轮次 ID、消息 ID 和 Markdown 列表转换均有兼容处理；完成后使用完整网页正文构建 Markdown。
- 默认不设置 90 秒回复期限。停止按钮消失、页面回到空闲后才完成读取；取消、登录或验证错误仍会结束等待。
- 发送顺序是用户文字、加号菜单中的 Nexus DSH、附件、发送。额度不足时只允许跳过系统 TXT，用户附件不会静默丢弃。
- 正式 Runtime Key 使用 Never 有效期。Windows 使用 CurrentUser DPAPI 加密，macOS 使用登录钥匙串；密钥不进入命令参数。连接失败不会反复创建资源；测试 Key 升级时保留 Tunnel ID。
- 工具执行通过 DSH 原执行器，沿用 DSH 的权限与审批机制。网页没有调用工具时，回复直接作为正文显示。

## 测试

```powershell
npm ci
npm run build:client
npm test
npm run test:smoke
npm run test:browser
```

`npm test` 包含回复轮次、增量、列表重排、格式转换、附件、隧道与 MCP 回归。浏览器冒烟使用独立临时 Profile，不使用个人账号。

发布前必须在实际 DSH 中验证长回复在生成期间持续显示，不能只凭最终全文或离线测试通过判断。验证记录见 [发布验证](docs/RELEASE-VALIDATION.md)。

## 当前限制

- 多个网页请求同时活跃时，官方 MCP 来访请求尚无经过验证的 DSH 会话标识。DSH 工具调用会返回 `ambiguous-tool-scope`，避免在错误会话中执行。需要工具的网页任务请串行运行；多 Page 隔离与恢复已单独测试。
- macOS 的系统代理支持 HTTP / HTTPS；PAC 和仅 SOCKS 的配置需要在高级设置中填写 HTTP 代理。Linux 的密钥存储与隧道自动安装尚未实现。
- 页面结构可能改变。选择器可以校准，登录、验证码与站点额度由账号和页面决定。
- `docs` 中早期公网隧道与架构文档保留为开发记录；当前安装步骤以本文及 `CHATGPT-SETUP.md` 为准。

## 本机数据与许可证

账号 Profile、会话登记、日志及加密密钥保存在 `~/.dsh/webbridge/`，不包含在源码或发布包中。插件不读取或修改 Codex BrowserOperator 的 Profile。

项目使用 [AGPL-3.0-only](LICENSE)。Nexus 隧道移植说明、许可证和官方 runtime 来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。发布包不携带 Chrome Profile、密钥或历史代理工具。
