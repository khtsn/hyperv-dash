<#
.SYNOPSIS
Prepares a PC to run Hyper-V Dash: checks the prerequisites and creates the first administrator.
Safe to run again; it only does what is still missing.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\ops\setup.ps1

.EXAMPLE
# From an elevated PowerShell: also install whatever is missing (winget, Windows features).
powershell -ExecutionPolicy Bypass -File .\ops\setup.ps1 -Install
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [string]$AdminName = 'fleet-admin',
    # Default: the "state" folder inside the checkout, so "node server.mjs" needs no environment.
    [string]$DataDirectory = $env:HVDASH_DATA
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$state = if ($DataDirectory) { [IO.Path]::GetFullPath($DataDirectory) } else { Join-Path $app 'state' }
$reboot = $false

function Install-WingetPackage([string]$Id) {
    if (!(Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw "winget is unavailable. Install $Id manually, then run this script again." }
    & winget.exe install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE) { throw "winget could not install $Id (exit code $LASTEXITCODE)." }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

$prerequisites = @(
    @{
        Name    = 'Node.js 24 or later'
        Test    = { (Get-Command node.exe -ErrorAction SilentlyContinue) -and ([int](& node.exe -p "process.versions.node.split('.')[0]") -ge 24) }
        Install = { Install-WingetPackage 'OpenJS.NodeJS.LTS' }
    },
    @{
        Name    = 'Hyper-V with its PowerShell module'
        Test    = { [bool](Get-Command Get-VMHost -ErrorAction SilentlyContinue) }
        Install = {
            if (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) { Install-WindowsFeature Hyper-V -IncludeManagementTools | Out-Null }
            else { Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null }
            $script:reboot = $true
        }
    }
)

$missing = @($prerequisites | Where-Object { !(& $_.Test) })
if ($missing -and !$Install) {
    $missing | ForEach-Object { Write-Host "MISSING  $($_.Name)" }
    Write-Host 'Install these, or run this script from an elevated PowerShell with -Install.'
    exit 1
}
if ($missing) {
    $admin = [Security.Principal.WindowsBuiltInRole]::Administrator
    if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole($admin)) { throw '-Install needs an elevated PowerShell.' }
    foreach ($item in $missing) { Write-Host "Installing $($item.Name)"; & $item.Install }
    if ($reboot) { Write-Warning 'Hyper-V was enabled. Restart Windows, then run this script again.'; exit 3010 }
    $missing = @($missing | Where-Object { !(& $_.Test) })
    if ($missing) { throw ('Still missing after installation: ' + (($missing | ForEach-Object { $_.Name }) -join ', ')) }
}
Write-Host 'Prerequisites OK.'

if ($DataDirectory) { $env:HVDASH_DATA = $state }
Push-Location $app
try {
    # Exit code 0 = an account exists, 3 = fresh state. Importing store.mjs creates and secures the state folder.
    & node.exe --input-type=module -e "import {db} from './store.mjs'; process.exit(db.prepare('SELECT 1 FROM users LIMIT 1').get() ? 0 : 3)"
    if ($LASTEXITCODE -eq 3) {
        try {
            while (!$env:HVDASH_ACCOUNT_PASSWORD) {
                $first = [Net.NetworkCredential]::new('', (Read-Host "Password for '$AdminName' (14+ characters)" -AsSecureString)).Password
                $again = [Net.NetworkCredential]::new('', (Read-Host 'Repeat the password' -AsSecureString)).Password
                if ($first -ceq $again) { $env:HVDASH_ACCOUNT_PASSWORD = $first } else { Write-Host 'The passwords differ. Try again.' }
            }
            & node.exe admin.mjs init $AdminName
            if ($LASTEXITCODE) { throw 'Dashboard initialization failed.' }
        } finally { Remove-Item Env:HVDASH_ACCOUNT_PASSWORD -ErrorAction SilentlyContinue }
    } elseif ($LASTEXITCODE) { throw 'Could not open the dashboard state.' }
    else { Write-Host "Already initialized: $state" }
} finally { Pop-Location }

Write-Host ''
Write-Host 'Ready. Start the dashboard from the checkout:'
if ($DataDirectory) { Write-Host "  `$env:HVDASH_DATA = '$state'" }
Write-Host '  node server.mjs'
Write-Host 'Then open https://127.0.0.1:8722 and sign in.'
