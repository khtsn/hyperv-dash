# Provisioning operations invoked from hv.ps1 after remoting is established.
# Always pass input as data, including the cloud-config and network settings.
$sbProvisionInspect = {
    param($p)
    $ErrorActionPreference = 'Stop'
    if ($p.name -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,30}$' -or $p.name -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') { throw 'Invalid VM name.' }
    if ($p.volume -notmatch '^[A-Z]:$') { throw 'Select a local fixed drive.' }
    $vol = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $p.volume -and $_.DriveType -eq 3 }
    if (!$vol) { throw 'The selected local volume is unavailable.' }
    $margin = [math]::Max(10GB, [double]$vol.Size * 0.1)
    $needed = [int64]$p.diskGB * 1GB + 64MB
    if ($vol.FreeSpace - $needed -lt $margin) { throw 'Insufficient safe disk capacity. Select a larger volume or reduce the virtual disk size; reserve 10 GiB or 10 percent, whichever is larger.' }
    $os = Get-CimInstance Win32_OperatingSystem
    if (($os.FreePhysicalMemory * 1KB) -lt ([int64]$p.memMB * 1MB + 512MB)) { throw 'Insufficient available host memory. Reduce the VM memory or choose another host.' }
    if (Get-VM | Where-Object Name -eq $p.name) { throw 'VM name exists. Choose a unique name.' }
    $sw = Get-VMSwitch | Where-Object Name -eq $p.switch | Select-Object -First 1
    if (!$sw) { throw 'Switch no longer exists. Refresh host inventory.' }
    $root = Join-Path ($vol.DeviceID + '\') 'hvdash'
    if ((Test-Path -LiteralPath $root) -and ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Storage root is a reparse point. Choose another volume.' }
    if (Test-Path -LiteralPath (Join-Path $root $p.name)) { throw 'The target VM folder already exists. Select a different VM name.' }
    if ($p.ip) {
        $ip = [string]$p.ip
        $guestAddresses = @(Get-VM | Get-VMNetworkAdapter | Where-Object SwitchName -eq $sw.Name | ForEach-Object IPAddresses)
        if ($ip -in $guestAddresses -or (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $ip)) { throw 'Static IP is already assigned. Pick another address.' }
        $management = @(Get-VMNetworkAdapter -ManagementOS | Where-Object SwitchName -eq $sw.Name)
        $macs = @($management | ForEach-Object {$_.MacAddress -replace '[-:]',''})
        $indices = @(Get-NetAdapter | Where-Object { ($_.MacAddress -replace '[-:]','') -in $macs } | ForEach-Object ifIndex)
        $usedStates = 'Reachable','Stale','Delay','Probe','Permanent'
        if ($indices.Count -gt 0) {
            $routes=@(Get-NetRoute -AddressFamily IPv4 | Where-Object {$_.ifIndex -in $indices -and $_.NextHop -eq '0.0.0.0'})
            $wanted=[Net.IPAddress]::Parse($ip).GetAddressBytes()
            $direct=$false
            foreach($r in $routes){
                $net,$bits=$r.DestinationPrefix -split '/'
                $bytes=[Net.IPAddress]::Parse($net).GetAddressBytes()
                $match=$true
                for($i=0;$i -lt [int]$bits;$i++){
                    $byte=$i -shr 3; $mask=128 -shr ($i % 8)
                    if(($wanted[$byte] -band $mask) -ne ($bytes[$byte] -band $mask)){$match=$false;break}
                }
                if($match -and [int]$bits -gt 0){$direct=$true;break}
            }
            if(!$direct){throw 'The supplied address is not on a directly connected subnet of this switch. Use DHCP or correct its prefix/gateway.'}
            # Limit the neighbour lookup to the chosen switch's L2 domain.
            $neighbors = Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.ifIndex -in $indices -and $_.IPAddress -eq $ip -and "$($_.State)" -in $usedStates }
            if ($neighbors) { throw 'Static IP exists in the switch neighbour table. Pick another address.' }
            $ping = New-Object Net.NetworkInformation.Ping
            try { if (($ping.Send($ip,800)).Status -eq 'Success') { throw 'Static IP answered a probe. Pick another address.' } }
            finally { $ping.Dispose() }
            if (Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.ifIndex -in $indices -and $_.IPAddress -eq $ip -and "$($_.State)" -in $usedStates }) { throw 'Static IP answered ARP. Pick another address.' }
        } else {
            throw 'Cannot check for IP conflicts from this host on the selected switch. Connect a management adapter or use DHCP.'
        }
    }
    [pscustomobject]@{dir=$root; freeBytes=[int64]$vol.FreeSpace; marginBytes=[int64]$margin}
}
$sbProvisionImageInfo = {
    param($p)
    $ErrorActionPreference = 'Stop'
    $root = [IO.Path]::GetFullPath((Get-VMHost).VirtualHardDiskPath)
    $dir = Join-Path $root 'hvdash-image-library-v1'
    $base = Join-Path $dir 'debian-13-base.vhdx'
    $manifest = "$base.json"
    $info = [ordered]@{base=$base;dir=$dir;present=$false;sha256=$null;sizeBytes=0;version='13'}
    if ((Test-Path -LiteralPath $base) -and (Test-Path -LiteralPath $manifest)) {
        $m = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
        $item = Get-Item -LiteralPath $base
        $info.sizeBytes=$item.Length; $info.version=$m.version; $info.sha256=$m.sha256
        $info.present=($m.sizeBytes -eq $item.Length -and $item.LastWriteTimeUtc.Ticks.ToString() -eq $m.ticks -and $m.sha256 -match '^[a-f0-9]{64}$')
    }
    [pscustomobject]$info
}
function Get-ProvisionImage {
    param([string]$cacheDir = (Join-Path $PSScriptRoot 'cache\catalog-v1\debian-13'))
    # Rebuild old prototype caches without provenance into a separately named cache.
    [IO.Directory]::CreateDirectory($cacheDir) | Out-Null
    $manifestFile=Join-Path $cacheDir 'manifest.json'
    $base=Join-Path $cacheDir $BaseName
    if ((Test-Path -LiteralPath $manifestFile) -and (Test-Path -LiteralPath $base)) {
        $m=Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
        if ($m.archiveSha512 -match '^[a-f0-9]{128}$' -and (Get-FileHash $base -Algorithm SHA256).Hash -eq $m.sha256) {return [pscustomobject]@{path=$base;manifest=$m}}
        throw 'Local image verification failed. Quarantine the catalog cache and rebuild it before provisioning.'
    }
    $work=Join-Path $cacheDir ('build-'+[guid]::NewGuid())
    [IO.Directory]::CreateDirectory($work) | Out-Null
    try {
        $curl=Join-Path $env:SystemRoot 'System32\curl.exe'
        $tar=Join-Path $env:SystemRoot 'System32\tar.exe'
        $archive=Join-Path $work $ImageFile
        Write-Host 'STEP Downloading Debian 13 and its official SHA512 manifest'
        $sums=& $curl --proto '=https' -fsSL --retry 2 --max-time 45 "$ImageUrl/SHA512SUMS"
        if ($LASTEXITCODE) {throw 'Could not fetch the Debian checksum manifest.'}
        $want=@($sums | ForEach-Object { if ($_ -match ('^([a-fA-F0-9]{128})\s+\*?'+[regex]::Escape($ImageFile)+'$')) {$matches[1].ToLowerInvariant()} })
        if ($want.Count -ne 1) {throw 'Debian checksum manifest did not contain a unique archive checksum.'}
        & $curl --proto '=https' -fsSL --retry 2 --max-time 900 -o $archive "$ImageUrl/$ImageFile"
        if ($LASTEXITCODE -or (Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash -ne $want[0]) {throw 'Debian archive download or SHA512 verification failed.'}
        Write-Host 'STEP Verified upstream archive; converting Debian base to VHDX'
        $entries=@(& $tar -tf $archive)
        $raw=@($entries | Where-Object {$_ -match '^(\./)?[A-Za-z0-9_-]+\.raw$'})
        if ($LASTEXITCODE -or $raw.Count -ne 1) {throw 'No unique raw disk found in the verified archive.'}
        & $tar -xf $archive -C $work $raw[0]
        if ($LASTEXITCODE) {throw 'Failed extracting the verified Debian image.'}
        $rawPath=Join-Path $work $raw[0]
        Add-VhdFooter $rawPath
        $vhd=Join-Path $work 'source.vhd';$converted=Join-Path $work 'verified.vhdx'
        Move-Item -LiteralPath $rawPath -Destination $vhd
        & fsutil.exe sparse setflag $vhd 0 | Out-Null
        if ($LASTEXITCODE) {throw 'Unable to prepare the source VHD for conversion.'}
        Convert-VHD -Path $vhd -DestinationPath $converted -VHDType Dynamic
        $hash=(Get-FileHash -LiteralPath $converted -Algorithm SHA256).Hash.ToLowerInvariant()
        $m=[ordered]@{sha256=$hash;archiveSha512=$want[0];sizeBytes=(Get-Item -LiteralPath $converted).Length;version=('13-'+$want[0].Substring(0,12))}
        Move-Item -LiteralPath $converted -Destination $base -Force
        [IO.File]::WriteAllText($manifestFile,($m | ConvertTo-Json -Compress))
        return [pscustomobject]@{path=$base;manifest=$m}
    } finally {
        # Work is a newly-created random child of the exact catalog directory.
        $full=[IO.Path]::GetFullPath($work)
        if ([IO.Path]::GetDirectoryName($full) -eq [IO.Path]::GetFullPath($cacheDir) -and [IO.Path]::GetFileName($full) -match '^build-[a-f0-9-]{36}$') {
            foreach ($f in @(Get-ChildItem -LiteralPath $full -File)) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
            if ((Get-ChildItem -LiteralPath $full | Measure-Object).Count -eq 0) {[IO.Directory]::Delete($full)}
        }
    }
}
