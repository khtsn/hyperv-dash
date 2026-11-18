$ErrorActionPreference = 'Stop'
try {
 Add-Type -AssemblyName System.Security
 $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())) | ConvertFrom-Json
 $bytes = [Text.Encoding]::UTF8.GetBytes([string]$data.secret)
 $protected = [Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [Console]::WriteLine('RESULT ' + (ConvertTo-Json ([Convert]::ToBase64String($protected)) -Compress))
} catch { [Console]::WriteLine('ERROR Credential encryption failed under the service account.'); exit 1 }
