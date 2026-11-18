[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Backup','Verify','Restore')][string]$Action,
    [Parameter(Mandatory)][string]$BackupDirectory,
    [string]$StateDirectory = (Join-Path $env:ProgramData 'HyperVDash\state'),
    [string]$RestoreDirectory,
    [string]$Account,
    [string]$NodePath = (Get-Command node.exe -CommandType Application).Source
)
. (Join-Path $PSScriptRoot 'paths.ps1')
$backup = Resolve-HvPath $BackupDirectory
$sid = if ($Account) { Resolve-HvSid $Account } else { [Security.Principal.WindowsIdentity]::GetCurrent().User }
$files = @('fleet.sqlite','tls\cert.pem','tls\key.pem')
$manifestPath = Join-Path $backup 'manifest.json'

function Assert-Snapshot([string]$Directory, [string]$Mode = 'check') {
    & $NodePath (Join-Path $PSScriptRoot 'check-snapshot.mjs') $Mode $Directory
    if ($LASTEXITCODE) { throw 'Snapshot validation failed. Keep the working state and use another backup.' }
}

if ($Action -eq 'Backup') {
    $state = Resolve-HvPath $StateDirectory
    foreach ($relative in $files) {
        $p = Resolve-HvPath (Join-Path $state $relative)
        if (!(Test-Path -LiteralPath $p -PathType Leaf)) { throw "Required state file missing: $relative" }
    }
    $null = New-HvPrivateDir $backup $sid
    [IO.Directory]::CreateDirectory((Join-Path $backup 'tls')) | Out-Null
    # VACUUM INTO takes a consistent snapshot while the server is running.
    $old = $env:HVDASH_DATA
    try {
        $env:HVDASH_DATA = $state
        & $NodePath (Join-Path (Split-Path -Parent $PSScriptRoot) 'admin.mjs') backup (Join-Path $backup 'fleet.sqlite')
        if ($LASTEXITCODE) { throw 'Database snapshot failed.' }
    } finally { $env:HVDASH_DATA = $old }
    foreach ($relative in $files[1..2]) {
        Copy-Item -LiteralPath (Join-Path $state $relative) -Destination (Join-Path $backup $relative)
    }
    Assert-Snapshot $backup
    $hashes = [ordered]@{}
    foreach ($relative in $files) { $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $backup $relative) -Algorithm SHA256).Hash }
    $meta = [ordered]@{
        format = 1
        createdUtc = [datetime]::UtcNow.ToString('o')
        machine = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid
        credentialOwnerSid = $sid.Value
        sha256 = $hashes
    }
    # Manifest last: a partially copied directory cannot be restored.
    [IO.File]::WriteAllText($manifestPath, ($meta | ConvertTo-Json -Depth 4))
    Write-Output "Verified management backup: $backup"
    return
}

$null = Resolve-HvPath $manifestPath
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.format -ne 1) { throw 'Unsupported backup format.' }
foreach ($relative in $files) {
    $p = Resolve-HvPath (Join-Path $backup $relative)
    $expected = $manifest.sha256.PSObject.Properties[$relative]
    if (!$expected -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne $expected.Value) {
        throw "Backup checksum mismatch: $relative"
    }
}
Assert-Snapshot $backup
if ($Action -eq 'Verify') { Write-Output "Verified management backup: $backup"; return }
if (!$RestoreDirectory) { throw 'Pass -RestoreDirectory pointing to a new state directory.' }
if ($manifest.credentialOwnerSid -ne $sid.Value -or $manifest.machine -ne (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid) {
    throw 'Host credentials use Windows CurrentUser DPAPI. Restore on the original system with its service identity and profile.'
}
# Never replace a live SQLite database or carry old WAL files into a restore.
$dest = New-HvPrivateDir $RestoreDirectory $sid
[IO.Directory]::CreateDirectory((Join-Path $dest 'tls')) | Out-Null
foreach ($relative in $files) {
    Copy-Item -LiteralPath (Join-Path $backup $relative) -Destination (Join-Path $dest $relative)
}
Assert-Snapshot $dest 'restore'
Assert-Snapshot $dest
Set-HvAcl (Join-Path $dest 'tls') $sid ReadAndExecute
Set-HvAcl (Join-Path $dest 'tls\cert.pem') $sid Read
Set-HvAcl (Join-Path $dest 'tls\key.pem') $sid Read
Write-Output "Restored to $dest. Use service.ps1 -Action UseState with the service stopped to activate this copy."
