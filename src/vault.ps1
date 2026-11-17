param([ValidateSet('protect','unprotect')][string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd().Trim()
$plain = $null
try {
  if ($Action -eq 'protect') {
    $plain = [System.Text.Encoding]::UTF8.GetBytes($inputValue)
    $cipher = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($cipher))
  } else {
    $cipher = [Convert]::FromBase64String($inputValue)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
  }
} finally {
  if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
}
