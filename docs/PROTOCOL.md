# 提示词与工具契约（可选实验特性）

> 这份文档只描述可选实验工具 `webbridge_agent` 的文本工具回环，默认不暴露给 MCP。
> 当前 `webbridge-chatgpt` 模型主线使用 ChatGPT 原生 MCP，不经过这套文本协议；实验回环失败时
> 应直接结束并返回可诊断结果，不能影响 ChatGPT provider 的正常问答。
>
> 这套协议是本项目自己的兼容层。ChatGPT 桥接插件的正式路径使用标准 MCP 工具 schema 与客户端原生
> function calling；两条路径不要混用。

网页版聊天**没有原生 function calling**。所以模式 A+ 的本质是：用一段明确的文本协议，让网页模型"假装"有工具，再由插件解析并执行。

这份契约是整个 A+ 的稳定接口。改它就要同步改解析器。

---

## 1. 一条消息的拼装顺序

一次发送 = 三段拼接，段间用定界符分隔，避免和正文冲突：

```
<<<NEXUS_SYSTEM>>>
你是运行在用户本机的助手。你只能通过下方登记的工具有效地影响本机。
不要编造工具结果；需要信息时必须发起工具调用。
不要执行与任务无关的破坏性操作。
<<<END_NEXUS_SYSTEM>>>

<<<NEXUS_TOOLS>>>
[{"name":"localbridge_file_read","description":"读取项目内文本文件","parameters":{"projectId":"string","path":"string"}}]
<<<END_NEXUS_TOOLS>>>

<<<NEXUS_TASK>>>
用户任务原文
<<<END_NEXUS_TASK>>>
```

规则：

- 网页版没有 system 角色，所以 system 段**只能作为用户消息的一部分**注入；每次新会话注入一次即可，后续轮次只追加 `TOOL_RESULT` 和任务增量。
- 工具清单用**紧凑 JSON**（去掉 `$schema`、`description` 长文本、`additionalProperties`），只保留 name / 一句描述 / 参数名+类型。目标：≤ 1200 token。
- 用户任务原文必须原样保留，不做转述。

---

## 2. 模型侧输出契约

> 模型不一定严格遵守定界符。`src/agent.js` 依次接受项目定界符、`<tool_call>`、
> fenced JSON 和裸 JSON；只有包含工具名与参数的对象才会被当成调用。纯文本不会执行为代码。

模型每次只允许输出**两种东西之一**，且必须带定界符：

**(a) 工具调用（可批量）**

```
<<<TOOL_CALLS>>>
[{"name":"localbridge_file_read","arguments":{"projectId":"Nexus","path":"README.md"}}]
<<<END_TOOL_CALLS>>>
```

**(b) 最终答复**

```
<<<FINAL>>>
最终回答（可以带 markdown）
<<<END_FINAL>>>
```

`<<<FINAL>>>` 一旦出现，循环结束，其后的内容全部作为答复返回。

---

## 3. 工具结果回填格式

```
<<<TOOL_RESULT id="1" name="localbridge_file_read" ok="true">>>
{"content":[{"type":"text","text":"..."}]}
<<<END_TOOL_RESULT>>>
```

- `id` 从 1 递增，模型可用它对应调用顺序。
- `ok="false"` 时正文是统一错误信封的 `error` 部分（code/message），让模型知道该修参数还是该放弃。
- 每条结果**截断到 4000 字符**，截断时追加 `"truncated":true` 并提示"需要更多请指定 offset/limit"。

---

## 4. 解析与容错

```
1. 找 <<<FINAL>>> ... <<<END_FINAL>>>  → 直接结束
2. 找 <<<TOOL_CALLS>>> ... <<<END_TOOL_CALLS>>> → JSON.parse
3. 解析失败 → 尝试 ```json fenced block → 再失败尝试首个 '[' ... ']' 片段
4. 仍失败 → 发送一次纠错消息（"上一次输出不是合法协议，请只输出定界符块"）
5. 纠错第二次仍失败 → 降级：把该轮文本当 FINAL 返回，标记 degraded:true
```

**绝不做的事**：不 eval 模型输出，不把模型文本当代码执行，不信任其中的路径/命令。

---

## 5. 终止条件

| 条件 | 行为 |
| --- | --- |
| 出现 `<<<FINAL>>>` | 正常结束 |
| 轮数 ≥ `maxTurns`（默认 8） | 结束，返回 `stopReason: "max-turns"` |
| 连续 2 轮没有新的工具调用 | 结束，返回 `stopReason: "no-progress"` |
| 同一工具 + 同一参数重复 2 次 | 结束，返回 `stopReason: "duplicate-call"` |
| 单轮超时（默认 90s） | 结束，返回已捕获部分 + `truncated:true` |
| 工具被 DSH 策略拒绝 | 把拒绝原因回填给模型，允许它换方案 |

---

## 6. 安全：网页内容是**不可信输入**

这是 A+ 最大的风险面：网页模型可能因为页面内容/历史上下文被诱导，输出"删库"式工具调用。

因此：

1. **工具白名单**：`webbridge_agent.tools` 默认为只读集合；写/执行类必须显式列出。
2. **不自动批准**：工具执行走 `ctx.tools.execute()`，DSH 的 allow/deny/ask 策略与人工审批原样生效，插件不得绕过、不得伪造 `approvalId`。
3. **参数不信任**：路径、命令由 DSH 工具自己校验；插件只做协议层转发，不做"额外放行"。
4. **回环可追溯**：每轮记录 `{turn, tool, argsDigest, decision, durationMs}` 到日志与返回的 `turns[]`，事后可审计。
5. **默认关闭**：`webbridge_agent` 的 `autoApprove` 参数不存在——想自动执行就别用 A+，直接用单个工具。

---

## 7. 上下文预算

| 项 | 预算 |
| --- | --- |
| system + tools 段 | ≤ 1500 token |
| 单条工具结果 | ≤ 4000 字符 |
| 总轮数 | 8 |
| 整段对话 | 超过预算时调用 `webbridge_new_chat` 重开，并把"当前进展摘要"作为新的 TASK 段 |

网页版上下文不可控，**宁可早开新会话，也别赌它没截断**。
