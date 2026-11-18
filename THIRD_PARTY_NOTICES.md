# Third-party notices

The OpenAI Secure MCP Tunnel integration is ported from Nexus:
<https://github.com/ysunyang4/Nexus> (local reference: Nexus apps/desktop/src-tauri/src/tunnel.rs,
main.rs and scripts/prepare-windows-tunnel-runtime.ps1).
Nexus is licensed under GNU AGPL version 3; its license is included in
docs/licenses/Nexus-AGPL-3.0.txt. The port preserves its runtime arguments,
CurrentUser DPAPI storage on Windows, proxy separation, health checks and reconnect
delays. The macOS port uses the system Security framework and login Keychain.

The optional OpenAI tunnel runtime is downloaded from
<https://github.com/openai/tunnel-client/releases/tag/v0.0.14> and verified against
the SHA-256 pinned by Nexus on Windows, and the official release digests for
macOS arm64/amd64. Its LICENSE, NOTICE and companion manifest remain with the runtime.

The bundled browser extension in third_party/webagent is WebAgent
<https://github.com/ysunyang4/webagent> at commit 6324b71 (v1.3.2, the last
public release carrying the Zhipu adapters for bigmodel.cn and chatglm.cn),
licensed under GPL-3.0-only; its LICENSE stays inside the folder. Local changes:
the local MCP port allowlist adds 17877 so the extension can reach this
plugin's MCP endpoint; the Z.ai adapter and manifest matches are ported
forward from WebAgent 1.3.3 (commit 0912371); ChatGPT/OpenAI hosts are removed
from the match lists so the extension never runs on the ChatGPT pages this
plugin drives directly.
