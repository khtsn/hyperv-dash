# Executed on the selected Hyper-V host against the private clone of the template.
param($vm,[string]$disk,$p)
$ErrorActionPreference='Stop'
function New-WindowsAnswer([string]$computer,[string]$account,[string]$password,[string]$locale) {
    $component='processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"'
    $computer=[Security.SecurityElement]::Escape($computer)
    $account=[Security.SecurityElement]::Escape($account)
    $password=[Security.SecurityElement]::Escape($password)
    $locale=[Security.SecurityElement]::Escape($locale)
    return @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="specialize"><component name="Microsoft-Windows-Shell-Setup" $component><ComputerName>$computer</ComputerName></component></settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" $component>
      <InputLocale>$locale</InputLocale><SystemLocale>$locale</SystemLocale><UILanguage>$locale</UILanguage><UserLocale>$locale</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" $component>
      <OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE>
      <UserAccounts><LocalAccounts><LocalAccount wcm:action="add">
        <Name>$account</Name><Group>Administrators</Group><Password><Value>$password</Value><PlainText>true</PlainText></Password>
      </LocalAccount></LocalAccounts></UserAccounts>
    </component>
  </settings>
</unattend>
"@
}
function New-BootstrapPassword {
    $bytes=New-Object byte[] 32
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try {$rng.GetBytes($bytes); return ('Hvd!4'+[Convert]::ToBase64String($bytes))} finally {$rng.Dispose()}
}
$phase='answer file'
try {
    $bootstrap=New-BootstrapPassword
    $credential=[pscredential]::new(($p.name+'\'+$p.windowsGuest.user),(ConvertTo-SecureString $bootstrap -AsPlainText -Force))
    $vhd=Mount-VHD -Path $disk -NoDriveLetter -Passthru
    try {
        $volumes=@($vhd | Get-Disk | Get-Partition | Get-Volume -ErrorAction SilentlyContinue | Where-Object {
            $_.FileSystem -eq 'NTFS' -and [IO.File]::Exists($_.Path+'Windows\System32\ntoskrnl.exe')
        })
        if($volumes.Count -ne 1){throw 'Expected a Windows OS volume.'}
        $winDir=$volumes[0].Path+'Windows'
        $panther=$winDir+'\Panther'
        foreach($directory in @($winDir,$panther)){
            if([IO.Directory]::Exists($directory) -and ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint)){throw 'Redirected setup directory.'}
        }
        [IO.Directory]::CreateDirectory($panther) | Out-Null
        if([IO.File]::Exists($panther+'\Unattend\Unattend.xml')){throw 'Template has an overriding answer file.'}
        $answer=New-WindowsAnswer $p.name $p.windowsGuest.user $bootstrap $p.windowsLocale
        $bytes=[Text.Encoding]::UTF8.GetBytes($answer)
        $stream=[IO.File]::Open($panther+'\Unattend.xml','CreateNew','Write','None')
        try {$stream.Write($bytes,0,$bytes.Length)} finally {$stream.Dispose()}
    } finally {Dismount-VHD -Path $disk}
    $phase='guest startup'
    Start-VM -VM $vm | Out-Null
    Write-Host 'STEP Waiting for Windows Setup and the new local account through PowerShell Direct'
    $phase='PowerShell Direct readiness'
    $end=[datetime]::UtcNow.AddMinutes(30)
    $ready=$false
    do {
        Start-Sleep -Seconds 10
        $probe=Invoke-Command -VMId $vm.VMId -Credential $credential -AsJob -ScriptBlock {
            $state=Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State' ImageState
            $os=Get-CimInstance Win32_OperatingSystem
            if($state -eq 'IMAGE_STATE_COMPLETE' -and $os.ProductType -eq 1 -and [int]$os.BuildNumber -ge 22000){$env:COMPUTERNAME}
        }
        try {
            if(Wait-Job $probe -Timeout 20){ $ready=(Receive-Job $probe -ErrorAction SilentlyContinue) -eq $p.name }
        } finally {Remove-Job $probe -Force}
    } until ($ready -or [datetime]::UtcNow -ge $end)
    if(!$ready){throw 'Windows readiness timeout.'}

    $phase='guest configuration'
    Write-Host 'STEP Configuring the Windows guest'
    $options=$p.windowsGuest
    $mac=(Get-VMNetworkAdapter -VM $vm | Select-Object -First 1).MacAddress
    $config=Invoke-Command -VMId $vm.VMId -Credential $credential -AsJob -ArgumentList $options,$p.ip,$p.prefix,$p.gateway,$mac,$p.tailscaleAuthKey,(New-BootstrapPassword) -ScriptBlock {
        param($options,$ip,$prefix,$gateway,$mac,$tailKey,$randomPassword)
        $ErrorActionPreference='Stop'
        $phase='network configuration'
        try {
            $nic=@(Get-NetAdapter | Where-Object {($_.MacAddress -replace '[-:]','') -eq $mac})
            if($nic.Count -ne 1){throw 'Guest adapter unavailable.'}
            $index=$nic[0].ifIndex
            if($ip){
                Set-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -Dhcp Disabled
                New-NetIPAddress -InterfaceIndex $index -IPAddress $ip -PrefixLength $prefix -DefaultGateway $gateway | Out-Null
                Set-DnsClientServerAddress -InterfaceIndex $index -ServerAddresses $options.dns
            } else {
                Set-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -Dhcp Enabled
                Set-DnsClientServerAddress -InterfaceIndex $index -ResetServerAddresses
            }
            if($options.sshKeys.Count){
                $phase='OpenSSH setup'
                $capability=Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
                if($capability.State -ne 'Installed'){Add-WindowsCapability -Online -Name $capability.Name | Out-Null}
                Set-Service sshd -StartupType Automatic
                Start-Service sshd
                $keys=Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
                $existing=@(if(Test-Path -LiteralPath $keys){Get-Content -LiteralPath $keys})
                $lines=@(($existing + @($options.sshKeys)) | Select-Object -Unique)
                [IO.File]::WriteAllLines($keys,[string[]]$lines,[Text.UTF8Encoding]::new($false))
                $acl=New-Object Security.AccessControl.FileSecurity
                $acl.SetAccessRuleProtection($true,$false)
                foreach($sid in 'S-1-5-18','S-1-5-32-544'){
                    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))
                }
                Set-Acl -LiteralPath $keys -AclObject $acl
                if(Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue){Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'}
                else {New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null}
            }
            $tailIP=$null
            if($tailKey){
                $phase='Tailscale enrollment'
                $cli=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
                $scratch=Join-Path $env:TEMP ('hvdash-'+[guid]::NewGuid())
                $acl=New-Object Security.AccessControl.DirectorySecurity
                $acl.SetAccessRuleProtection($true,$false)
                foreach($sid in 'S-1-5-18','S-1-5-32-544'){
                    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
                }
                [IO.Directory]::CreateDirectory($scratch,$acl) | Out-Null
                $msi=Join-Path $scratch 'tailscale.msi'
                $key=Join-Path $scratch 'auth.key'
                try {
                    if(!(Test-Path -LiteralPath $cli)){
                        Invoke-WebRequest -UseBasicParsing -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi -TimeoutSec 180
                        $sig=Get-AuthenticodeSignature -LiteralPath $msi
                        if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.GetNameInfo('SimpleName',$false) -ne 'Tailscale Inc.'){throw 'Installer signature rejected.'}
                        $install=Start-Process msiexec.exe -ArgumentList ('/i "'+$msi+'" /qn /norestart') -Wait -PassThru
                        if($install.ExitCode -notin @(0,3010)){throw 'Installer failed.'}
                    }
                    [IO.File]::WriteAllText($key,$tailKey,[Text.UTF8Encoding]::new($false))
                    & $cli up --unattended --timeout=90s ("--auth-key=file:"+$key) *> $null
                    if($LASTEXITCODE){throw 'Enrollment failed.'}
                    $status=& $cli status --json | ConvertFrom-Json
                    if($LASTEXITCODE -or $status.BackendState -ne 'Running' -or !$status.Self.Online -or !$status.TailscaleIPs){throw 'Not online.'}
                    $tailIP=[Net.IPAddress]::Parse(@($status.TailscaleIPs)[0]).ToString()
                } finally {[IO.File]::Delete($key);[IO.File]::Delete($msi);[IO.Directory]::Delete($scratch)}
            }
            $phase='local account setup'
            if($options.expandOS){
                $osPart=Get-Partition -DriveLetter $env:SystemDrive[0]
                $limit=$osPart | Get-PartitionSupportedSize
                if($limit.SizeMax -gt $osPart.Size + 1MB){$osPart | Resize-Partition -Size $limit.SizeMax}
            }
            $finalPassword=if($options.password){$options.password}else{$randomPassword}
            Set-LocalUser -Name $options.user -Password (ConvertTo-SecureString $finalPassword -AsPlainText -Force)
            $answer=Join-Path $env:SystemRoot 'Panther\Unattend.xml'
            if(Test-Path -LiteralPath $answer){Remove-Item -LiteralPath $answer -Force}
            [pscustomobject]@{ready=$true;tailscaleIP=$tailIP}
        } catch { [pscustomobject]@{ready=$false;phase=$phase} }
    }
    try {
        if(!(Wait-Job $config -Timeout 1200)){throw 'Guest configuration timeout.'}
        $result=Receive-Job $config -ErrorAction Stop
        if(!$result.ready){if($result.phase){$phase=$result.phase};throw 'Guest configuration failed.'}
        return $result
    } finally {Remove-Job $config -Force}
} catch {throw "Windows setup failed during $phase."}
