# DeepSeek 网页端适配（实测记录）

测量时间：2026-11-16，页面 `https://chat.deepseek.com/`，已登录。
方式：`browser-operator` CLI 读 DOM + 真实输入（`fill` / `press Enter`）。

## 选择器

| 用途 | 选择器 | 说明 |
| --- | --- | --- |
| 输入框 | `textarea` | 全页唯一；placeholder = `给 DeepSeek 发送消息 `；无稳定 id，class 是哈希（`_27c9245 …`） |
| 发送 | `（空）→ Enter` | 回车发送可靠；输入框空时右侧圆形按钮不渲染，有文字后才出现 `div.ds-button--circle.ds-button--primary` |
| 助手消息 | `.ds-assistant-message-main-content` | 语义化 class，实测稳定；父级 `div.ds-message`（class 含哈希） |
| 流式指示 | 无 | 未找到可靠的停止/生成中标记：按钮不换图标、无 `cursor/typing` 节点、无文字标签 |
| 深度思考 | `div.ds-toggle-button`（文本含「深度思考」，选中类 `ds-toggle-button--selected`） | **每个新会话会重置为关闭**，所以发送前必须检查并点开 |

### 深度思考默认开启（已验证）

- 读取：遍历 `div.ds-toggle-button`，取 `innerText` 含「深度思考」的那个，判断 class 是否含 `ds-toggle-button--selected`。
- 点击：**必须用 `text=深度思考`**。实测 `div.ds-toggle-button:has-text("深度思考")` 会报
  `"has-text" engine expects a single string`，而 `text=深度思考` 可以点中，事件冒泡到开关本身。
- 时机：`webbridge_ask` / `webbridge_send` 在**每次发送前**检查一次（新会话会重置），已开则跳过。
- 实测：先手动关掉 → 调用 `webbridge_ask` → 回复正常返回（4.0s），开关变为 `true`。

## 关键陷阱：虚拟列表

消息列表是 `ds-virtual-list-visible-items`。**旧消息会从 DOM 移除**：

- 实测同一会话里已有 3 条助手回复时，`.ds-assistant-message-main-content` 只剩 1~2 个节点；
- 因此"助手节点数 +1"不能作为"新回复到了"的判据，长会话里会永远等不到。

**正确判据**（已写进 `src/detect.js`）：

1. 最后一条助手消息的文本 **不等于** 发送前的基线文本（或节点数确实增加）；
2. 文本连续 `stableSamples` 次采样不变；
3. 若 adapter 声明了 `streamingSelector`，它还必须是"不在流式中"。

## 实测时延

| 场景 | 结果 |
| --- | --- |
| `1+1=?` | 回复 `1+1=2。`，约 1.5s 完成 |
| 800 字任务 | 文本单调增长：68 → 184 → 353 → 512 → 664 → 825 → 952 字符（每 ~450ms 一次采样） |
| `只回复两个字：收到` | 端到端 6.5s（含浏览器命令往返） |
| MCP 通道 `只回复一个字：好` | 通过，回复 `好` |

## 复核方法

页面改版后重跑：

```powershell
node E:\project\DSH-WebBridge\scripts\e2e.mjs "只回复两个字：收到"
```

失败时先用浏览器 CLI 看当前 DOM：

```powershell
node "$env:USERPROFILE\.dsh\skills\browser-operator\scripts\browser.mjs" snapshot --mode interactive --profile webbridge
```

确认新选择器后写回 `~/.dsh/webbridge/adapters/deepseek.json`（或调用 `webbridge_adapter` 的 `save`）。
