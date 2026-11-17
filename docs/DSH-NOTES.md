# DSH 插件 API 实测笔记（0.2.2-rc.3）

这些都是踩过坑才确认的，写下来免得下次重来。

## 1. 链接安装的 bundle 解析不到宿主包

`@local/dsh-webbridge` 以 `link:` 装进 profile，Node 从**真实路径**（`E:\project\...`）解析裸模块名，
找不到 `@deepseek-ai/dsh-tools`：

```
Cannot find package '@deepseek-ai/dsh-tools' imported from E:\project\DSH-WebBridge\index.js
```

结论：**插件不要 import 宿主包**。本项目自带 `src/tool.js` 的 `defineTool` 垫片（做参数校验后交给
`ctx.tools.register`），零依赖。

## 2. `ctx.tools.register(definition)` 的要求

- 必须有 `output: { schema, render }`，`render` 是函数；
- `output.schema` 必须是受支持的 JSON Schema；
- `parameters` 用的是 DSH 的 DSL（`{ name: { type, required, description } }`），不是 JSON Schema；
- 返回值就是**注销函数**，可直接在 `ctx.effect` 的清理里调用。

## 3. `ctx.tools.execute(input)` 的真实形状

```js
await ctx.tools.execute({
  calls: [{ id: 'x', name: 'read', arguments: JSON.stringify(args) }],
  signal,           // 必传！executor 在派发前读 signal.aborted
  // agent,         // 可选：调用某个 agent 作用域
})
```

- **不传 `signal` 会整批失败**（`ToolBatchExecutionError`），不是单条失败；
- 返回的每条结算是 `{ callId, result: { content, isError } }`，**要再取一层 `result`**；
- `content` 是 `[{type:'text',text}]`，有的工具只给 `structuredContent` 或 `value`，渲染要兜底。

## 4. 作用域：Host 插件只能看到全局层

- `ctx.tools.schemas()` 在 root 上下文只返回**全局层**（本机实测 16 个：`working_directory`、`team_task_*`、`webbridge_*`）。
- `read` / `bash` / `grep` 等在 **agent 作用域**。要通过 `agents` 服务拿：

```js
ctx.inject(['agents'], (scoped) => { agents = scoped.agents })   // 必须用 inject
const agent = agents.list()[0]
agent.ctx.tools.schemas(agent)       // 51 个：要显式把 agent 传进去
agent.ctx.tools.execute({ calls, signal, agent })
```

- **直接读 `ctx.agents` 会抛** `cannot get property "agents" without inject`；
- `agent.ctx.tools.schemas()`（不传 agent）仍返回全局 16 个，必须 `schemas(agent)`。

## 5. 激活自检通道

Host 插件没有好用的控制台，且**不能在本会话调用自己刚注册的工具**（工具表在会话开始时已固定）。
所以插件在 `apply()` 时写 `~/.dsh/webbridge/activation.json`：

```json
{ "version": "0.2.0", "registry": { "globalCount": 16, "totalCount": 51,
  "agentScopes": 3, "sample": [...] }, "mcp": { "status": { "running": true } } }
```

这是唯一可靠的"插件真的加载了吗"证据。插件重载用 `plugin_manager set_bundle` 关→开。

## 6. 网页端模型的工具调用方言（DeepSeek 实测）

即使提示词要求 `<<<TOOL_CALLS>>>`，DeepSeek 仍会输出自己的格式，实测三种：

1. `<tool_call>{"name":...,"arguments":{...}}</tool_call>`
2. DSML：`<｜｜DSML｜｜ invoke name="x"><｜｜DSML｜｜ parameter name="k" string="true">v</…>`
3. 纯文本

解析必须**按结构**（`invoke name=` / `parameter name=`），不能按标记字符。
