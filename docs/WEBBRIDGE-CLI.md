# WebBridge CLI（外部 AI 的浏览器接口）

`scripts/webbridge-cli.mjs` 通过 WebBridge 插件**正在运行的 MCP 端点**驱动同一个浏览器
（就是登录了各网页模型的那个），把排错、探索、模板生成收敛成几个固定命令。外部 AI
只需要这一个 CLI，不用再为每个问题拼装临时的查看手段。

```bash
node scripts/webbridge-cli.mjs <命令> [参数]
```

前置：插件已加载、MCP 端点已启动（`webbridge_mcp` status 查看；默认 `127.0.0.1:17877`，
令牌自动读 `~/.dsh/webbridge/mcp-token.key`）。可用 `WEBBRIDGE_MCP_URL` 覆盖地址。

## 命令

| 命令 | 用途 |
| --- | --- |
| `status` | 驱动器、各站登录徽章、隧道、MCP 状态 |
| `open <site\|url> [--headed]` | 打开站点预设或任意 URL |
| `pages` / `state` | 打开的页面列表 / 当前页状态 |
| `console [--n 30] [--filter x] [--errors] [--clear]` | 页面控制台 |
| `network [--n 30] [--filter x] [--type xhr] [--errors] [--clear]` | 页面网络请求 |
| `debug [--pageId id]` | 汇总（状态+控制台+网络+截图路径），生成期只读可用 |
| `screenshot [path]` | 截图 |
| `eval '<js>'` | 在当前页面执行表达式（探索的万能出口） |
| `explore` | 一条命令的页面体检：输入框、发送键、停止键、回复区、登录墙、模型码，每个候选带唯一选择器 |
| `probe <site>` | 按现有适配器探测页面（inputFound / assistantNodes） |
| `annotate <site> start\|read [--save]` | 标注校准：有头窗口框选 → 读出唯一选择器 → 保存 |
| `ask <site> '<消息>' [--timeout ms]` | 端到端发送测试（**真实发出**，消耗账号额度） |

## 分工（重要）

CLI 只负责**探索与执行**：`explore` 报告"哪个元素是哪个元素"（每个候选带唯一选择器），
`console` / `network` / `eval` 帮你查证，`ask` 帮你做端到端测试。**模板由 AI 或人编写**：
读 `explore` 的证据 → 判断哪个是输入框/发送键/回复区 → 通过 DSH 的 `webbridge_adapter`
（save）保存。CLI 本身不生成、不保存模板——判断责任在决策者，不在工具。

## 典型工作流

**排错"某站点发不出去"**（bigmodel 的实际案例，三步）：

```bash
node scripts/webbridge-cli.mjs open bigmodel
node scripts/webbridge-cli.mjs explore          # 读证据：哪个是真实发送键
# → AI 判断后通过 webbridge_adapter save 保存选择器
node scripts/webbridge-cli.mjs ask bigmodel "连通性测试：请回复收到"   # 端到端验证
node scripts/webbridge-cli.mjs console --errors  # 还不行看控制台/网络
```

## 边界与安全

- 令牌只在本机文件，CLI 不打印它；`eval` 在页面里执行任意 JS，请只对自己信任的页面用；
- 生成期（DSH 正在等某个网页回复）只读命令照常可用（console/network/pages/debug/state），
  驱动类命令（open/eval/click/ask）会收到 `browser-busy`，等生成结束再试；
- `ask` 会真实消耗网页账号额度；`template --save` 会把当前页推导的选择器标为 verified 覆盖
  该站适配器，发送验证不通过就用 `annotate` 框选修正。
