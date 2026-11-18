---
site: ChatGPT (Nexus DSH 插件配置)
domain: chatgpt.com
updated: 2026-11-18
confidence: medium
verified_by: webbridge-cli
app: dsh-webbridge-chatgpt-setup
tags: [chatgpt, connector, tunnel, headless]
---

# ChatGPT 网页端 Nexus DSH 插件配置经验（AI 装机专用）

> 本文件是 AI 的操作经验，不是人看的教程。执行工具为 `node scripts/webbridge-cli.mjs`
> （经插件 MCP 端点驱动登录态浏览器）。**不要去读 CHANNEL-AND-API-KEY.md 人版文档。**

## 快速路径

0. 前置：Chrome 已装；插件已加载（`npm ci && npm run build:client` + DSH 插件管理加载）；
   `webbridge_mcp` start（CLI 通道，默认 `http://127.0.0.1:17877/mcp`）。
1. 登录（唯一需要人的步骤）：`open chatgpt --headed` → 用户本人登录 →
   轮询 `status` 直到 `auth.chatgpt = ready`。之后所有步骤**无头**执行
   （`webbridge_debug_mode` false / 默认）。
2. 用户自助项（AI 不代办）：OpenAI 控制台创建 Secure MCP Tunnel + Runtime API Key
   （仅需 Tunnels 的 Read + Use 权限）。AI 负责口头引导，密钥只在 DSH 设置页填写
   （「渠道与 API Key」→ 保存并连接），不进对话。
3. 隧道连通验证：`status` 里 `setup.tunnel.status = connected`。
4. **创建 Nexus DSH 插件（AI 驱动，无头）**：
   a. `open https://chatgpt.com/settings/plugins-settings`（注意：`/settings/apps` 不存在，
      会重定向到 general-settings；真实入口是侧栏 **Plugins**）。
   b. **先查重**：插件列表里若已有「Nexus DSH」（描述含“通过 OpenAI 官方隧道动态调用当前 DSH 会…”），
      跳过创建，直接进第 5 步。
   c. 创建入口：列表底部的 **Plugin Creator** 链接 → 详情页的 `create-plugin` 动作按钮
      （按钮文本含 "create-plugin"，这是 Plugin Creator 插件自身的动作，不是普通表单按钮）。
   d. 向导结构（已实测到步骤清单）：Create a plugin → Choose the capabilities
      （Extensions 等）→ Check the components → Development（Plugin name）→ Finish。
      目标配置：名称 **Nexus DSH**；连接方式 **Tunnel**（选用户的 tunnel）；
      认证 **无需身份验证**；权限 **允许使用所有工具**。
   e. 向导内部字段未逐项实测：走通时按页面提示逐项用 `explore` / `eval` 现场取证，
      再点击对应控件；不要盲选。
5. 工具目录刷新（插件已有时的日常维护）：`/settings/plugins-settings/<插件id>`
   页面上存在内部刷新按钮——按 React props 匹配 `browserPluginSettings.refreshActions`
   定位（src/setup-controls.js 的 `action()` 已实现此逻辑，`webbridge_adapter` 无需重写）。
   刷新后 `status` 的 `toolsRefreshedAt` 应更新。

## 选择器

| 用途 | 选择器 / 定位方式 | 备注 |
| --- | --- | --- |
| 设置入口 | `https://chatgpt.com/settings/plugins-settings` | 不要用 /settings/apps（重定向） |
| 侧栏 Plugins | 可见按钮中 `innerText === "Plugins"` | 已实测 |
| 插件列表项 | 可见 `a, button` 中文本含 `Nexus DSH` 且长度 <200 | 已实测；同时用于查重 |
| Plugin Creator 链接 | 可见链接中 `/Plugin Creator/i` | 已实测 |
| create-plugin 按钮 | 可见按钮中 `innerText.includes("create-plugin")` 取最后一个 | 已实测 |
| 创建向导对话框 | `[role="dialog"]`（取最后一个可见的） | 已实测 |
| 工具刷新按钮 | React props 匹配 `id === 'browserPluginSettings.refreshActions'` | 复用 src/setup-controls.js |
| 登录判定 | `status` 的 `auth.chatgpt` | 插件自带 |

## 结果读取 / 验证

- `status`：`auth.chatgpt = ready` + `setup.tunnel.status = connected` 为基线；
- 插件创建成功后：插件列表出现「Nexus DSH」；DSH 模型菜单出现 `WebBridge · ChatGPT`；
- 向 ChatGPT 发一条要求调用工具的消息，观察是否走原生 connector（出现工具执行卡片）。

## 陷阱

- `/settings/apps` 是不存在的路径：静默重定向到 general-settings，别被骗。
- Plugin Creator 的 create-plugin 是**插件动作按钮**，点击后弹向导而不是普通表单页；
- 向导步骤名（capabilities/components/development/finish）来自步骤清单渲染，
  内部字段随版本变动，**每次走流程先 `explore` 现场取证再操作**；
- 账号里已存在 Nexus DSH 时**不要重复创建**——先查重（快速路径 4b）；
- 登录/验证码永远由用户在可见窗口完成，AI 不代填；密钥只进 DSH 设置页与本机加密存储。

## 空页面/异常兜底

- 选择器失效：`webbridge-cli explore` 取证 → 按 README 的渠道策略规范改 `SITE_PRESETS`
  或 `webbridge_adapter save` 校准；
- 隧道不通：`status` 看 `setup.tunnel.error` 与 `activeProxy`（系统代理下隧道走
  `http://127.0.0.1:7897` 一类本地代理）；
- ChatGPT 页面结构大改：向导步骤清单都找不到时，报告 setup-ui-changed，
  退回人工一次并更新本经验文件。

## 验证记录

- 2026-11-18 webbridge-cli 实测：Plugins 侧栏入口、插件列表、Nexus DSH 已存在条目、
  Plugin Creator 链接与 create-plugin 动作、创建向导对话框及步骤清单（capabilities →
  components → development → finish）。向导内部字段未逐项实测（用户决定不真实跑通）。
  本机 Nexus DSH 已配置且隧道 connected。
