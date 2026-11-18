# Exercises the real named-pipe bridge with a fake VM lookup. Nothing here
# accesses Hyper-V or a guest. The caller creates a local Windows pipe server.
param([string]$Id)
$env:HVDASH_SERIAL_TEST_ID=$Id
function Get-VM { param($Id); if([string]$Id -ne $env:HVDASH_SERIAL_TEST_ID){throw 'Unknown fixture VM.'};[pscustomobject]@{Id=$Id;State='Running'} }
function Get-VMComPort { param($VM,$Number); [pscustomobject]@{Path="\\.\pipe\hvdash-$($VM.Id)"} }
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'console-bridge.ps1')
