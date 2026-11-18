# 把 ChatGPT 网页版注册成 DSH 模型

当前插件只注册一个网页模型 provider：

| provider id | 网页模型 | 工具路径 |
| --- | --- | --- |
| `webbridge-chatgpt` | ChatGPT 网页版 | ChatGPT 原生 MCP → 本地 WebBridge → DSH 工具执行器 |

DeepSeek 网页版 provider、站点预设和 DOM 适配器已移除。配置中遗留的 `site: deepseek` 会在加载时迁移为 `chatgpt`；会话与适配器路径显式传入未知站点会返回 `unknown-site`。

## 宿主接口

来源是安装版 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 基类。这里的 `deepseek-ai` 是 DSH 宿主包命名，不代表插件仍支持 DeepSeek 网页版。

```js
const handle = ctx.llm.registerAdapter(['webbridge-chatgpt'], adapter)
handle.replace(['webbridge-chatgpt']) // 刷新目录
handle()                               // 注销
```

适配器实现以下接口：

| 方法 | 作用 |
| --- | --- |
| `providerInfo(provider)` | 返回 provider 名称与标识 |
| `listModels(provider)` | 构建模型选择器目录；付费账号从网页动态读取模型与推理档位 |
| `resolveModel(provider, model, signal)` | 返回上下文长度、输入模态和推理档位等元数据 |
| `prepareCall(provider, model, signal)` | 把本次模型选择和流式调用绑定到同一代网页配置 |
| `stream(options)` / `generate(options)` | 驱动网页会话并逐个产出 DSH chunk |

## 当前实现

```text
@local/dsh-webbridge
└─ provider: webbridge-chatgpt
   ├─ ChatSession(chatgpt)
   ├─ ChatGPT 原生 MCP（Tunnel）
   ├─ dsh_get_context 上下文初始化与增量更新
   └─ ChatGPT 网页正文流式同步
```

一次模型请求按下面的顺序处理：

1. 解析账号档位与所选网页模型；需要时在发送前切换模型和推理等级。
2. 为每个 DSH session 恢复或新建独立 ChatGPT 会话。
3. 输入框只发送新增用户内容和短 `context_id` 引导；完整系统提示、项目规则、历史和工具目录通过 `dsh_get_context` 读取。
4. ChatGPT 在网页侧通过其桥接插件的原生 MCP 连接调用工具。WebBridge 继续使用 DSH 原执行器，因此权限、审批和工具历史保持不变。
5. 网页生成期间持续产出 `text-delta`；完成后用完整网页正文构建最终文本块。
6. 登录、验证、发送失败、上下文未完整读取或网页停止生成时，返回稳定错误，不把旧回复当成本轮结果。

`webbridge_agent` 仍保留为独立的实验工具，用文本协议运行兼容工具回环；它不是模型选择器中的第二个 provider，也不会恢复任何已删除的站点支持。

## 验收标准

1. 模型选择器只出现 `ChatGPT 网页版` 的 WebBridge provider。
2. 免费账号提供思考和非思考模式；付费账号显示网页实际可用模型与推理档位。
3. 新会话能先完整读取 DSH 上下文，再回答用户输入。
4. 网页 MCP 工具调用能在 DSH 中显示原生工具卡片并遵守原有权限策略。
5. `site: deepseek` 不会注册为网页模型，也不能加载会话适配器。
