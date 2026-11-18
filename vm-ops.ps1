# Scriptblocks execute inside the selected host's PowerShell session. A VM object
# or GUID, never a wildcard supplied by the browser, is passed to mutating cmdlets.
$ops['vmDetail'] = {
    param($p)
    $ErrorActionPreference = 'Stop'
    $vm = @(Get-VM | Where-Object { $_.Name -eq $p.name })
    if ($vm.Count -ne 1) { throw 'VM not found. Refresh the host inventory.' }
    $vm = $vm[0]
    $cp = Get-VMComPort -VM $vm -Number 1 -ErrorAction SilentlyContinue
    $expected = "\\.\pipe\hvdash-$($vm.Id)"
    [pscustomobject]@{
        id = [string]$vm.Id; name = $vm.Name; state = [string]$vm.State
        vcpu = [int]$vm.ProcessorCount; generation = $vm.Generation; version = $vm.Version
        memMB = [int]($vm.MemoryAssigned / 1MB); startupMB = [int]($vm.MemoryStartup / 1MB)
        dynamic = [bool]$vm.DynamicMemoryEnabled; minMB = [int]($vm.MemoryMinimum / 1MB); maxMB = [long]($vm.MemoryMaximum / 1MB)
        notes = [string]$vm.Notes; created = $vm.CreationTime.ToUniversalTime().ToString('o')
        autoStart = [string]$vm.AutomaticStartAction; autoStop = [string]$vm.AutomaticStopAction
        consolePipe = $(if ($cp.Path -eq $expected) { $expected } else { $null })
        hasOtherConsole = [bool]($cp.Path -and $cp.Path -ne $expected)
        adapters = @(Get-VMNetworkAdapter -VM $vm | ForEach-Object {
            [pscustomobject]@{ name=$_.Name; switch=$_.SwitchName; mac=$_.MacAddress; ips=@($_.IPAddresses) }
        })
        disks = @(Get-VMHardDiskDrive -VM $vm | ForEach-Object {
            $drive=$_
            $vhd=if ($drive.Path) { Get-VHD -Path $drive.Path -ErrorAction SilentlyContinue } else { $null }
            [pscustomobject]@{ path=$drive.Path; type=$(if($vhd){[string]$vhd.VhdType}else{'Unavailable'})
                sizeGB=$(if($vhd){$vhd.Size / 1GB}else{$null}); fileGB=$(if($vhd){$vhd.FileSize / 1GB}else{$null}) }
        })
        checkpoints = @(Get-VMSnapshot -VM $vm | Sort-Object CreationTime | ForEach-Object {
            $snap=$_
            $bytes=[long]$snap.SizeOfSystemFiles
            $known=$true
            foreach($diskPath in @(Get-VMHardDiskDrive -VMSnapshot $snap | Select-Object -ExpandProperty Path -Unique)){
                if($diskPath -match '\.avhdx?$'){
                    $file=Get-Item -LiteralPath $diskPath -ErrorAction SilentlyContinue
                    if($file){$bytes+=$file.Length}else{$known=$false}
                }
            }
            [pscustomobject]@{ id=[string]$snap.Id; name=$snap.Name; created=$snap.CreationTime.ToUniversalTime().ToString('o')
                sizeGB=$(if($known){$bytes / 1GB}else{$null}); type=[string]$snap.SnapshotType }
        })
    }
}

$ops['vmApply'] = {
    param($p)
    $ErrorActionPreference = 'Stop'
    $vm = Get-VM -Id ([guid]$p.id)
    if ($vm.Name -cne $p.name) { throw 'VM identity changed. Reopen its details before acting.' }
    switch ($p.action) {
        'start'   { Start-VM -VM $vm -Confirm:$false }
        'stop'    { Stop-VM -VM $vm -Confirm:$false }
        'off'     { Stop-VM -VM $vm -TurnOff -Confirm:$false }
        'restart' { Restart-VM -VM $vm -Force -Confirm:$false }
        'pause'   { Suspend-VM -VM $vm -Confirm:$false }
        'resume'  { Resume-VM -VM $vm -Confirm:$false }
        'save'    { Save-VM -VM $vm -Confirm:$false }
        'edit' {
            if ($vm.State -ne 'Off') { throw 'Shut down the VM before editing its hardware.' }
            $argsSet = @{VM=$vm; ProcessorCount=[long]$p.vcpu; MemoryStartupBytes=[long]$p.startupMB * 1MB
                Notes=$p.notes; AutomaticStartAction=$p.autoStart; AutomaticStopAction=$p.autoStop; Confirm=$false}
            if ($p.dynamic) {
                $argsSet.DynamicMemory=$true
                $argsSet.MemoryMinimumBytes=[long]$p.minMB * 1MB
                $argsSet.MemoryMaximumBytes=[long]$p.maxMB * 1MB
            } else { $argsSet.StaticMemory=$true }
            Set-VM @argsSet
        }
        'checkpoint-create' { Checkpoint-VM -VM $vm -SnapshotName $p.checkpointName -Confirm:$false }
        { $_ -in @('checkpoint-restore','checkpoint-delete') } {
            $snapshot = @(Get-VMSnapshot -VM $vm | Where-Object Id -eq ([guid]$p.checkpointId))
            if ($snapshot.Count -ne 1) { throw 'Checkpoint no longer exists on this VM.' }
            if ($snapshot[0].Name -cne $p.checkpointName) { throw 'Checkpoint was renamed. Review it again.' }
            if ($p.action -eq 'checkpoint-restore') { Restore-VMSnapshot -VMSnapshot $snapshot[0] -Confirm:$false }
            else { Remove-VMSnapshot -VMSnapshot $snapshot[0] -Confirm:$false }
        }
        'console-configure' {
            if ($vm.State -ne 'Off') { throw 'Shut down the VM before configuring its serial port.' }
            $existing=Get-VMComPort -VM $vm -Number 1 -ErrorAction SilentlyContinue
            $expected="\\.\pipe\hvdash-$($vm.Id)"
            if ($existing.Path -and $existing.Path -ne $expected) { throw 'COM1 already has an external assignment. Remove that assignment on the host before configuring console access.' }
            Set-VMComPort -VM $vm -Number 1 -Path $expected -DebuggerMode Off
        }
        'delete' {
            if ($vm.State -ne 'Off') { throw 'Shut down the VM before deleting it.' }
            if (@(Get-VMSnapshot -VM $vm).Count) { throw 'Remove checkpoints and allow their disk merges to finish first.' }
            $owned=$p.ownership
            if (!$owned -or ([guid]$owned.id) -ne $vm.Id) { throw 'Cannot verify ownership of this VM.' }
            # Only delete explicitly recorded, direct child VHDX files. Refuse links
            # at every level, externally attached disks, and unknown folder contents.
            function SafePath([string]$value) {
                if ($value -notmatch '^[a-zA-Z]:\\' -or $value.Substring(2).Contains(':')) { throw 'Disk path must be on a local volume.' }
                $full=[IO.Path]::GetFullPath($value).TrimEnd('\')
                $current=$full
                while ($current) {
                    if ((Test-Path -LiteralPath $current) -and ((Get-Item -Force -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                        throw 'Refusing to follow a reparse point.'
                    }
                    $current=[IO.Path]::GetDirectoryName($current)
                }
                return $full
            }
            $folder=SafePath $owned.directory
            if ((Split-Path $folder -Leaf) -ne $vm.Name -or (Split-Path (Split-Path $folder -Parent) -Leaf) -ne 'hvdash') {
                throw 'Recorded VM folder is outside its managed storage root.'
            }
            $paths=@($owned.files | ForEach-Object { SafePath $_ })
            if (!$paths.Count) { throw 'No owned disk paths found.' }
            foreach ($f in $paths) {
                if ([IO.Path]::GetDirectoryName($f) -ne $folder -or $f -notmatch '\.vhdx$') { throw 'Disk is outside the recorded VM folder.' }
            }
            foreach ($d in @(Get-VMHardDiskDrive -VM $vm)) {
                if (!$d.Path -or $paths -notcontains (SafePath $d.Path)) { throw 'Unrecorded storage is attached; detach it before deleting this VM.' }
            }
            foreach ($d in @(Get-ChildItem -LiteralPath $folder -Force)) {
                if ($d.PSIsContainer -or $paths -notcontains $d.FullName) { throw 'Unexpected content in the VM disk folder; move it before deleting the VM.' }
            }
            foreach ($other in @(Get-VM | Where-Object Id -ne $vm.Id)) {
                $drives=@(Get-VMHardDiskDrive -VM $other)
                foreach ($snap in @(Get-VMSnapshot -VM $other)) { $drives+=@(Get-VMHardDiskDrive -VMSnapshot $snap) }
                foreach ($drive in $drives) {
                    $walk=$drive.Path
                    $seen=@{}
                    while ($walk) {
                        if ($paths -contains [IO.Path]::GetFullPath($walk)) { throw 'Another VM or checkpoint references an owned disk. Deletion refused.' }
                        if ($seen.ContainsKey($walk)) { throw 'Unexpected VHD parent cycle.' }
                        $seen[$walk]=$true
                        $walk=(Get-VHD -Path $walk).ParentPath
                    }
                }
            }
            Remove-VM -VM $vm -Force
            foreach ($f in $paths) { if(Test-Path -LiteralPath $f){ Remove-Item -LiteralPath $f -Force } }
            [IO.Directory]::Delete($folder,$false)
        }
        default { throw 'Unknown VM action.' }
    }
    [pscustomobject]@{ok=$true}
}
