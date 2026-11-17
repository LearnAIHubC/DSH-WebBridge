# 技术方案

> 对应 DSH `0.2.2-rc.3`，`desktop` profile。
> WebBridge 自主管理 Chrome；迁移 [BrowserOperator 的指纹与启动配置](PATTERNS.md)，不依赖其 CLI、daemon 或单活动 Page。

---

## 1. 定位

一个 DSH Host 插件（bundle），提供两组能力：

1. **把网页聊天模型变成 DSH 可调用的"模型端点"**（模式 A / A+）——替代 API，低频、单会话、可接受。
2. **把 DSH 工具通过 MCP 暴露给网页版模型**（模式 B）——让网页版反过来驱动 DSH。

非目标：不做无人值守刷量、不代替登录、不绕过验证码与站点条款。

---

## 2. 分层

```
┌────────────────────────────────────────────────────────────┐
│ DSH Agent（模型）                                          │
│   tools: webbridge_status / open / ask / agent / send ...   │
└───────────────┬────────────────────────────────────────────┘
                │ ctx.tools.register(defineTool(...))
┌───────────────▼────────────────────────────────────────────┐
│ plugin: dsh-webbridge (Host, Node)                          │
│                                                             │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ ChatSession  │  │ ChatAdapters  │  │ ToolLoop (A+)    │  │
│  │ 状态机/队列   │──│ 选择器+判据   │──│ 提示词/解析/回填  │  │
│  └──────┬───────┘  └───────────────┘  └────────┬─────────┘  │
│         │                                      │             │
│  ┌──────▼───────┐                      ┌───────▼─────────┐  │
│  │ BrowserDriver│                      │ McpServer (B)   │  │
│  │ Playwright   │                      │ :17877/mcp      │  │
│  └──────┬───────┘                      └───────┬─────────┘  │
└─────────┼──────────────────────────────────────┼────────────┘
          │ Playwright API                        │ ctx.tools.execute()
┌─────────▼─────────┐                  ┌─────────▼────────────┐
│ Chrome Context    │                  │ DSH 工具执行管线      │
│ 多个独立 Page     │                  │ 策略/审批/审计照常    │
└───────────────────┘                  └──────────────────────┘
```

**关键约束**：模式 B 的每一次外部调用都必须走 `ctx.tools.execute()`，不得绕过 DSH 的 allow/deny/ask 策略与审批。否则就是把 DSH 的全部工具无鉴权地开到公网。

---

## 3. 模块与文件（实现阶段）

```
src/
├─ index.ts            # apply(ctx, config)：注册工具/服务，生命周期
├─ config.ts           # Config schema（Schema 校验）
├─ driver.ts           # BrowserDriver：封装 browser CLI（open/click/fill/press/query/eval/snapshot）
├─ session.ts          # ChatSession：发送→等待→读取的状态机与串行队列
├─ detect.ts           # 完成检测：MutationObserver 探针 + 三重投票
├─ adapters/
│  ├─ index.ts         # adapter 加载/保存（~/.dsh/webbridge/adapters/<domain>.json）
│  ├─ generic.ts       # 配置化选择器（默认）
│  ├─ chatgpt.ts       # 预设
│  └─ deepseek.ts      # 预设
├─ tools/
│  ├─ status.ts        # webbridge_status
│  ├─ open.ts          # webbridge_open
│  ├─ ask.ts           # webbridge_ask
│  ├─ send.ts          # webbridge_send / webbridge_read
│  └─ loop.ts          # webbridge_agent（A+ 工具回环）
├─ mcp/
│  ├─ server.ts        # Streamable HTTP MCP（initialize/tools/list/tools/call）
│  └─ expose.ts        # 工具白名单 → MCP schema 映射
└─ util/
   ├─ envelope.ts      # 统一成功/失败信封
   └─ log.ts
```

---

## 4. 对 DSH 暴露的工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `webbridge_status` | — | 浏览器/daemon/站点/登录态/当前 adapter |
| `webbridge_open` | `site?`, `url?`, `headed?` | 打开站点（复用 profile），必要时切 headed |
| `webbridge_ask` | `message`, `site?`, `newChat?`, `timeoutMs?` | 发一条消息并等待完整回复 |
| `webbridge_send` | `message`, `site?` | 只发送，不等待（配合 read） |
| `webbridge_read` | `sinceIndex?`, `timeoutMs?` | 读最后一条回复 / 增量 |
| `webbridge_agent` | `task`, `tools?`, `maxTurns?`, `autoApprove?` | A+：让网页模型按协议调用 DSH 工具跑多步 |
| `webbridge_new_chat` | `site?` | 新开会话（控上下文） |
| `webbridge_adapter` | `site`, `inputSelector?`, `sendSelector?`, `messageSelector?`, `save?` | 查看/校准/保存站点适配器 |
| `webbridge_debug_mode` | `enabled` | 打开/关闭全部 WebBridge 页面可视调试模式 |
| `webbridge_browser` | `action`, `selector?`, `text?`, `expression?` | 低级逃生口（直接透传浏览器原语） |

参数规则写在各参数描述里；工具描述只说"做什么、返回什么"，不重复策略。

---

## 5. 配置

```ts
export const Config = Schema.object({
  browserProfileDir: Schema.string().default("~/.dsh/webbridge/chrome-profile"),
  debugMode: Schema.boolean().default(false),
  site: Schema.string().default("chatgpt"),
  replyTimeoutMs: Schema.number().default(90000),
  pollIntervalMs: Schema.number().default(250),
  stableSamples: Schema.number().default(3),
  adapterDir: Schema.string().default("~/.dsh/webbridge/adapters"),
  mcp: Schema.object({
    enabled: Schema.boolean().default(false),
    port: Schema.number().default(17877),
    token: Schema.string().default(""),
    allowTools: Schema.array(Schema.string()).default([...只读白名单...]),
    requireApproval: Schema.boolean().default(true),
  }),
})
```

凭据（MCP token）按 `references/configuration.md` 的方式保存，不写进插件代码或对话。

---

## 6. 两条链路时序

### 模式 A：`webbridge_ask`

```
1. 工具被调用 → 校验参数 → 取/建 ChatSession(site)
2. driver.open(site.url)（若未打开/不在该页）
3. manualAuth 检查：需要登录 → 切 headed → 返回 auth-required（不阻塞）
4. driver.fill(inputSelector, compose(message))  → driver.press("Enter")
5. 轮询 detect：最后一条消息文本 + streaming 指示 + mutations
6. 判定完成 → 返回 { reply, elapsedMs, truncated, messageIndex }
7. 失败 → 统一信封（code/diagnosis/screenshot/console/network）
```

### 模式 A+：`webbridge_agent`

```
1. 组装 [系统提示][工具提示][任务]（见 PROTOCOL.md）
2. 发送 → 读取回复 → 解析 <<<TOOL_CALL ...>>>
3. 校验工具名在允许集合内 → ctx.tools.execute(单条调用)
4. 把结果压成 <<<TOOL_RESULT ...>>> 追加回填 → 再发送
5. 直到 <<<FINAL>>> / maxTurns / 无进展 → 返回 { final, turns[] }
```

### 模式 B：MCP

```
1. 插件启动 McpServer（默认关）→ 127.0.0.1:17877/mcp，Bearer token
2. Cloudflare Tunnel（或用户自有反代）暴露为 https://<host>/mcp
3. 网页版（ChatGPT）添加连接器 → tools/list 看到白名单工具
4. 模型调用 → 插件校验 token/白名单/参数 → ctx.tools.execute() → 策略与审批照常
5. 返回结果；拒绝调用不在白名单内的工具
```

---

## 7. 里程碑

| 阶段 | 交付 | 验收标准 |
| --- | --- | --- |
| **M0** | bundle 骨架 + `webbridge_status` | 装上后 Plugins 出新行，新会话能调用 status 并拿到版本/路径 |
| **M1** | BrowserDriver + `open` + `ask`（chatgpt adapter） | 在已登录 profile 上发一句"1+1"，拿到 `2`，耗时 < 30s |
| **M2** | 通用 adapter + 完成检测 + 统一错误信封 | 改坏选择器能看到 `input-not-found` + 截图；站点改版 10 分钟内修好 |
| **M3** | A+ 工具回环 | 让网页模型执行"读某个文件并总结"，能连续 3 轮工具调用不出格式错 |
| **M4** | MCP server + 隧道 + 白名单 + 审批 | 网页版能列出并调用 1 个只读工具；非白名单工具 403 |
| **M5** | Web UI 面板（可选） | 面板显示会话状态、最后回复、开关 MCP |

每个阶段完成后单独交付、单独验证，不合并。

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 网页版风控判定自动化 | 账号受限、验证弹窗 | 低频、持久 profile、稳定指纹、headed 人工验证；失败即停并提示 |
| DOM 改版 | 发送/读取失效 | adapter 配置化 + snapshot 自动建议 + 失败截图；不做硬编码深层选择器 |
| 回复完成误判 | 半截答案 / 空等 | 三重投票 + 超时返回 partial + `truncated` 标记 |
| 上下文超限 | 发送失败或模型截断 | `webbridge_new_chat` + 每轮回填截断（见 PROTOCOL） |
| 公网暴露 MCP | 远程执行 DSH 工具 | 强制 token、默认只读白名单、`ctx.tools.execute` 走审批、可一键关闭 |
| 依赖 skill 路径 | 换机器即失效 | `driverPath` 可配置；缺省时给出可操作的错误信息和安装提示 |
| 模型不守协议 | A+ 解析失败 | 严格 JSON 优先 + 宽松修复 + 失败要求重述一次，仍失败则降级为纯问答 |

---

## 9. 验证方法

- **M0**：`plugin_manager install_bundle` 后看 `application: applied`，新会话调 `webbridge_status`。
- **M1**：`webbridge_open` → 人工登录一次 → `webbridge_ask "只回复数字：1+1"`。
- **M2**：故意把 `inputSelector` 改错，确认返回结构化错误而不是抛异常。
- **M3**：`webbridge_agent` 任务里包含一次写文件，确认 DSH 审批弹窗仍然生效。
- **M4**：`curl` 打 MCP 端点验证 `initialize`/`tools/list`；再用网页版调用一次。
