# BrowserOperator 经验迁移记录

参考实现：本机 `~/.dsh/skills/browser-operator/scripts/browser.mjs`。
当前 WebBridge 实现：`src/driver.js` + `src/browser-fingerprint.js`。

BrowserOperator 继续供 Codex 使用；WebBridge 不再启动、修改或共享 BrowserOperator 的 Profile。迁移的目标是保留成熟的 Chrome 配置与指纹，同时去掉其“单活动 Page”限制。

## 已迁移的浏览器配置

当前机器 BrowserOperator 的 `webbridge` Profile 配置已读取并迁移：

- fingerprint seed、platform、vendor、WebGL vendor/renderer
- Canvas noise、Audio noise、WebGL 模式、Navigator override、DevTools fix
- Chrome 版本（启动时从本机 Chrome 安装目录重新探测）
- UA 与 UA-CH（通过 CDP `Emulation.setUserAgentOverride`）
- `--disable-blink-features=AutomationControlled`、`--no-first-run`、`--no-default-browser-check`、`--disable-infobars`、`--disable-dev-shm-usage`、`--ignore-certificate-errors`
- 1440×900 viewport、locale、timezone、downloads 与 HTTPS 证书行为
- headed/headless 共用同一份 UA 与 fingerprint

WebBridge 不修改 BrowserOperator 的源码、配置或现有登录 Profile。新的持久化目录为 `~/.dsh/webbridge/chrome-profile`，因此首次需要在 WebBridge 自己的登录窗口中登录一次。

## 多 Page 会话模型

- 一个持久化 Chrome Context。
- 每个 DSH 会话一个独立 Page，映射写入 `~/.dsh/webbridge/sessions.json`。
- 同一会话通过独立 Promise queue 串行执行；不同会话可并行执行。
- 插件初始化时恢复已登记的会话页面及其 URL。
- 页面关闭或 Context 重启后，按登记表重建 Page。

## 显示模式

- 默认 Headless。
- 登录操作可临时请求 Headed；检测到登录完成后，切换回 Headless 并恢复登记页面。
- `webbridge_debug_mode({ enabled: true })` 持久开启调试模式，所有 WebBridge 页面均以 Headed 启动。
- `webbridge_debug_mode({ enabled: false })` 关闭调试模式并恢复 Headless。
- 切换调试模式时如有正在运行的请求，会返回 `browser-busy`，避免关闭其他会话正在使用的 Page。

## 保留的上层设计

站点适配器、回复完成检测、会话状态机、附件处理、MCP 工具回环仍由 WebBridge 自己管理。BrowserOperator 的 MutationObserver 探针、人工登录边界和稳定指纹策略作为设计参考；不再依赖其 daemon、CLI 或单 Page 路由。
