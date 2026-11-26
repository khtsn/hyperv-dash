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
$winScript=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows-guest.ps1'),[ref]$null,[ref]$null)
$makeAnswer=$winScript.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-WindowsAnswer'},$true)
. ([scriptblock]::Create($makeAnswer.Extent.Text))
[xml]$answer=New-WindowsAnswer 'win-test' 'vmadmin' 'temporary<&fixture' 'en-US'
$ns=New-Object Xml.XmlNamespaceManager($answer.NameTable)
$ns.AddNamespace('u','urn:schemas-microsoft-com:unattend')
$account=$answer.SelectSingleNode("//u:settings[@pass='oobeSystem']//u:LocalAccount",$ns)
if($account.Name -ne 'vmadmin' -or $account.Password.Value -cne 'temporary<&fixture' -or $answer.SelectSingleNode("//u:settings[@pass='specialize']//u:ComputerName",$ns).InnerText -ne 'win-test'){
    throw 'The Windows setup answer did not preserve the new computer name, local account and password.'
}
$BaseName='debian-13-base.vhdx'
$root=Join-Path ([IO.Path]::GetTempPath()) ('hvdash-check-'+[guid]::NewGuid())
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    # Hold a lease in a second runspace to exercise real Windows sharing semantics.
    $catalog=Join-Path $root 'catalog'
    $hostA=Join-Path $root 'host-a'
    $hostB=Join-Path $root 'host-b'
    $holder=[PowerShell]::Create()
    try {
        $null=$holder.AddScript($sbTryImageLease.ToString()).AddArgument($hostA)
        if (($holder.Invoke())[0] -ne $true) { throw 'Fixture could not acquire host A.' }
        if (& $sbTryImageLease $hostA) { throw 'Concurrent publishers acquired the same library.' }
        foreach ($other in @($catalog,$hostB)) {
            if (!(& $sbTryImageLease $other)) { throw 'An unrelated image library was blocked.' }
            & $sbReleaseImageLease
        }
        $holder.Commands.Clear()
        $null=$holder.AddScript($sbReleaseImageLease.ToString()).Invoke()
        if (!(& $sbTryImageLease $hostA)) { throw 'The next publisher could not reuse host A.' }
        'Contended host serialized, independent libraries progressed, and released lease was reusable.'
    } finally {
        & $sbReleaseImageLease
        $holder.Dispose()
        foreach ($dir in @($catalog,$hostA,$hostB)) {
            if ([IO.Directory]::Exists($dir)) {
                [IO.File]::Delete((Join-Path $dir '.hvdash-image.lock'))
                [IO.Directory]::Delete($dir)
            }
        }
    }
    $base=Join-Path $root $BaseName
    $partial=Join-Path $root 'copy.partial'
    $dest=Join-Path $root 'target.vhdx'
    [IO.File]::WriteAllBytes($base, [byte[]]@(1,2,3))
    $sum=(Get-FileHash $base -Algorithm SHA256).Hash
    [IO.File]::WriteAllText((Join-Path $root 'manifest.json'),([ordered]@{archiveSha512=('e'*128);sha256=$sum;sizeBytes=3;version='fixture'} | ConvertTo-Json -Compress))
    $image=Get-ProvisionImage $root
    if($image.manifest.sha256 -ne $sum){throw 'Valid source image rejected.'}
    & {
        # Run the production orchestration against scratch paths and a simulated
        # host. Leave its locking, transfer, checksum and manifest handling intact.
        $scriptCopy=Join-Path $root 'provision-create.ps1'
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'provision-create.ps1') -Destination $scriptCopy
        . $scriptCopy
        $library=Join-Path $root 'destination'
        $hostBase=Join-Path $library 'base.vhdx'
        $cache=Join-Path $root 'cache\catalog-v1\debian-13'
        $session=$null
        $sbCheckTransferCapacity={param($p) if ($p.size -ne 3) {throw 'Incorrect transfer size.'}}
        $sbProvisionInspect={param($p) if ($p.PSObject.Properties['tailscaleAuthKey']) {throw 'Credential reached preflight.'}}
        function Get-ProvisionImage { param($cacheDir) return $image }
        $sbProvisionImageInfo={ [pscustomobject]@{dir=$library;base=$hostBase} }
        function Invoke-OnHost($sb,$arg) { & $sb $arg }
        $sbProvisionCreate={
            if (!$global:hvDashImageLease) {throw 'Destination lease released before cloning.'}
            $probe=[IO.File]::Open((Join-Path $cache '.hvdash-image.lock'),'Open','ReadWrite','None')
            $probe.Dispose()
            if ((Get-FileHash -LiteralPath $hostBase).Hash -ne $sum) {throw 'Published base differs.'}
        }
        try {
            foreach ($attempt in 1..2) {
                Start-Provision ([pscustomobject]@{name='test';tailscaleAuthKey='fixture'})
                $meta=Get-Content -LiteralPath ($hostBase+'.json') -Raw | ConvertFrom-Json
                if ($meta.sha256 -ne $sum) {throw 'Manifest changed the expected digest.'}
            }
            'Cold transfer and warm reuse verified through Start-Provision.'
        } finally {
            foreach($file in @($scriptCopy,$hostBase,($hostBase+'.json'),(Join-Path $library '.hvdash-image.lock'),(Join-Path $cache '.hvdash-image.lock'))) {
                if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
            }
            foreach($dir in @($cache,(Join-Path $root 'cache\catalog-v1'),(Join-Path $root 'cache'),$library)) {
                if ([IO.Directory]::Exists($dir)) { [IO.Directory]::Delete($dir) }
            }
        }
    }
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
