# These script blocks execute inside the selected host's session. They must be
# self-contained: a WinRM runspace does not inherit management-host functions.
$ops['fleet.test'] = {
    param($p)
    $ErrorActionPreference = 'Stop'
    if (-not (Get-Command Get-VMHost -ErrorAction SilentlyContinue) -or
        -not (Get-Service -Name vmms -ErrorAction SilentlyContinue)) {
        throw 'HVDASH_ROLE: Hyper-V or the Hyper-V management module is missing.'
    }
    if ((Get-Service vmms).Status -ne 'Running') { throw 'HVDASH_VMMS: Hyper-V Virtual Machine Management is stopped.' }
    $null = Get-VMHost
    $uuid = [string](Get-CimInstance Win32_ComputerSystemProduct).UUID
    [pscustomobject]@{computer=$env:COMPUTERNAME; uuid=$uuid; os=(Get-CimInstance Win32_OperatingSystem).Caption}
}

$ops['fleet.stats'] = {
    param($p)
    $ErrorActionPreference = 'Stop'
    if (-not (Get-Command Get-VMHost -ErrorAction SilentlyContinue)) { throw 'HVDASH_ROLE: Hyper-V management module missing.' }
    $null = Get-VMHost
    $os = Get-CimInstance Win32_OperatingSystem
    $cpus = @(Get-CimInstance Win32_Processor)
    $warnings = New-Object 'System.Collections.Generic.List[string]'
    # Cooked byte counters are bytes/second. Both latency counters are
    # AverageTimer32 values in seconds. A failed counter is unknown, never zero.
    function Read-Counters($category, $fields) {
        $result = @{}
        $paths = @(foreach ($counter in $fields.Keys) { "\$category(*)\$counter" })
        try {
            $sample = Get-Counter -Counter $paths -ErrorAction SilentlyContinue
            foreach ($item in $sample.CounterSamples) {
                if (!$item -or $item.InstanceName -eq '_total' -or $item.Status -notin @(0,1)) { continue }
                $value = $item.CookedValue
                if ($null -eq $value -or $value -lt 0 -or [double]::IsNaN($value) -or [double]::IsInfinity($value)) { continue }
                $instance = $item.InstanceName
                $key = $fields[$item.Path.Substring($item.Path.LastIndexOf('\') + 1)]
                if (!$key) { continue }
                if (!$result.ContainsKey($instance)) { $result[$instance] = @{} }
                if ($key -eq 'latencyMs') { $value *= 1000 }
                $result[$instance][$key] = [math]::Round($value,3)
            }
        } catch { Write-Verbose "Performance category unavailable: $category" }
        return $result
    }
    $networkFields = @{'Bytes Received/sec'='receiveBps';'Bytes Sent/sec'='sendBps'}
    $nicRates = Read-Counters 'Network Interface' $networkFields
    $volumeRates = Read-Counters 'LogicalDisk' @{'Disk Read Bytes/sec'='readBps';'Disk Write Bytes/sec'='writeBps';'Avg. Disk sec/Transfer'='latencyMs'}
    $adapterRates = Read-Counters 'Hyper-V Virtual Network Adapter' $networkFields
    $driveRates = Read-Counters 'Hyper-V Virtual Storage Device' @{'Read Bytes/sec'='readBps';'Write Bytes/sec'='writeBps';'Latency'='latencyMs'}
    function Device-Reading($kind, $id, $label, $values) {
        $device = @{kind=$kind;id=[string]$id;name=[string]$label}
        if ($values) { $device += $values }
        [pscustomobject]$device
    }
    $adapters = @(Get-VMNetworkAdapter -All)
    $management = @($adapters | Where-Object { $_.IsManagementOs })
    $physical = @(Get-NetAdapter -IncludeHidden)
    $allIp = @(Get-NetIPAddress -AddressFamily IPv4)
    $switches = @(Get-VMSwitch | ForEach-Object {
        $sw = $_
        $ipv4 = @(foreach ($vnic in @($management | Where-Object { $_.SwitchId -eq $sw.Id })) {
            $mac = ([string]$vnic.MacAddress) -replace '[-:]',''
            if ($mac) {
                $indices = @($physical | Where-Object { (($_.MacAddress -replace '[-:]','') -eq $mac) -and $_.InterfaceDescription -like 'Hyper-V Virtual Ethernet Adapter*' } | ForEach-Object {$_.ifIndex})
                $allIp | Where-Object {$indices -contains $_.InterfaceIndex} | ForEach-Object {
                    [pscustomobject]@{address=$_.IPAddress;prefixLength=$_.PrefixLength}
                }
            }
        })
        [pscustomobject]@{
            id="$($sw.Id)";name=$sw.Name;type="$($sw.SwitchType)";ipv4=$ipv4
            physicalAdapters=@($sw.NetAdapterInterfaceDescriptions | Where-Object {$_})
            adapters=@($adapters | Where-Object {$_.SwitchId -eq $sw.Id} | ForEach-Object {
                $vmName = $_.VMName
                if ($_.IsManagementOS) { $vmName = '(management OS)' }
                [pscustomobject]@{vm=$vmName;adapter=$_.Name}
            })
        }
    })
    $seen = @{}
    $vms = @(Get-VM | Sort-Object Name | ForEach-Object {
        $vm = $_
        $vmIo = New-Object 'System.Collections.Generic.List[object]'
        $guestAdapters = @($adapters | Where-Object { !$_.IsManagementOS -and $_.VMId -eq $vm.Id } | ForEach-Object {
            $adapterId = ([string]$_.Id -split '\\')[-1].Trim('{}')
            # Instance names vary by Windows version; identify the vNIC by GUID.
            $matchesById = @($adapterRates.Keys | Where-Object { $adapterId -and $_.IndexOf($adapterId,[StringComparison]::OrdinalIgnoreCase) -ge 0 })
            $rates = if ($matchesById.Count -eq 1) { $adapterRates[$matchesById[0]] }
            $vmIo.Add((Device-Reading 'nic' $_.Id $_.Name $rates))
            [pscustomobject]@{name=$_.Name;switch=$_.SwitchName;ips=@($_.IPAddresses | Where-Object {$_})}
        })
        [double]$size = 0
        foreach ($drive in @(Get-VMHardDiskDrive -VM $vm)) {
            if (!$drive.Path) { $warnings.Add("A pass-through disk on $($vm.Name) is excluded from virtual disk capacity."); continue }
            $instance = $drive.Path.Replace('\','-')
            $rates = $driveRates[$instance]
            if (!$rates) { $rates = $driveRates['--?-' + $instance] }
            $vmIo.Add((Device-Reading 'disk' $drive.Path $drive.Path $rates))
            try {
                if (!$seen.ContainsKey($drive.Path)) { $seen[$drive.Path] = (Get-VHD -Path $drive.Path).Size }
                $size += $seen[$drive.Path]
            } catch { $warnings.Add("A virtual disk on $($vm.Name) could not be inspected.") }
        }
        [pscustomobject]@{
            id="$($vm.Id)"; name=$vm.Name; state="$($vm.State)"; cpuPct=[int]$vm.CPUUsage; vcpu=[int]$vm.ProcessorCount
            memMB=[math]::Round($vm.MemoryAssigned / 1MB); startupMB=[math]::Round($vm.MemoryStartup / 1MB)
            uptimeSec=[long]$vm.Uptime.TotalSeconds; ips=@($guestAdapters | ForEach-Object {$_.ips} | Where-Object {$_})
            diskGB=[math]::Round($size / 1GB,2); adapters=$guestAdapters; io=$vmIo.ToArray(); managed=($vm.Notes -like 'hvdash*')
        }
    })
    $reading = ($cpus | Measure-Object LoadPercentage -Average).Average
    if ($null -eq $reading) { $warnings.Add('CPU load is unavailable.') }
    $vmmsVersion = (Get-Item (Join-Path $env:SystemRoot 'System32\vmms.exe')).VersionInfo.ProductVersion
    $volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')
    [pscustomobject]@{
        computer=$env:COMPUTERNAME; uuid=[string](Get-CimInstance Win32_ComputerSystemProduct).UUID
        os=$os.Caption; build=$os.BuildNumber; cpuModel=($cpus.Name | Sort-Object -Unique) -join ', '
        cores=[int]($cpus | Measure-Object NumberOfCores -Sum).Sum
        logicalProcessors=[int]($cpus | Measure-Object NumberOfLogicalProcessors -Sum).Sum
        hyperVVersion=$vmmsVersion; lastBoot=$os.LastBootUpTime.ToUniversalTime().ToString('o')
        uptimeSec=[long]((Get-Date) - $os.LastBootUpTime).TotalSeconds; cpuPct=$reading
        memTotalMB=[math]::Round($os.TotalVisibleMemorySize / 1KB);memFreeMB=[math]::Round($os.FreePhysicalMemory / 1KB)
        io=@(
            foreach ($nic in ($nicRates.Keys | Sort-Object)) { Device-Reading 'nic' $nic $nic $nicRates[$nic] }
            foreach ($volume in $volumes) { Device-Reading 'disk' $volume.DeviceID $volume.DeviceID $volumeRates[$volume.DeviceID] }
        )
        disks=@($volumes | ForEach-Object {
            [pscustomobject]@{name=$_.DeviceID; sizeGB=[math]::Round($_.Size / 1GB,2); freeGB=[math]::Round($_.FreeSpace / 1GB,2)}
        })
        provisionedDiskGB=[math]::Round(($seen.Values | Measure-Object -Sum).Sum / 1GB,2)
        networks=$switches;vms=$vms;warnings=@($warnings.ToArray())
    }
}
$ops['fleet.nat'] = {
    param($p)
    $ErrorActionPreference='Stop'
    [pscustomobject]@{
        networks=@(Get-NetNat | ForEach-Object {[pscustomobject]@{name=$_.Name;prefix=[string]$_.InternalIPInterfaceAddressPrefix}})
        mappings=@(Get-NetNatStaticMapping | ForEach-Object {
            [pscustomobject]@{id=[long]$_.StaticMappingID;nat=$_.NatName;protocol="$($_.Protocol)";externalIP=$_.ExternalIPAddress;externalPort=[int]$_.ExternalPort;internalIP=$_.InternalIPAddress;internalPort=[int]$_.InternalPort}
        })
    }
}
$ops['fleet.natAdd'] = {
    param($p)
    $ErrorActionPreference='Stop'
    $n = @(Get-NetNat | Where-Object {$_.Name -eq $p.nat})
    if ($n.Count -ne 1) {throw 'The selected NAT network no longer exists. Refresh the mappings.'}
    $null = Add-NetNatStaticMapping -NatName $n[0].Name -Protocol $p.protocol -ExternalIPAddress $p.externalIP -ExternalPort ([uint16]$p.externalPort) -InternalIPAddress $p.internalIP -InternalPort ([uint16]$p.internalPort) -Confirm:$false
    [pscustomobject]@{ok=$true}
}
$ops['fleet.natRemove'] = {
    param($p)
    $ErrorActionPreference='Stop'
    $m=@(Get-NetNatStaticMapping | Where-Object { $_.NatName -eq $p.nat -and $_.StaticMappingID -eq $p.id })
    if ($m.Count -ne 1) {throw 'That NAT mapping no longer exists. Refresh the mappings.'}
    # Do not delete a mapping replaced between confirmation and execution.
    if ("$($m[0].Protocol)" -ne $p.protocol -or "$($m[0].InternalIPAddress)" -ne $p.internalIP -or "$($m[0].ExternalIPAddress)" -ne $p.externalIP -or $m[0].InternalPort -ne $p.internalPort -or $m[0].ExternalPort -ne $p.externalPort) {throw 'The NAT mapping changed. Refresh it and confirm again.'}
    Remove-NetNatStaticMapping -InputObject $m[0] -Confirm:$false
    [pscustomobject]@{ok=$true}
}
