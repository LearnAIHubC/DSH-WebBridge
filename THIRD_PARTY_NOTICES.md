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
