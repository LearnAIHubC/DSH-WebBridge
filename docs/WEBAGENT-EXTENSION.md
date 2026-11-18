# WebAgent 扩展（third_party/webagent）—— 可选组件

> **现在这是可选路线。** 品牌版 Google Chrome 136+ 无法自动加载未打包扩展（本机 157 实测：`--load-extension` 被忽略、预写 Preferences 无效），插件内置的站点适配 + `webbridge_adapter annotate` 标注校准是零安装的默认路线。本文件夹保留给两类场景：把 `browserExecutablePath` 指到 Edge/Chromium（它们仍认 `--load-extension`，驱动会自动带上本扩展，零手动）；或在 Chrome 里手动装一次（下方步骤），装进持久 Profile 后每次无头启动同样自动生效。

这个文件夹是从 [webagent](https://github.com/ysunyang4/webagent) 1.3.2（commit 6324b71）整体打包进来的浏览器扩展，GPL-3.0-only，LICENSE 保留在文件夹里。它让扩展支持的网页模型把 ```nexus 代码块里的工具调用转交给本机 MCP——也就是本插件的 MCP 端点。支持的站点清单见上游 `manifest.json`。

相对上游的改动只有三处：

- `mcp-client.js` / `popup.js`：本地端口白名单加了 **17877**（本插件 MCP 的默认端口）。
- `content.js` / `manifest.json`：补齐上游 1.3.3 新增站点的适配。
- `manifest.json`：删掉了 chatgpt.com / openai.com 的匹配，保证它不会出现在你现有的 ChatGPT 网页流程里。

## 为什么需要手动装一次

Google Chrome 136 起不再认 `--load-extension`（本机 157 实测确认：开关在命令行里、扩展一个都不加载），往 Profile 的 Preferences 里预写扩展条目也无效。"启动自动注入"在品牌版 Chrome 上已经不存在了；但扩展一旦装进 Profile，走的就是 Chrome 自己的常规加载，之后每次启动（包括无头）都自动带着——只需要装这一次。如果把 `browserExecutablePath` 指到 Edge 或 Chromium（它们还认这些开关），则是零手动。

插件每次启动浏览器前会把打包副本部署到固定路径 `~/.dsh/webbridge/webagent-extension`（仓库挪位置不受影响），手动安装就指这个路径。

## 首次安装步骤

1. 开有头模式：DSH「设置 → WebBridge → 浏览器调试」打开，然后随便触发一次浏览器操作（例如 `webbridge_open`），让 Chrome 窗口弹出来。
2. 在弹出的 Chrome 窗口新开标签页，进入 `chrome://extensions`，打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择目录 `~/.dsh/webbridge/webagent-extension`。
4. 点工具栏里的扩展图标打开弹窗：MCP 服务基址填 `http://127.0.0.1:17877`；Bridge Token 填 `~/.dsh/webbridge/mcp-token.key` 文件里的内容（先用 `webbridge_mcp` 的 status 确认端点在跑）；点「保存配置」，再点「检测 MCP 握手」，应显示 🟢 已连接和工具数量。
5. 关掉浏览器调试（回无头）。之后每次无头启动都会自动带着这个扩展。

## 验证

`webbridge_open` 打开扩展支持的任一站点，页面右下角出现 WebAgent 浮动面板即说明内容脚本已在插件的浏览器里运行；也可以用 `webbridge_browser` 的 eval 检查 `document.getElementById('nexus-agent-root')`。

## 它是怎么做 tools/call 的

网页本身不跑 MCP。扩展的 content script 盯着页面：等模型回复文本稳定（连续 3 帧 500ms 轮询不变、且不在生成中）后，从回复里的 ```nexus 代码块解析出 `{"tool":...,"arguments":...}`，经 background service worker 向本机回环的 MCP 端点发 JSON-RPC `tools/call`（Bearer token，白名单端口已含 17877），把返回文本填回网页发送栏（自动执行 / 自动发送默认都关，需在扩展里自行打开）。链路是：网页模型 → 扩展 → 插件 MCP（`webbridge_*` + allowTools 暴露的 DSH 工具）→ DSH 审批执行 → 结果回填网页继续对话。

## 注意

- 部分海外站点需要网络可达；各站点首次使用需在有头窗口登录一次。
- 扩展在它本就支持的站点激活，行为与上游一致；不会触碰 ChatGPT 流程。
- 上游版本间对部分站点适配有增删，这份副本是自维护版本；上游以后改版不会自动同步。
