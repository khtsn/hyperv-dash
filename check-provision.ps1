# Exercise image integrity on throwaway byte fixtures only. No Hyper-V cmdlets run.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'provision.ps1')
. (Join-Path $PSScriptRoot 'provision-create.ps1')
# Evaluate only the pure frame parser inside the remoted provisioning block.
$node=$sbProvisionCreate.Ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-StatusFrame'},$true)
. ([scriptblock]::Create($node.Extent.Text))
$tail=''
if(Read-StatusFrame "HVDASH:other:done`nHVDASH:demo:fa" ([ref]$tail) 'demo'){throw 'Incorrect report accepted.'}
$frame=Read-StatusFrame "iled:cloud-init timed out`r`n" ([ref]$tail) 'demo'
if($frame -ne 'failed:cloud-init timed out' -or $tail){throw 'Partial serial report not reassembled.'}
$BaseName='debian-13-base.vhdx'
$root=Join-Path ([IO.Path]::GetTempPath()) ('hvdash-check-'+[guid]::NewGuid())
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $base=Join-Path $root $BaseName
    $partial=Join-Path $root 'copy.partial'
    $dest=Join-Path $root 'target.vhdx'
    [IO.File]::WriteAllBytes($base, [byte[]]@(1,2,3))
    $sum=(Get-FileHash $base -Algorithm SHA256).Hash
    [IO.File]::WriteAllText((Join-Path $root 'manifest.json'),([ordered]@{archiveSha512=('e'*128);sha256=$sum;sizeBytes=3;version='fixture'} | ConvertTo-Json -Compress))
    $image=Get-ProvisionImage $root
    if($image.manifest.sha256 -ne $sum){throw 'Valid source image rejected.'}
    [IO.File]::WriteAllBytes($base,[byte[]]@(1,2,4))
    $rejected=$false
    try {$null=Get-ProvisionImage $root} catch {$rejected=$_.Exception.Message -match 'verification failed'}
    if(!$rejected){throw 'Corrupt local base accepted.'}
    [IO.File]::WriteAllBytes($dest,[byte[]]@(1,2,3))
    Copy-Item -LiteralPath $base -Destination $partial
    $params=@{temp=$partial;base=$dest;sha256=$sum}
    $rejected=$false
    try {& $sbInstallVerifiedImage $params} catch {$rejected=$_.Exception.Message -match 'SHA256 verification failed'}
    if(!$rejected -or (Get-FileHash $dest).Hash -ne $sum){throw 'Corrupt transfer changed destination.'}
    $params.sha256=(Get-FileHash $base).Hash
    & $sbInstallVerifiedImage $params
    if((Get-FileHash $dest).Hash -ne $params.sha256){throw 'Verified copy failed.'}
    'Source and destination SHA256 checks passed; same-size corruption rejected.'
} finally {
    foreach($f in @($base,$partial,$dest,(Join-Path $root 'manifest.json'))) {if(Test-Path -LiteralPath $f){Remove-Item -LiteralPath $f -Force}}
    [IO.Directory]::Delete($root,$false)
}
