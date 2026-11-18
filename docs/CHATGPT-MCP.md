# 从 ChatGPT 连 DSH（MCP 连接器）

> 以下为早期公网隧道的历史记录。当前版本使用 OpenAI Secure MCP Tunnel，配置入口与步骤见 [ChatGPT 设置](CHATGPT-SETUP.md)；不需要运行本文的旧隧道脚本。

**已实测通过（2026-11-16）**：ChatGPT 自定义 MCP 服务器 → 公网隧道 → 本机 DSH，
`webbridge_status` 调用成功（417ms），返回内容被正确渲染成表格。

## 当前可用地址

完整连接器 URL（含 key）写在：
`%USERPROFILE%\.dsh\webbridge\connector-url.txt`

- 隧道：localhost.run（免费，域名会变）
- 本地监听：`127.0.0.1:17877`
- 令牌：`~/.dsh/webbridge/mcp-token.key`
- 调用日志：`~/.dsh/webbridge/mcp.log`

## 在 ChatGPT 里创建（服务器 URL 建好后不可改，只能删了重建）

1. <https://chatgpt.com/plugins> → 右上「添加」→ 添加自定义 MCP 服务器
2. 名称随意；URL 粘 `connector-url.txt` 的内容
3. 身份验证选 **无需身份验证**（key 在 URL 里），勾选风险确认，创建
4. 创建后点「连接 WebBridge DSH」
5. 新对话里点 `+` 选中插件（出现 chip），再写提示词

## 实测记录

```
mcp.log: 2026-11-16T14:19:22.398Z ok   webbridge_status 417ms
```

ChatGPT 的回答里正确列出了 Daemon Health / MCP Port / Browser Profile / Adapter，
并报告当前页面是 chatgpt.com。

## 隧道守活

```powershell
node scripts/tunnel.mjs
```

它断线自动重连，并把当前地址写回 `tunnel-url.txt` / `connector-url.txt`。
Host 白名单已放开 `*.lhr.life`，换域名不需要改插件配置，只需要在 ChatGPT 里更新连接器 URL。

## 想要固定地址

- Cloudflare named tunnel + 自有域名（推荐）
- VPS + Caddy + Let's Encrypt + ssh 隧道
- 纯 IP 不可行：ChatGPT 要求 HTTPS 且校验证书，给 IP 签公网证书拿不到。
