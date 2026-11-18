# No Hyper-V host is contacted. These functions replace the host cmdlets.
$ErrorActionPreference='Stop'
$ops=@{}
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'fleet-ops.ps1')
function Get-VMHost { [pscustomobject]@{} }
function Get-Service {param([string]$Name) [pscustomobject]@{Name=$Name;Status='Running'} }
function Get-Counter {
    param($Counter, $ErrorAction)
    $samples = foreach ($path in $Counter) {
        $instance = switch -Wildcard ($path) {
            '\Network Interface*' { 'ethernet' }
            '\LogicalDisk*' { 'd:' }
            '\Hyper-V Virtual Network Adapter*' { 'vm-guid__vm-guid--12345678-0000-0000-0000-000000000001' }
            '\Hyper-V Virtual Storage Device*' { '--?-d:-fixture.vhdx' }
        }
        $value = if ($path -like '*Latency' -or $path -like '*sec/Transfer') {0.0025} else {2048}
        $status = if ($path -like '*Write Bytes/sec') {2147485648} else {0}
        [pscustomobject]@{InstanceName=$instance;Path=$path;CookedValue=$value;Status=$status}
    }
    [pscustomobject]@{CounterSamples=$samples}
}
function Get-CimInstance {
    param([string]$ClassName,[string]$Filter)
    switch($ClassName){
        Win32_OperatingSystem { [pscustomobject]@{Caption='Fake OS';BuildNumber=17763;TotalVisibleMemorySize=8192KB;FreePhysicalMemory=4096KB;LastBootUpTime=[datetime]'2026-11-10'} }
        Win32_ComputerSystemProduct { [pscustomobject]@{UUID='db11b1b6-c919-42a4-85a2-9dabde51e08a'} }
        Win32_Processor { [pscustomobject]@{Name='CPU';NumberOfCores=4;NumberOfLogicalProcessors=8;LoadPercentage=30} }
        Win32_LogicalDisk { [pscustomobject]@{DeviceID='D:';Size=400GB;FreeSpace=250GB} }
        default { throw 'unexpected CIM class' }
    }
}
function Get-NetAdapter { param([switch]$IncludeHidden) [pscustomobject]@{MacAddress='AA-BB-CC-DD-11-22';InterfaceDescription='Hyper-V Virtual Ethernet Adapter';ifIndex=5} }
function Get-NetIPAddress { param($AddressFamily) [pscustomobject]@{InterfaceIndex=5;IPAddress='10.20.1.1';PrefixLength=24} }
function Get-VMNetworkAdapter {
    param([switch]$All)
    [pscustomobject]@{Name='management';IsManagementOs=$true;SwitchId='s';MacAddress='AABBCCDD1122'}
    [pscustomobject]@{Name='eth0';Id='Microsoft:vm-guid\12345678-0000-0000-0000-000000000001';IsManagementOs=$false;SwitchId='s';SwitchName='switch';VMId='v';VMName='testVM';IPAddresses=@('10.20.1.4')}
}
function Get-VMSwitch { [pscustomobject]@{Id='s';Name='switch';SwitchType='Internal';NetAdapterInterfaceDescriptions=@()} }
function Get-VM { [pscustomobject]@{Id='v';Name='testVM';Notes='hvdash';State='Running';CPUUsage=10;ProcessorCount=2;MemoryAssigned=1024MB;MemoryStartup=2048MB;Uptime=[timespan]::FromMinutes(2)} }
function Get-VMHardDiskDrive {param($VM) [pscustomobject]@{Path='D:\fixture.vhdx'} }
function Get-VHD {param($Path) [pscustomobject]@{Size=22GB} }
function Get-Item {param($Path) [pscustomobject]@{VersionInfo=[pscustomobject]@{ProductVersion='10.0.fixture'}} }
$result=& $ops['fleet.stats'] @{}
$nic = $result.io | Where-Object kind -eq 'nic'
$volume = $result.io | Where-Object kind -eq 'disk'
$vnic = $result.vms[0].io | Where-Object kind -eq 'nic'
$disk = $result.vms[0].io | Where-Object kind -eq 'disk'
if($nic.receiveBps -ne 2048 -or $volume.latencyMs -ne 2.5 -or $vnic.sendBps -ne 2048 -or
   $disk.readBps -ne 2048 -or $disk.latencyMs -ne 2.5 -or $null -ne $disk.writeBps) {throw 'Incorrect device metrics'}
if($result.cores -ne 4 -or $result.logicalProcessors -ne 8 -or $result.provisionedDiskGB -ne 22 -or
   $result.networks[0].adapters.Count -ne 2 -or $result.networks[0].type -ne 'Internal' -or
   $result.networks[0].ipv4[0].address -ne '10.20.1.1' -or $result.vms[0].ips[0] -ne '10.20.1.4' -or
   $result.vms[0].startupMB -ne 2048 -or $result.disks[0].freeGB -ne 250 -or $result.uuid -ne 'db11b1b6-c919-42a4-85a2-9dabde51e08a') {
    throw 'Incorrect host/VM inventory and capacity metrics'
}
if((& $ops['fleet.test']).os -ne 'Fake OS'){throw 'Connection test did not read host facts'}
Write-Output 'collector fixture passed'
