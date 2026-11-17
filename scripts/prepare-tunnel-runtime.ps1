# Ported from Nexus scripts/prepare-windows-tunnel-runtime.ps1 (AGPL-3.0).
param([Parameter(Mandatory=$true)][string]$DestinationPath)
$ErrorActionPreference = 'Stop'
$version = 'v0.0.14'
$name = 'tunnel-client-runtime-cloudflared-v0.0.14-windows-amd64.zip'
$downloadUrl = "https://github.com/openai/tunnel-client/releases/download/$version/$name"
$expectedSha256 = 'b225e23bdb3dc33b41ac1e7bd3197b5c9d628508880bee643c1682cd69ee7f9c'
$taskTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$taskTempDir = [System.IO.Path]::GetFullPath((Join-Path $taskTempRoot ('webbridge-tunnel-' + [Guid]::NewGuid().ToString('N'))))
if (-not $taskTempDir.StartsWith($taskTempRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid temporary directory' }
$archive = Join-Path $taskTempDir $name
$extractDir = Join-Path $taskTempDir 'unpacked'
$destination = [System.IO.Path]::GetFullPath($DestinationPath)
$required = @('tunnel-client-runtime-cloudflared.exe', 'cloudflared.exe', 'LICENSE')
try {
  New-Item -ItemType Directory -Path $taskTempDir, $extractDir -Force | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archive -MaximumRedirection 10
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expectedSha256) { throw 'Tunnel archive SHA256 mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
  $contents = @(Get-ChildItem -LiteralPath $extractDir -Recurse -File)
  foreach ($filename in $required) {
    if (-not @($contents | Where-Object { $_.Name -ceq $filename }).Count) { throw "Missing runtime component: $filename" }
  }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  foreach ($file in $contents) {
    if ($file.Name -match '^[A-Za-z0-9._-]+$') { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $destination $file.Name) -Force }
  }
  Write-Output 'Verified OpenAI tunnel runtime v0.0.14 installed.'
} finally {
  if ($taskTempDir.StartsWith($taskTempRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase) -and [System.IO.Path]::GetFileName($taskTempDir).StartsWith('webbridge-tunnel-')) {
    Remove-Item -LiteralPath $taskTempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
