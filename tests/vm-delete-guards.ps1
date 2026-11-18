# Exercises the production host-side guards using fixture files and mocked host
# cmdlets. Remove-VM throws a sentinel to prove validation passed without deletion.
$ErrorActionPreference='Stop'
$ops=@{};. (Join-Path (Split-Path $PSScriptRoot -Parent) 'vm-ops.ps1')
$vmId=[guid]::NewGuid()
$target=[pscustomobject]@{Id=$vmId;Name='fixture';State='Off'}
$other=[pscustomobject]@{Id=[guid]::NewGuid();Name='second';State='Off'}
$base=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('hvdash-delete-check-'+$vmId)))
$folder=Join-Path $base 'hvdash\fixture';$disk=Join-Path $folder 'os.vhdx'; $outside=Join-Path $base 'external.vhdx'
$attached=$disk; $foreign=$null; $checkpoint=$false
function Get-VM {param($Id);if($Id){return $target};return @($target,$other)}
function Get-VMSnapshot {param($VM);if($checkpoint -and $VM.Id -eq $target.Id){[pscustomobject]@{Name='one'}}}
function Get-VMHardDiskDrive {param($VM,$VMSnapshot);if($VM.Id -eq $target.Id){[pscustomobject]@{Path=$attached}}elseif($foreign){[pscustomobject]@{Path=$foreign}}}
function Get-VHD {param($Path);if($Path -eq $outside){return [pscustomobject]@{ParentPath=$disk}};return [pscustomobject]@{ParentPath=$null}}
function Remove-VM {param($VM,[switch]$Force);throw 'fixture: removal point reached'}
$req=[pscustomobject]@{id=[string]$vmId;name='fixture';action='delete';ownership=[pscustomobject]@{id=[string]$vmId;directory=$folder;files=@($disk)}}
function Check([string]$expected){$reason='unexpected success';try{ & $ops.vmApply $req }catch{$reason=$_.Exception.Message};if($reason -notmatch $expected){throw "Guard mismatch: $reason, expected $expected"}}
try{
    [IO.Directory]::CreateDirectory($folder)|Out-Null
    [IO.File]::WriteAllText($disk,'fixture');[IO.File]::WriteAllText($outside,'fixture')
    $target.State='Running';Check 'Shut down';$target.State='Off'
    $checkpoint=$true;Check 'Remove checkpoints';$checkpoint=$false
    $req.ownership.files=@($outside);Check 'outside the recorded VM folder';$req.ownership.files=@($disk)
    $link=Join-Path $base 'linked-root'
    New-Item -ItemType Junction -Path $link -Target (Join-Path $base 'hvdash') | Out-Null
    $req.ownership.directory=Join-Path $link 'fixture';Check 'reparse point';$req.ownership.directory=$folder
    $attached=$outside;Check 'Unrecorded storage';$attached=$disk
    $unexpected=Join-Path $folder 'unknown.vhdx';[IO.File]::WriteAllText($unexpected,'extra')
    Check 'Unexpected content';[IO.File]::Delete($unexpected)
    $foreign=$outside;Check 'Another VM or checkpoint references';$foreign=$null
    Check 'fixture: removal point reached'
    if(!(Test-Path -LiteralPath $disk)){throw 'Guard test removed the test disk unexpectedly.'}
    'Passed VM host-side shutdown, checkpoint, folder, attachment, and differencing parent checks.'
}finally{
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($base.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($base) -eq ('hvdash-delete-check-'+$vmId)) {
        $link=Join-Path $base 'linked-root'
        if([IO.Directory]::Exists($link)){[IO.Directory]::Delete($link,$false)}
        foreach($file in @($disk,$outside,(Join-Path $folder 'unknown.vhdx'))){[IO.File]::Delete($file)}
        foreach($dir in @($folder,(Join-Path $base 'hvdash'),$base)){if([IO.Directory]::Exists($dir)){[IO.Directory]::Delete($dir,$false)}}
    }
}
