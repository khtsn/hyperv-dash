# One operation against one Hyper-V host. Called by server.mjs.
# Progress lines go to stdout; the last line is "RESULT <json>" or "ERROR <message>".
param(
    [Parameter(Mandatory = $true)][string]$Op,
    [string]$Address = 'localhost',
    [string]$Transport = 'local',
    [string]$UserEnv = '',
    [string]$PassEnv = '',
    [string]$ParamsB64 = '',
    [switch]$InputPipe
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

$ImageUrl = 'https://cloud.debian.org/images/cloud/trixie/latest'
$ImageFile = 'debian-13-generic-amd64.tar.xz'
$BaseName = 'debian-13-base.vhdx'

$p = $null
if ($ParamsB64) {
    $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ParamsB64)) | ConvertFrom-Json
}

$credential = $null
if ($InputPipe) {
    $wire = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())) | ConvertFrom-Json
    $p = $wire.params
    if ($wire.credential) {
        Add-Type -AssemblyName System.Security
        $clear = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($wire.credential.secret), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $secretText = [Text.Encoding]::UTF8.GetString($clear)
        if ($wire.credential.format -eq 2) {
            $pair = $secretText | ConvertFrom-Json
            $credential = New-Object pscredential($pair.user, (ConvertTo-SecureString $pair.password -AsPlainText -Force))
        } else {
            $credential = New-Object pscredential($wire.credential.user, (ConvertTo-SecureString $secretText -AsPlainText -Force))
        }
        [Array]::Clear($clear, 0, $clear.Length)
        $pair = $null; $secretText = $null
    }
}
$session = $null

function Invoke-OnHost([scriptblock]$Sb, $Arg) {
    if ($session) { Invoke-Command -Session $session -ScriptBlock $Sb -ArgumentList $Arg }
    else { & $Sb $Arg }
}

# ---- script blocks that run on the Hyper-V host --------------------------------

$sbStats = {
    $ErrorActionPreference = 'Stop'
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = @(Get-CimInstance Win32_Processor)
    $vms = @(Get-VM | Sort-Object Name | ForEach-Object {
            $ips = @($_.NetworkAdapters | ForEach-Object { $_.IPAddresses } | Where-Object { $_ -match '^\d+\.' })
            [pscustomobject]@{
                name      = $_.Name
                state     = "$($_.State)"
                cpuPct    = [int]$_.CPUUsage
                vcpu      = [int]$_.ProcessorCount
                memMB     = [int]($_.MemoryAssigned / 1MB)
                uptimeSec = [int]$_.Uptime.TotalSeconds
                ips       = $ips
                managed   = ($_.Notes -like 'hvdash*')
            }
        })
    [pscustomobject]@{
        computer   = $env:COMPUTERNAME
        os         = $os.Caption
        cpuPct     = [int]($cpu | Measure-Object LoadPercentage -Average).Average
        cores      = [int]($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum
        memTotalMB = [int]($os.TotalVisibleMemorySize / 1KB)
        memFreeMB  = [int]($os.FreePhysicalMemory / 1KB)
        uptimeSec  = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
        disks      = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
                [pscustomobject]@{
                    name   = $_.DeviceID
                    sizeGB = [math]::Round($_.Size / 1GB, 1)
                    freeGB = [math]::Round($_.FreeSpace / 1GB, 1)
                }
            })
        switches   = @(Get-VMSwitch | ForEach-Object { $_.Name })
        vms        = $vms
    }
}

$sbFreeIp = {
    # Use the connected management interface, ledger and live neighbour evidence.
    param($p)
    $ErrorActionPreference = 'Stop'
    $none = { param($why) [pscustomobject]@{ ip = $null; gateway = $null; reason = $why } }
    $sw = Get-VMSwitch | Where-Object Name -eq $p.switch | Select-Object -First 1
    if (!$sw) { return & $none 'The switch no longer exists. Refresh host inventory.' }
    $nic = Get-VMNetworkAdapter -ManagementOS -SwitchName $p.switch -ErrorAction SilentlyContinue | Select-Object -First 1
    $ad = $null
    if ($nic) { $ad = Get-NetAdapter | Where-Object { ($_.MacAddress -replace '-', '') -eq $nic.MacAddress } | Select-Object -First 1 }
    $addr = $null
    if ($ad) { $addr = Get-NetIPAddress -InterfaceIndex $ad.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 }
    if (-not $addr) { return & $none 'The host has no directly connected IPv4 subnet on this switch. Use DHCP or specify a known private address after checking the network.' }
    $gateway=$addr.IPAddress
    if ("$($sw.SwitchType)" -eq 'External') {
        $route=Get-NetRoute -InterfaceIndex $ad.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
        if(!$route){return & $none 'No default gateway is configured on this external switch. Use DHCP or enter a validated static route.'}
        $gateway=$route.NextHop
    }
    $prefix = [int]$addr.PrefixLength
    if ($prefix -lt 16 -or $prefix -gt 30) { return & $none "Unsupported prefix /$prefix on switch '$($p.switch)'." }

    $b = ([ipaddress]$addr.IPAddress).GetAddressBytes()
    [int64]$hostInt = ([int64]$b[0] -shl 24) + ([int64]$b[1] -shl 16) + ([int64]$b[2] -shl 8) + [int64]$b[3]
    [int64]$size = [math]::Pow(2, 32 - $prefix)
    [int64]$net = $hostInt - ($hostInt % $size)
    $toIp = { param([int64]$n) '{0}.{1}.{2}.{3}' -f (($n -shr 24) -band 255), (($n -shr 16) -band 255), (($n -shr 8) -band 255), ($n -band 255) }

    $used = @{}
    $used[$addr.IPAddress] = $true
    $used[$gateway] = $true
    foreach ($x in @($p.exclude)) { if ($x) { $used["$x"] = $true } }
    Get-VM | ForEach-Object { $_.NetworkAdapters } | ForEach-Object { $_.IPAddresses } | ForEach-Object { $used["$_"] = $true }
    $live = 'Reachable', 'Stale', 'Delay', 'Probe', 'Permanent'
    Get-NetNeighbor -InterfaceIndex $ad.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $live -contains "$($_.State)" } | ForEach-Object { $used[$_.IPAddress] = $true }

    $first = 2
    if ($size -ge 64) { $first = 10 }
    $probes = 0
    for ([int64]$o = $first; $o -le $size - 2 -and $probes -lt 40; $o++) {
        $cand = & $toIp ($net + $o)
        if ($used[$cand]) { continue }
        $probes++
        $probe=New-Object Net.NetworkInformation.Ping
        try {if (($probe.Send($cand,600)).Status -eq 'Success') { continue }}
        finally {$probe.Dispose()}
        # A guest that drops ping still answers ARP.
        $n = Get-NetNeighbor -IPAddress $cand -InterfaceIndex $ad.ifIndex -ErrorAction SilentlyContinue
        if ($n -and ('Reachable', 'Stale', 'Delay', 'Probe') -contains "$($n.State)") { continue }
        return [pscustomobject]@{ ip = "$cand/$prefix"; gateway = $gateway; reason = $null }
    }
    & $none "No free address found on switch '$($p.switch)'."
}

# ---- local helpers (run on the management machine) -----------------------------

function Add-VhdFooter([string]$Path) {
    # A fixed VHD is the raw disk plus a 512-byte big-endian footer.
    $fs = [IO.File]::Open($Path, 'Open', 'ReadWrite')
    try {
        [int64]$size = $fs.Length
        if ($size % 512) { throw "Raw image size $size is not a multiple of 512." }
        $f = New-Object byte[] 512
        $put = {
            param([int64]$v, [int]$o, [int]$n)
            for ($i = 0; $i -lt $n; $i++) { $f[$o + $n - 1 - $i] = [byte](($v -shr (8 * $i)) -band 0xFF) }
        }
        [Text.Encoding]::ASCII.GetBytes('conectix').CopyTo($f, 0)
        & $put 2 8 4                      # features: reserved bit
        & $put 0x00010000 12 4            # format version
        for ($i = 16; $i -lt 24; $i++) { $f[$i] = 0xFF }   # data offset: none (fixed disk)
        & $put ([int64]((Get-Date).ToUniversalTime() - [datetime]'2000-01-01').TotalSeconds) 24 4
        [Text.Encoding]::ASCII.GetBytes('hvd ').CopyTo($f, 28)
        & $put 0x00010000 32 4
        [Text.Encoding]::ASCII.GetBytes('Wi2k').CopyTo($f, 36)
        & $put $size 40 8
        & $put $size 48 8
        [int64]$sectors = $size / 512
        if ($sectors -gt 65535 * 16 * 255) { $sectors = 65535 * 16 * 255 }
        if ($sectors -ge 65535 * 16 * 63) { $spt = 255; $heads = 16; $cth = [math]::Floor($sectors / $spt) }
        else {
            $spt = 17; $cth = [math]::Floor($sectors / $spt)
            $heads = [math]::Floor(($cth + 1023) / 1024)
            if ($heads -lt 4) { $heads = 4 }
            if ($cth -ge $heads * 1024 -or $heads -gt 16) { $spt = 31; $heads = 16; $cth = [math]::Floor($sectors / $spt) }
            if ($cth -ge $heads * 1024) { $spt = 63; $heads = 16; $cth = [math]::Floor($sectors / $spt) }
        }
        & $put ([int64][math]::Floor($cth / $heads)) 56 2
        $f[58] = [byte]$heads
        $f[59] = [byte]$spt
        & $put 2 60 4                     # disk type: fixed
        [guid]::NewGuid().ToByteArray().CopyTo($f, 68)
        [int64]$sum = 0
        foreach ($b in $f) { $sum += $b }
        & $put ((-bnot $sum) -band 4294967295) 64 4
        [void]$fs.Seek(0, 'End')
        $fs.Write($f, 0, 512)
    }
    finally { $fs.Dispose() }
}

. (Join-Path $PSScriptRoot 'provision.ps1')
. (Join-Path $PSScriptRoot 'provision-create.ps1')

# ---- dispatch -------------------------------------------------------------------

try {
    if ($Transport -in @('winrm','winrm-https')) {
        $so = @{ ComputerName = $Address }
        $user = $null
        if ($UserEnv) {
            $user = [Environment]::GetEnvironmentVariable($UserEnv)
            if (-not $user) { throw 'Imported WinRM credential is unavailable. Enter new credentials in Host connections.' }
        }
        if ($user) {
            $pass = [Environment]::GetEnvironmentVariable($PassEnv)
            if (-not $pass) { throw "Environment variable '$PassEnv' is not set." }
            $so.Credential = New-Object pscredential($user, (ConvertTo-SecureString $pass -AsPlainText -Force))
        }
        if ($credential) { $so.Credential = $credential }
        if ($Transport -eq 'winrm-https') { $so.UseSSL = $true }
        $so.SessionOption = New-PSSessionOption -OpenTimeout 10000 -OperationTimeout 60000
        $session = New-PSSession @so
    }
    elseif ($Transport -ne 'local') { throw "Unknown transport '$Transport'." }

    $ops = @{}
    foreach ($module in @('fleet-ops.ps1','vm-ops.ps1')) {
        $moduleFile = Join-Path $PSScriptRoot $module
        if (Test-Path -LiteralPath $moduleFile) { . $moduleFile }
    }
    if (-not $InputPipe -and $Op -notin @('stats','freeip')) { throw 'Restart the dashboard using its authenticated HTTPS service before making changes.' }
    if ($ops.ContainsKey($Op)) {
        $result = Invoke-OnHost $ops[$Op] $p
    } else { switch ($Op) {
        'stats' { $result = Invoke-OnHost $sbStats $null }
        'freeip' { $result = Invoke-OnHost $sbFreeIp $p }
        'preflight' { $result = Invoke-OnHost $sbProvisionInspect $p }
        'images' { $result = Invoke-OnHost $sbProvisionImageInfo $null }
        'create' { $result = Start-Provision $p }
        default { throw "Unknown op '$Op'." }
    }
    }
    [Console]::Out.WriteLine('RESULT ' + (ConvertTo-Json $result -Depth 6 -Compress))
    $code = 0
}
catch {
    [Console]::Out.WriteLine('ERROR ' + (("$($_.Exception.Message)") -replace '\s+', ' '))
    $code = 1
}
finally {
    if ($session) { Remove-PSSession $session }
}
exit $code
