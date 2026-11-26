# Called on the selected host after preflight and image verification.
$sbProvisionCreate = {
    param($p)
    $ErrorActionPreference='Stop'
    function New-ProvisionMedia([string]$path, [string]$label, [hashtable]$files) {
        New-VHD -Path $path -SizeBytes 64MB -Dynamic | Out-Null
        if ($label -eq 'HVDASHKEY') {
            $acl=New-Object Security.AccessControl.FileSecurity
            $acl.SetAccessRuleProtection($true,$false)
            $operator=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            foreach ($sid in @($operator,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique) {
                $identity=[Security.Principal.SecurityIdentifier]::new($sid)
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'))
            }
            Set-Acl -LiteralPath $path -AclObject $acl
        }
        try {
            $d=Mount-VHD -Path $path -Passthru | Get-Disk
            Initialize-Disk -Number $d.Number -PartitionStyle MBR
            $part=New-Partition -DiskNumber $d.Number -UseMaximumSize -MbrType Huge
            $vol=$part | Format-Volume -FileSystem FAT -NewFileSystemLabel $label -Confirm:$false
            $enc=New-Object Text.UTF8Encoding($false)
            foreach ($file in $files.GetEnumerator()) {
                [IO.File]::WriteAllText($vol.Path+$file.Key,$file.Value,$enc)
            }
        } finally { if ((Get-VHD -Path $path).Attached) { Dismount-VHD -Path $path } }
    }
    function Read-StatusFrame([string]$chunk, [ref]$remainder, [string]$reportId) {
        $parts=@(($remainder.Value+$chunk) -split "`n")
        $remainder.Value=$parts[-1]
        if($remainder.Value.Length -gt 2048){$remainder.Value=''}
        $prefix="HVDASH:${reportId}:"
        for($i=0;$i -lt $parts.Count-1;$i++){
            if($parts[$i].StartsWith($prefix)){return $parts[$i].Substring($prefix.Length).TrimEnd("`r")}
        }
    }
    $root = [IO.Path]::GetFullPath((Join-Path ($p.volume + '\') 'hvdash'))
    $vmDir = [IO.Path]::GetFullPath((Join-Path $root $p.name))
    if ([IO.Path]::GetDirectoryName($vmDir) -ne $root) {throw 'Unsafe VM storage path. [not created]'}
    $disk=Join-Path $vmDir 'os.vhdx'
    $seed=Join-Path $vmDir 'seed.vhdx'
    $keyDisk=Join-Path $vmDir 'enrollment.vhdx'
    $id=$null; $hasDir=$false; $stage='storage'; $serial=$null
    try {
        if (!(Test-Path -LiteralPath $root)) {New-Item -ItemType Directory -Path $root -ErrorAction SilentlyContinue | Out-Null}
        if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Storage root was redirected.'}
        if (Test-Path -LiteralPath $vmDir) {throw 'Storage directory already exists.'}
        New-Item -ItemType Directory -Path $vmDir -ErrorAction Stop | Out-Null
        $hasDir=$true
        Write-Host 'STEP Cloning the verified base image'
        try { Copy-Item -LiteralPath $p.base -Destination $disk }
        finally { if ($global:hvDashImageLease) { $global:hvDashImageLease.Dispose(); $global:hvDashImageLease=$null } }
        $diskBytes=[int64]$p.diskGB * 1GB
        $windows=$p.image -eq 'windows-11'
        if($windows){
            $baseSize=(Get-VHD -Path $disk).Size
            if($diskBytes -lt $baseSize){throw 'Selected disk is smaller than the imported image.'}
            $p.windowsGuest | Add-Member -NotePropertyName expandOS -NotePropertyValue ($diskBytes -gt $baseSize)
            if($diskBytes -gt $baseSize){Resize-VHD -Path $disk -SizeBytes $diskBytes}
            $stage='Windows 11 VM configuration'
            $vm=New-VM -Name $p.name -Generation 2 -MemoryStartupBytes ([int64]$p.memMB*1MB) -VHDPath $disk -SwitchName $p.switch
            $id=$vm.VMId
            Set-VM -VM $vm -ProcessorCount $p.cpu -StaticMemory -Notes 'hvdash windows-11' -AutomaticCheckpointsEnabled $false
            Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -FirstBootDevice (Get-VMHardDiskDrive -VM $vm)
            Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
            Enable-VMTPM -VM $vm
            $stage='Windows 11 first boot'
            $guest=& ([scriptblock]::Create($p.windowsSetupScript)) $vm $disk $p
            if(!$guest.ready){throw 'Windows setup could not be confirmed.'}
            return [pscustomobject]@{id=[string]$id;directory=$vmDir;files=@($disk);firstBoot='done';tailscaleIP=$guest.tailscaleIP}
        }
        Resize-VHD -Path $disk -SizeBytes $diskBytes
        $seedFiles=@{'user-data'=$p.userData;'meta-data'=$p.metaData}
        if ($p.networkConfig) { $seedFiles['network-config']=$p.networkConfig }
        New-ProvisionMedia $seed 'CIDATA' $seedFiles
        if ($p.joinTailscale) { New-ProvisionMedia $keyDisk 'HVDASHKEY' @{'auth.key'=$p.tailscaleAuthKey} }
        $stage='Hyper-V configuration'
        $vm=New-VM -Name $p.name -Generation 2 -MemoryStartupBytes ([int64]$p.memMB*1MB) -VHDPath $disk -SwitchName $p.switch
        $id=$vm.VMId
        Set-VM -VM $vm -ProcessorCount $p.cpu -StaticMemory -Notes 'hvdash debian-13' -AutomaticCheckpointsEnabled $false
        Add-VMHardDiskDrive -VM $vm -Path $seed
        if ($p.joinTailscale) { $keyDrive=Add-VMHardDiskDrive -VM $vm -Path $keyDisk -Passthru }
        $osDrive = Get-VMHardDiskDrive -VM $vm | Where-Object Path -eq $disk
        Set-VMFirmware -VM $vm -SecureBootTemplate 'MicrosoftUEFICertificateAuthority' -FirstBootDevice $osDrive
        Set-VMComPort -VM $vm -Number 1 -Path ("\\.\pipe\hvdash-"+$id) -DebuggerMode Off
        $reportPort='hvdash-report-'+$id
        try {
            Set-VMComPort -VM $vm -Number 2 -Path ("\\.\pipe\"+$reportPort) -DebuggerMode Off
        } catch {
            Write-Host 'STEP COM2 report port unavailable; using Hyper-V Data Exchange'
            $reportPort=$null
        }
        Start-VM -VM $vm | Out-Null
        $minutes=15
        if ($p.joinTailscale) { $minutes=20; Write-Host 'STEP Waiting for cloud-init and Tailscale enrollment' }
        else { Write-Host 'STEP Waiting for cloud-init over the VM status port or Hyper-V Data Exchange (up to 15 minutes)' }
        $stage='Debian first boot'
        $deadline=[DateTime]::UtcNow.AddMinutes($minutes)
        $read=$null
        $buffer=New-Object byte[] 2048
        $serialTail=''
        do {
            $value=$null
            if ($reportPort) {
                try {
                    if (!$serial) {
                        $serial=[IO.Pipes.NamedPipeClientStream]::new('.',$reportPort,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
                        $serial.Connect(300)
                    }
                    if (!$read) { $read=$serial.ReadAsync($buffer,0,$buffer.Length) }
                    if ($read.IsCompleted) {
                        $len=$read.GetAwaiter().GetResult()
                        if ($len -eq 0) { throw 'Status port closed' }
                        $value=Read-StatusFrame ([Text.Encoding]::ASCII.GetString($buffer,0,$len)) ([ref]$serialTail) $p.reportId
                        $read=$null
                    }
                } catch {
                    if ($serial) {$serial.Dispose()}
                    $serial=$null; $read=$null; $serialTail=''
                }
            }
            if(!$value) {
                try {
                    $system = Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_ComputerSystem -Filter ("Name = '"+$id+"'")
                    $component=Get-CimAssociatedInstance -InputObject $system -ResultClassName Msvm_KvpExchangeComponent
                    foreach($item in @($component.GuestExchangeItems)){
                        if(!$item){continue}
                        $xml=[xml]$item
                        $reportKey=($xml.INSTANCE.PROPERTY | Where-Object NAME -eq 'Name').VALUE
                        if($reportKey -ne ('hvdash.boot.'+$p.reportId)){continue}
                        $value=[string]($xml.INSTANCE.PROPERTY | Where-Object NAME -eq 'Data').VALUE
                        break
                    }
                } catch {
                    # A transient CIM failure should not preempt COM2 delivery.
                    $value=$null
                }
            }
            if ($value) {
                $completed=[ordered]@{id=[string]$id;directory=$vmDir;files=@($disk,$seed);firstBoot='done'}
                if (!$p.joinTailscale -and $value -ceq 'done') { return [pscustomobject]$completed }
                if ($p.joinTailscale -and $value -cmatch '^tailscale:([0-9a-fA-F:.]{2,45})$') {
                    $address=$null
                    if (![Net.IPAddress]::TryParse($matches[1],[ref]$address)) { throw 'Invalid guest Tailscale address.' }
                    $completed.tailscaleIP=$address.ToString()
                    $stage='Tailscale credential disk removal'
                    Remove-VMHardDiskDrive -VMHardDiskDrive $keyDrive -Confirm:$false
                    Remove-Item -LiteralPath $keyDisk -Force
                    return [pscustomobject]$completed
                }
                if ($p.joinTailscale -and $value -in @('failed:tailscale enrollment failed','failed:tailscale not online')) {
                    throw 'Tailscale did not join. Check the auth key, device approval and guest network access.'
                }
                if($value -match '^failed:(cloud-init exit [0-9]+; stage [a-z,-]+|cloud-init timed out|could not read cloud-init status)$'){
                    throw ('Guest reported '+$matches[1]+'. See the Debian profile and package/network settings.')
                }
                throw 'Malformed guest first-boot report.'
            }
            Start-Sleep -Seconds 3
        }while([DateTime]::UtcNow -lt $deadline)
        throw 'No cloud-init outcome received. Verify guest boot, the COM2 status port, package access, and Hyper-V Data Exchange.'
    } catch {
        $reason=$_.Exception.Message
        if($stage -ne 'Debian first boot'){
            # Cmdlet error records can echo objects/parameters. Return only the failing stage.
            $reason="Check free resources, Hyper-V permissions, and the selected switch and volume."
            if($stage -eq 'Windows 11 first boot' -and $_.Exception.Message -match '^Windows setup failed during (answer file|guest startup|PowerShell Direct readiness|guest configuration|network configuration|OpenSSH setup|Tailscale enrollment|local account setup)\.$'){$reason=$_.Exception.Message}
        }
        $failureMessage="$stage failed. $reason"
        if(!$hasDir){throw "$failureMessage [not created]"}
        try {
            if($null -ne $id){
                $owned=Get-VM -Id $id -ErrorAction SilentlyContinue
                if($owned){
                    if($owned.State -ne 'Off'){Stop-VM -VM $owned -TurnOff -Force}
                    Remove-VM -VM $owned -Force
                }
            }
            if(([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($vmDir)) -ne $root) -or
               ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
               ((Get-Item -LiteralPath $vmDir).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Storage path changed.'}
            $ownedFiles=@($seed,$disk)
            if ($p.joinTailscale) { $ownedFiles += $keyDisk }
            foreach($f in $ownedFiles){ if(Test-Path -LiteralPath $f){Remove-Item -LiteralPath $f -Force} }
            [IO.Directory]::Delete($vmDir,$false)
        } catch {throw "$failureMessage Cleanup could not be verified; reconcile this VM and its folder on the host."}
        throw "$failureMessage [rolled back]"
    } finally { if ($serial) { $serial.Dispose() } }
}
$sbCheckTransferCapacity = {
    param($a)
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($a.dir))
    if ($drive.AvailableFreeSpace - [int64]$a.size -lt [math]::Max(10GB,$drive.TotalSize*0.10)) {
        throw 'Insufficient safe capacity for a verified base image on the default VHD volume.'
    }
}
$sbInstallVerifiedImage = {
    param($a)
    $ErrorActionPreference='Stop'
    if((Get-FileHash -LiteralPath $a.temp -Algorithm SHA256).Hash -ne $a.sha256){throw 'Host SHA256 verification failed; source and destination differ.'}
    Move-Item -LiteralPath $a.temp -Destination $a.base -Force
}
# The handle lives on the machine that owns the directory. An interrupted
# process or closed remote session releases it; the empty marker can remain.
$sbTryImageLease = {
    param($directory)
    $ErrorActionPreference='Stop'
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    try {
        $global:hvDashImageLease=[IO.File]::Open((Join-Path $directory '.hvdash-image.lock'),'OpenOrCreate','ReadWrite','None')
        return $true
    } catch {
        if (($_.Exception.GetBaseException().HResult -band 0xffff) -in @(32,33)) { return $false }
        throw
    }
}
$sbReleaseImageLease = {
    if ($global:hvDashImageLease) { $global:hvDashImageLease.Dispose(); $global:hvDashImageLease=$null }
}
function Wait-ProvisionImageLease([string]$directory, [string]$description, [switch]$OnHost) {
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $nextNotice=0
    do {
        if ($OnHost) { $acquired=Invoke-OnHost $sbTryImageLease $directory }
        else { $acquired=& $sbTryImageLease $directory }
        if ($acquired) { return }
        if ($timer.Elapsed.TotalSeconds -ge $nextNotice) {
            Write-Host ("STEP Waiting for {0} ({1} minutes elapsed)" -f $description,[int]$timer.Elapsed.TotalMinutes)
            $nextNotice+=60
        }
        Start-Sleep -Seconds 3
    } while ($timer.Elapsed.TotalMinutes -lt 30)
    throw "Timed out waiting for $description."
}
function Start-Provision {
    param($params)
    $ready = $false
    try {
        $resources=$params | Select-Object -Property * -ExcludeProperty userData,networkConfig,metaData,tailscaleAuthKey,windowsGuest
        $null = Invoke-OnHost $sbProvisionInspect $resources
        $windows=$params.image -eq 'windows-11'
        $imageId=if($windows){'windows-11'}else{'debian-13'}
        $catalog=Join-Path $PSScriptRoot ("cache\catalog-v1\"+$imageId)
        Wait-ProvisionImageLease $catalog 'the selected local base image'
        try {
            Write-Host 'STEP Validating local image provenance'
            if ($windows) {
                $manifest=Get-Content -LiteralPath (Join-Path $catalog 'manifest.json') -Raw | ConvertFrom-Json
                if($manifest.id -ne $imageId -or $manifest.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $manifest.sha256 -ne $params.imageHash){throw 'The Windows image changed. Refresh the image library.'}
                $base=Join-Path $catalog ($manifest.sha256+'.vhdx')
                if((Get-FileHash -LiteralPath $base -Algorithm SHA256).Hash -ne $manifest.sha256){throw 'Imported Windows image failed SHA-256 verification.'}
                $params | Add-Member -NotePropertyName windowsSetupScript -NotePropertyValue ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-guest.ps1')))
                $params | Add-Member -NotePropertyName windowsLocale -NotePropertyValue $manifest.locale
                $local=[pscustomobject]@{path=$base;manifest=$manifest}
            } else { $local=Get-ProvisionImage $catalog }
        } finally { & $sbReleaseImageLease }
        if ($windows -and $Transport -eq 'local') {
            # Imported templates are immutable by digest. The local hypervisor can
            # clone directly without reserving a second image on its default volume.
            $params | Add-Member -NotePropertyName base -NotePropertyValue $local.path
            $null=Invoke-OnHost $sbProvisionInspect $resources
            $ready=$true
            return Invoke-OnHost $sbProvisionCreate $params
        }
        $info=Invoke-OnHost $sbProvisionImageInfo ([pscustomobject]@{image=$imageId;paths=$true})
        Wait-ProvisionImageLease $info.dir 'the selected host image library' -OnHost
        try {
            $hash=$local.manifest.sha256
            $remoteHash=Invoke-OnHost {param($path) if(Test-Path -LiteralPath $path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}else{''}} $info.base
            if($remoteHash -ne $hash){
                $partial=Join-Path $info.dir ($imageId+'-'+[guid]::NewGuid()+'.partial')
                try {
                    Invoke-OnHost $sbCheckTransferCapacity ([pscustomobject]@{dir=$info.dir;size=$local.manifest.sizeBytes})
                    Write-Host 'STEP Transferring the base image to the selected host'
                    if($session){Copy-Item -LiteralPath $local.path -Destination $partial -ToSession $session}
                    else {Copy-Item -LiteralPath $local.path -Destination $partial}
                    Write-Host 'STEP Verifying the transferred SHA256 on the host'
                    Invoke-OnHost $sbInstallVerifiedImage ([pscustomobject]@{temp=$partial;base=$info.base;sha256=$hash})
                } finally {
                    Invoke-OnHost {param($f) if (Test-Path -LiteralPath $f){Remove-Item -LiteralPath $f -Force}} $partial
                }
            }
            Invoke-OnHost {
                param($a)
                $item=Get-Item -LiteralPath $a.base
                $manifest=$a.base+'.json'
                $pending=$manifest+'.'+[guid]::NewGuid()+'.tmp'
                try {
                    [IO.File]::WriteAllText($pending,([ordered]@{sha256=$a.sha256;version=$a.version;sizeBytes=$item.Length;ticks=$item.LastWriteTimeUtc.Ticks.ToString()}|ConvertTo-Json -Compress))
                    if ([IO.File]::Exists($manifest)) { [IO.File]::Replace($pending,$manifest,[NullString]::Value) }
                    else { [IO.File]::Move($pending,$manifest) }
                } finally { [IO.File]::Delete($pending) }
            } ([pscustomobject]@{base=$info.base;sha256=$hash;version=$local.manifest.version})
            $params | Add-Member -NotePropertyName base -NotePropertyValue $info.base
            $null=Invoke-OnHost $sbProvisionInspect $resources
            $ready=$true
            Invoke-OnHost $sbProvisionCreate $params
        } finally { Invoke-OnHost $sbReleaseImageLease $null }
    }catch{
        if(!$ready){throw ($_.Exception.Message+' [not created]')};throw
    }
}
