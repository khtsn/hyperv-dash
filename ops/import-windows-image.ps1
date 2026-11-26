# Import a generalized disk, or build one from an official Windows installation ISO.
[CmdletBinding(DefaultParameterSetName='VHDX')]
param(
    [Parameter(Mandatory,ParameterSetName='VHDX')][string]$Path,
    [Parameter(Mandatory,ParameterSetName='ISO')][string]$IsoPath,
    [Parameter(ParameterSetName='ISO')][string]$ImageName='Windows 11 Pro',
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$Sha256
)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'provision-create.ps1')
$fromIso=$PSCmdlet.ParameterSetName -eq 'ISO'
if($fromIso){
    $source=Get-Item -LiteralPath $IsoPath
    if($source.Extension -ine '.iso'){throw 'Select a Windows 11 x64 installation ISO.'}
    $isoHash=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if($Sha256 -and $isoHash -ne $Sha256){throw 'Installation ISO does not match the supplied SHA-256.'}
} else {
    $source=Get-Item -LiteralPath $Path
    if($source.Extension -ine '.vhdx'){throw 'Select a standalone Windows 11 VHDX.'}
    $vhd=Get-VHD -Path $source.FullName
    if($vhd.Attached -or $vhd.ParentPath -or $vhd.VhdType -eq 'Differencing'){throw 'Shut down the template and supply a detached standalone VHDX.'}
}
$catalog=Join-Path $repo 'cache\catalog-v1\windows-11'
Wait-ProvisionImageLease $catalog 'the Windows image import'
$token=[guid]::NewGuid().ToString()
$copy=Join-Path $catalog ("import-$token.vhdx")
$inspectDisk=Join-Path $catalog ("inspect-$token.vhdx")
$mount=Join-Path $catalog ("inspect-$token")
$manifestTemp=Join-Path $catalog ("manifest-$token.tmp")
try {
    if($fromIso){
        & (Join-Path $PSScriptRoot 'windows-iso-to-vhdx.ps1') -Iso $source.FullName -ImageName $ImageName -Destination $copy
    } else {Copy-Item -LiteralPath $source.FullName -Destination $copy}
    $digest=(Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
    if(!$fromIso -and $Sha256 -and $digest -ne $Sha256){throw 'The image does not match the supplied SHA-256.'}
    $metadata=Get-VHD -Path $copy
    $mounted=$false
    $accessPathAdded=$false
    try {
        # DISM opens an offline installation for servicing even for edition and
        # language queries. Its writes must not change the verified base.
        New-VHD -Path $inspectDisk -ParentPath $copy -Differencing | Out-Null
        $disk=Mount-VHD -Path $inspectDisk -NoDriveLetter -Passthru | Get-Disk
        $mounted=$true
        $partitions=@($disk | Get-Partition)
        if($disk.PartitionStyle -ne 'GPT' -or !($partitions | Where-Object GptType -eq '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}')){throw 'The VHDX needs a GPT disk with an EFI System Partition for Generation 2 boot.'}
        $os=@(foreach($part in $partitions){$vol=$part | Get-Volume -ErrorAction SilentlyContinue
            if($vol -and $vol.FileSystem -eq 'NTFS' -and [IO.File]::Exists($vol.Path+'Windows\System32\ntoskrnl.exe')){$part}})
        if($os.Count -ne 1){throw 'Expected one readable, unencrypted Windows OS partition.'}
        [IO.Directory]::CreateDirectory($mount) | Out-Null
        Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $os[0].PartitionNumber -AccessPath $mount
        $accessPathAdded=$true
        $kernel=Join-Path $mount 'Windows\System32\ntoskrnl.exe'
        $build=[Diagnostics.FileVersionInfo]::GetVersionInfo($kernel).FileBuildPart
        $reader=[IO.BinaryReader]::new([IO.File]::OpenRead($kernel))
        try {
            $reader.BaseStream.Position=0x3c
            $offset=$reader.ReadInt32()
            $reader.BaseStream.Position=$offset
            if($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664){throw 'Use an x64 Windows kernel.'}
        } finally {$reader.Dispose()}
        $edition=(Get-WindowsEdition -Path $mount).Edition
        if($build -lt 22000 -or $edition -notmatch '^(Professional|Enterprise|Education)'){throw 'Use Windows 11 Pro, Enterprise or Education x64.'}
        $intl=& dism.exe /English "/Image:$mount" /Get-Intl
        $lang=@($intl | ForEach-Object {if($_ -match '^Default system UI language\s*:\s*([a-zA-Z0-9-]+)\s*$'){$matches[1]}})
        $imageVersion=@($intl | ForEach-Object {if($_ -match '^Image Version:\s*([0-9.]+)\s*$'){[version]$matches[1]}})
        if($LASTEXITCODE -or $lang.Count -ne 1){throw 'Could not determine the Windows image UI language.'}
        if($imageVersion.Count -ne 1){throw 'Could not determine the installed Windows version.'}
        if(!$fromIso){
            $state=[IO.File]::ReadAllText((Join-Path $mount 'Windows\Setup\State\State.ini'))
            if($state -notmatch '(?im)^\s*ImageState\s*=\s*IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE\s*$'){throw 'Run Sysprep /generalize /oobe /shutdown on the template before importing.'}
        }
        foreach($answer in 'Windows\Panther\Unattend.xml','Windows\Panther\Unattend\Unattend.xml'){
            if ([IO.File]::Exists((Join-Path $mount $answer))){throw 'Remove custom Panther answer files from the template before import. Hyper-V Dash supplies its own.'}
        }
    } finally {
        try {if($accessPathAdded){Remove-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $os[0].PartitionNumber -AccessPath $mount}}
        finally {
            if($mounted){Dismount-VHD -Path $inspectDisk}
            if([IO.File]::Exists($inspectDisk)){[IO.File]::Delete($inspectDisk)}
            if([IO.Directory]::Exists($mount)){[IO.Directory]::Delete($mount)}
        }
    }
    $target=Join-Path $catalog ($digest+'.vhdx')
    if([IO.File]::Exists($target)){
        if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $digest){throw 'Existing catalog disk failed checksum verification.'}
    } else { [IO.File]::Move($copy,$target) }
    $manifest=Join-Path $catalog 'manifest.json'
    $label=if($edition -eq 'Professional'){'Pro'}else{$edition}
    $entry=[ordered]@{id='windows-11';version=("11 $label (build {0}.{1})" -f $imageVersion[0].Build,$imageVersion[0].Revision);locale=$lang[0];sha256=$digest;sizeBytes=(Get-Item -LiteralPath $target).Length;virtualSizeBytes=$metadata.Size}
    if($fromIso){$entry.sourceIsoSha256=$isoHash}
    [IO.File]::WriteAllText($manifestTemp,($entry | ConvertTo-Json -Compress))
    if([IO.File]::Exists($manifest)){[IO.File]::Replace($manifestTemp,$manifest,[NullString]::Value)}
    else{[IO.File]::Move($manifestTemp,$manifest)}
    Write-Output ("Windows {0} imported. SHA-256 {1}" -f $entry.version,$digest)
} finally {
    try {
        if([IO.File]::Exists($copy)){[IO.File]::Delete($copy)}
        [IO.File]::Delete($manifestTemp)
    } finally { & $sbReleaseImageLease }
}
