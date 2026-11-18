# Called on the selected host after preflight and image verification.
$sbProvisionCreate = {
    param($p)
    $ErrorActionPreference='Stop'
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
    $id=$null; $hasDir=$false; $stage='storage'; $serial=$null
    try {
        if (!(Test-Path -LiteralPath $root)) {New-Item -ItemType Directory -Path $root -ErrorAction SilentlyContinue | Out-Null}
        if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Storage root was redirected.'}
        if (Test-Path -LiteralPath $vmDir) {throw 'Storage directory already exists.'}
        New-Item -ItemType Directory -Path $vmDir -ErrorAction Stop | Out-Null
        $hasDir=$true
        Write-Host 'STEP Cloning the verified base and building the seed disk'
        Copy-Item -LiteralPath $p.base -Destination $disk
        Resize-VHD -Path $disk -SizeBytes ([int64]$p.diskGB * 1GB)
        New-VHD -Path $seed -SizeBytes 64MB -Dynamic | Out-Null
        try {
            $d = Mount-VHD -Path $seed -Passthru | Get-Disk
            Initialize-Disk -Number $d.Number -PartitionStyle MBR
            $part=New-Partition -DiskNumber $d.Number -UseMaximumSize -MbrType Huge
            $vol=$part | Format-Volume -FileSystem FAT -NewFileSystemLabel 'CIDATA' -Confirm:$false
            $enc=New-Object Text.UTF8Encoding($false)
            [IO.File]::WriteAllText($vol.Path+'user-data',$p.userData,$enc)
            [IO.File]::WriteAllText($vol.Path+'meta-data',$p.metaData,$enc)
            if($p.networkConfig){[IO.File]::WriteAllText($vol.Path+'network-config',$p.networkConfig,$enc)}
        } finally { if((Get-VHD -Path $seed).Attached){Dismount-VHD -Path $seed} }
        $stage='Hyper-V configuration'
        $vm=New-VM -Name $p.name -Generation 2 -MemoryStartupBytes ([int64]$p.memMB*1MB) -VHDPath $disk -SwitchName $p.switch
        $id=$vm.VMId
        Set-VM -VM $vm -ProcessorCount $p.cpu -StaticMemory -Notes 'hvdash debian-13' -AutomaticCheckpointsEnabled $false
        Add-VMHardDiskDrive -VM $vm -Path $seed
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
        Write-Host 'STEP Waiting for cloud-init over the VM status port or Hyper-V Data Exchange (up to 15 minutes)'
        $stage='Debian first boot'
        $deadline=[DateTime]::UtcNow.AddMinutes(15)
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
                if($value -eq 'done'){return [pscustomobject]@{id=[string]$id;directory=$vmDir;files=@($disk,$seed);firstBoot='done'}}
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
            foreach($f in @($seed,$disk)){ if(Test-Path -LiteralPath $f){Remove-Item -LiteralPath $f -Force} }
            [IO.Directory]::Delete($vmDir,$false)
        } catch {throw "$failureMessage Cleanup could not be verified; reconcile this VM and its folder on the host."}
        throw "$failureMessage [rolled back]"
    } finally { if ($serial) { $serial.Dispose() } }
}
$sbInstallVerifiedImage = {
    param($a)
    $ErrorActionPreference='Stop'
    if((Get-FileHash -LiteralPath $a.temp -Algorithm SHA256).Hash -ne $a.sha256){throw 'Host SHA256 verification failed; source and destination differ.'}
    Move-Item -LiteralPath $a.temp -Destination $a.base -Force
}
function Start-Provision {
    param($params)
    $ready = $false
    try {
        $null = Invoke-OnHost $sbProvisionInspect $params
        $mutex=New-Object Threading.Mutex($false,'Local\HyperVDashImageCacheV1')
        $locked=$false
        try {
            try { $locked=$mutex.WaitOne(600000) } catch [Threading.AbandonedMutexException] {$locked=$true}
            if(!$locked){throw 'Another image transfer is still running. Try provisioning again.'}
            Write-Host 'STEP Validating local image provenance'
            $local=Get-ProvisionImage
            $info=Invoke-OnHost $sbProvisionImageInfo $null
            $hash=$local.manifest.sha256
            $remoteHash=Invoke-OnHost {param($path) if(Test-Path -LiteralPath $path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}else{''}} $info.base
            if($remoteHash -ne $hash){
                $partial=Join-Path $info.dir ('debian-13-'+[guid]::NewGuid()+'.partial')
                try {
                    Invoke-OnHost {
                        param($a)
                        $root=[IO.Path]::GetPathRoot($a.dir)
                        $drive=New-Object IO.DriveInfo($root)
                        if($drive.AvailableFreeSpace - [int64]$a.size -lt [math]::Max(10GB,$drive.TotalSize*0.10)){throw 'Insufficient safe capacity for a verified base image on the default VHD volume.'}
                        [IO.Directory]::CreateDirectory($a.dir) | Out-Null
                    } ([pscustomobject]@{dir=$info.dir;size=$local.manifest.sizeBytes})
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
                [IO.File]::WriteAllText(($a.base+'.json'),([ordered]@{sha256=$a.sha256;version=$a.version;sizeBytes=$item.Length;ticks=$item.LastWriteTimeUtc.Ticks.ToString()}|ConvertTo-Json -Compress))
            } ([pscustomobject]@{base=$info.base;sha256=$hash;version=$local.manifest.version})
            $params | Add-Member -NotePropertyName base -NotePropertyValue $info.base
        } finally {if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
        $null=Invoke-OnHost $sbProvisionInspect $params
        $ready=$true
        Invoke-OnHost $sbProvisionCreate $params
    }catch{
        if(!$ready){throw ($_.Exception.Message+' [not created]')};throw
    }
}
