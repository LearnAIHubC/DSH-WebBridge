# 发布验证

## 0.2.2

验证了动态菜单读取和原生推理等级接口。真实网页读取到十个组合，DSH 只显示两个模型；在所选推理等级下收到了 hi 回复。调试汇总也在运行期间成功读取。

### 浏览器调试设置页

本轮只补充此前未完成的浏览器调试设置页验收。客户端连线检查确认页面选择、记录筛选、只看错误和警告、控制台、网络请求、调试汇总与截图、清空记录均接到 `webbridgeSetup.debug`；截图使用返回的 `data:image/png;base64,...` 直接展示，清空按钮按当前调试类型携带 `clear: true`。

在运行中的 0.2.2 WebBridge 上选择一个非当前会话的已登录 ChatGPT 首页，执行与设置页相同的 `driver.inspect('debug', { pageId, clear: true, limit: 50 })` 链路：console、network、dialogs 三类结果均为 `total: 0`，同时成功生成 PNG 截图。截图实测为 1440×900、78,078 字节；再经过设置服务的截图包装路径验证，成功转换为 `data:image/png;base64,...`，解码后仍为 78,078 字节。截图与清空通过。

macOS 本机未授予 `osascript` 辅助功能权限，因此本轮没有使用系统级鼠标模拟点击 DSH 窗口；验收使用设置页实际调用的同一调试服务/driver 链路，并核对了客户端按钮与截图展示连线。

### 会话同步

新增模型选择器旁的会话同步按钮，使用 DSH 0.2.2 的 `conversation.input.right` 官方 slot，并只在当前选择为 `webbridge-*` provider 时显示。点击会携带当前 DSH `sessionId` 和 provider 调用 `webbridgeSetup.sync`：先重建当前网页会话，再清除 provider 增量游标、该 DSH 会话的 context snapshot/checkpoint，以及所有仍指向该会话的 MCP 路由绑定；下一条消息重新读取完整上下文。

`session-sync-unit` 覆盖同步请求校验、provider 新会话、DSH context 清理、MCP binding 重置、remote 委托，以及生成后的 `client.js` 实际 slot 注册和按钮显示条件。完整单元套件为 208 项（207 通过、1 项 Windows 专用测试跳过、0 失败），浏览器回归 3/3 通过。独立 Browser Operator 访问当前 DSH Web 地址时被 Host 鉴权页拦截，因此没有把“视觉点击”写成已完成；客户端产物的注册与点击 remote 参数已由运行级单测验证。

## 0.2.1 macOS 验证

验证日期：2026-11-17（Asia/Shanghai）。环境：Apple 芯片 Mac、Google Chrome 157、DSH Desktop 0.2.2-rc.3、英文 ChatGPT 网页。

- 通过桌面版自带的 `dsh plugin --profile desktop add` 安装，应用实际加载版本为 0.2.1。
- 登录钥匙串的配置写入、读取、更新及按配置路径隔离通过实机回归；不写本地明文配置文件。Windows DPAPI 检查在 Mac 上跳过。
- 官方 v0.0.14 darwin-arm64 隧道程序经固定 SHA-256 校验后安装，成功执行版本检查；运行中的控制面轮询正常，读取了 macOS 系统 HTTP 代理。
- 英文网页中由程序自动填写 MCP 表单并创建 Nexus DSH，复用已配置的 Tunnel 和 Runtime Key，完成 `full_access` 权限设置、重新读取权限及刷新工具。重试按插件 ID 去重，不重复创建或删除定义。
- DSH 中选择「ChatGPT 网页版」发送 `hi`，收到真实回复。同一会话再通过 Nexus DSH 创建 `~/Desktop/1.txt`；DSH 显示文件编辑卡片，磁盘上确认文件为 2 字节，内容为 `hi`。
- 本地英文 Chrome 回归覆盖 MCP 创建、认证值 `NONE`、菜单含上传入口、内部选项 ID、权限值、固定刷新动作 ID、重复目录链接及不明确控件拒绝。浏览器回归仅使用临时 Profile 和本地页面。

Intel Mac 的安装包选择经过单元测试，尚未在 Intel 硬件上实测。付费账号的模型和思考档位菜单尚未扩展。正式 Key 的首次创建没有为验证而重复执行，保留并复用了本次已创建的资源。

## 0.2.0 Windows 验证

验证日期：2026-11-17（Asia/Shanghai）。环境：Windows、Google Chrome、DSH 0.2.2-rc.3、ChatGPT 免费账号。

## 长回复增量

真实 DSH 测试 `WB_STREAM_NATIVE_20261117_D`：120 条编号回复，共 6,407 字；DSH 持久流记录包含 19 个 text-delta，覆盖 93.160 秒。正文在生成结束前已显示到第 120 条，并收到 `STREAM_NATIVE_DONE`；最终 `turn/end` 为 completed。最终正文包含 120 条，没有临时消息 ID 变更引起的双份全文。

此次修复覆盖了三个实际复现的问题：生成阶段缺少消息 ID 导致轮次绑定失败；Markdown 将临时的 `007.` / `063` 转换为正常编号导致前缀比较中断；临时正文段获得正式 ID 后被重复拼接。

## 其他检查

| 项目 | 结果 |
| --- | --- |
| `npm test` | 98 项通过 |
| 离线冒烟 | 11 项通过 |
| 会话恢复与隔离回归 | 4 项通过 |
| 真实 Chrome Native 冒烟 | 独立 Page、并发导航、完整登记恢复、隐藏输入框、可信停止点击、导航后停止监听通过 |
| 网页停止到 provider 取消 | 真实 Chrome 本地页面，实际 DOM 读取与 provider 输出 ABORTED，并调用目标会话取消，通过 |
| 中途追加输入 | 在当前真实网页回复已生成且被接受的 245 字阶段发送追加用户输入；停止旧请求后收到 `FOLLOWUP_NATIVE_FINAL_OK` |
| 代码与表格格式 | 真实网页 CodeMirror 结构验证；Markdown 表格、列表、嵌套列表、代码围栏、语言、缩进、链接回归通过 |
| 登录 | 原生独立 Profile 由用户手动登录，检测已登录后恢复无头；免费账号状态已识别 |
| 隧道 | 当前已连接；控制面认证与本地 OAuth 401/403 的区分、重连和 DPAPI 回归通过 |
| Key 生命周期 | 原 Tunnel ID 下测试 Key 升级、正式 Key 复用、保存后安装失败重试、提交状态不明时阻止重复创建，单元测试通过 |

## 验证边界

付费模型菜单及其他操作系统未验证。正式 Never Key 的控制台创建流程本次未重新执行，保留当前已配置资源；升级与复用逻辑通过单元测试。

多 Page 可以并发使用。MCP 已覆盖两代协议：旧式 `initialize + Mcp-Session-Id` 用 `dsh_get_context.context_id` 建立连接绑定；`2026-07-28` 的 `server/discover` / 无 session 路径在每个后续 DSH tool call 中使用 `dsh_context_id` 作为显式 handle，并在进入 DSH executor 前剥离。单元回归已覆盖两个活跃 DSH 会话分别通过旧/新协议路由、无 handle 拒绝猜测、stale handle 拒绝以及业务参数不含路由字段。真实双网页会话并发仍需发布前补充现场验收。

发布采用独立导出目录建立干净 Git 历史，保留本机原工作区及原历史。发布内容排除 `.tools`、Chrome Profile、运行日志、会话数据和加密密钥；不推送原有历史中的代理工具与配置。
