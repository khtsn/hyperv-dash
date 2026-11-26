[CmdletBinding()]
param([Parameter(Mandatory)][string]$Iso,[Parameter(Mandatory)][string]$ImageName,[Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
if([IO.File]::Exists($Destination)){throw 'Template destination already exists.'}
$isoMounted=$false
$vhdMounted=$false
try {
    $media=Get-DiskImage -ImagePath $Iso
    if(!$media.Attached){$media=Mount-DiskImage -ImagePath $Iso -Access ReadOnly -PassThru; $isoMounted=$true}
    $volume=$media | Get-Volume
    if(!$volume.DriveLetter){throw 'The mounted ISO needs a readable drive letter.'}
    $sources=$volume.DriveLetter+':\sources\'
    $install=@('install.wim','install.esd') | ForEach-Object {$sources+$_} | Where-Object {[IO.File]::Exists($_)} | Select-Object -First 1
    if(!$install){throw 'Installation ISO must contain sources\install.wim or install.esd.'}
    $image=Get-WindowsImage -ImagePath $install -Name $ImageName
    if($image.Architecture -notin @(9,'x64','amd64') -or $image.EditionId -notmatch '^(Professional|Enterprise|Education)' -or ([version]$image.Version).Build -lt 22000){throw 'Select a Windows 11 x64 Pro, Enterprise or Education installation image.'}

    New-VHD -Path $Destination -Dynamic -SizeBytes 64GB | Out-Null
    $newDisk=Mount-VHD -Path $Destination -NoDriveLetter -Passthru
    $vhdMounted=$true
    $disk=$newDisk | Get-Disk
    if($disk.Number -ne (Get-VHD -Path $Destination).DiskNumber -or $disk.IsBoot -or $disk.IsSystem -or $disk.PartitionStyle -ne 'RAW'){throw 'The new template disk could not be verified.'}
    Initialize-Disk -Number $disk.Number -PartitionStyle GPT
    $efi=New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'
    $efi | Format-Volume -FileSystem FAT32 -NewFileSystemLabel 'SYSTEM' -Confirm:$false | Out-Null
    $null=New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}'
    $os=New-Partition -DiskNumber $disk.Number -UseMaximumSize
    $os | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'Windows' -Confirm:$false | Out-Null
    foreach($part in @($efi,$os)){
        if(!($part | Get-Volume).DriveLetter){$part | Add-PartitionAccessPath -AssignDriveLetter}
    }
    $espLetter=($efi | Get-Volume).DriveLetter
    $osLetter=($os | Get-Volume).DriveLetter
    if(!$espLetter -or !$osLetter -or $espLetter -eq $osLetter){throw 'The temporary Windows and EFI volumes could not be mounted.'}
    foreach($letter in @($espLetter,$osLetter)){if((Get-Partition -DriveLetter $letter).DiskNumber -ne $disk.Number){throw 'A template mount point changed.'}}
    $applyRoot=$osLetter+':\'
    Write-Host "Applying $ImageName to the new template disk"
    Expand-WindowsImage -ImagePath $install -Index $image.ImageIndex -ApplyPath $applyRoot -CheckIntegrity -Verify | Out-Null
    & "$env:SystemRoot\System32\bcdboot.exe" ($applyRoot+'Windows') /s ($espLetter+':') /f UEFI
    if($LASTEXITCODE -or ![IO.File]::Exists($espLetter+':\EFI\Microsoft\Boot\BCD')){throw 'UEFI boot files could not be created on the template.'}
} finally {
    try {if($vhdMounted){Dismount-VHD -Path $Destination}}
    finally {if($isoMounted){Dismount-DiskImage -ImagePath $Iso | Out-Null}}
}
