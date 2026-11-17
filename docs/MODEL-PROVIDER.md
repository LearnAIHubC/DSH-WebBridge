# 把网页版模型注册成 DSH 模型（provider 适配器）

目标：在 DSH 的模型选择器里出现两个"模型"，像普通模型一样用：

| provider id | 大脑 | 工具 |
| --- | --- | --- |
| `webbridge-deepseek` | DeepSeek 网页版 | 通过 A+ 文本协议调用 DSH 工具（可选） |
| `webbridge-chatgpt` | ChatGPT 网页版 | ChatGPT 那边挂着我们的 MCP 连接器，工具就是 DSH 的工具 |

两者共用同一套浏览器驱动，只是"站点/账号"不同——相当于给 provider 配不同的账号。

## 已确认的宿主接口（从安装版反查，非猜测）

来源：`@deepseek-ai/dsh-llm` 的 `LlmAdapter` 基类（`lib/index.js`）与
`dsh-opencode-go` 的注册方式（`lib/index.js:8198`）：

```js
// 注册（幂等失败：同一 route 重复注册抛 DUPLICATE_ADAPTER）
const handle = ctx.llm.registerAdapter(['webbridge-deepseek'], adapter)
handle.replace(['webbridge-deepseek'])   // 目录刷新
handle()                                  // 注销
```

适配器需要实现/覆写：

| 方法 | 作用 |
| --- | --- |
| `providerInfo(provider)` | 返回 `{ id, name, ... }`，id 必须等于 route |
| `listModels(provider)` | 返回可被 GUI 选择的模型目录（不实现 = GUI 里选不到） |
| `resolveModel(provider, model, signal)` | 模型元数据：上下文长度、是否支持工具、reasoning 档位 |
| `prepareCall(provider, model, signal)` | 返回 `{ model, stream(options) }`，把"元数据 + 本次调用的 stream"绑定到同一代配置 |
| `stream(options)` / `generate(options)` | **async generator**，逐个 yield chunk；`options` 里有 `{provider, model, messages, tools?, signal, sessionId?}` |
| `providerRetryPolicy(provider)` | 可选，重试策略 |
| `imageRequestPricing/Target` | 可选，图片计价/缩放 |

还有 `ctx.llm.registerModelDiscovery(name, async (request, signal) => ...)` 用于动态发现模型。

## 还差的一块（下一步要确认）

`stream()` 产出的 **chunk 词表**：文本增量、工具调用增量、用量、结束原因分别长什么样。
找到的最接近的参考是 `@deepseek-ai/dsh-llm-deepseek` 的 `generate(options, connection)`：

```js
async *generate(options, connection) { ... yield next.value ... }
```

它消费 `options.messages`（含 tools）并 yield 事件；事件类型定义在 dsh-llm 的类型里。
下一步：在 `dsh-llm-deepseek` 里定位一个完整的 yield 序列（文本 delta + 结束 + usage），
照着映射我们的网页回复即可。

## 实现草案（不依赖浏览器以外的假设）

```
plugin: @local/dsh-webbridge
  ├─ provider: webbridge-deepseek   → ChatSession(deepseek)  → 拼 prompt → 读 DOM 回复
  └─ provider: webbridge-chatgpt    → ChatSession(chatgpt)   → 拼 prompt → 读 DOM 回复
```

一次 `stream()` 的处理：

1. 把 `options.messages` 压成一条消息：system + 历史 + 最后用户消息（网页版没有 system 角色，
   只能在首条注入，见 `docs/PROTOCOL.md`）。
2. 如果 `options.tools` 非空：把工具表按 A+ 协议注入，并把回复里的 `<<<TOOL_CALLS>>>` /
   `<tool_call>` / DSML invoke 解析成 **tool_call chunk**，让 DSH 的 agent loop 去执行。
3. 没有工具或模型直接给出文本：按文本增量 yield，最后 yield 结束块。
4. 超时/登录态/风控：抛出 `LlmError` 风格的错误码（`AUTH_REQUIRED` / `TIMEOUT` / `TRANSPORT`），
   让 `dsh-llm-retry` 与 UI 能正常处理。

## 验收标准

1. 模型选择器里出现 `DeepSeek (网页版)` 与 `ChatGPT (网页版)` 两项。
2. 选中后发一句"只回复两个字：收到"，聊天里出现模型回答。
3. 开启工具后，能完成一次 `read` 工具调用并继续回答（agent loop 不崩）。

第 1、2 步是"可用"的底线；第 3 步是"能干活"。
