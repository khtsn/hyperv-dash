[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Prepare','Build','Install','UseState','Start','Stop','Remove','Status')][string]$Action,
    [PSCredential]$Credential,
    [string]$Account,
    [string]$AppDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$NodePath,
    [string]$StateDirectory = (Join-Path $env:ProgramData 'HyperVDash\state'),
    [string]$LogDirectory = (Join-Path $env:ProgramData 'HyperVDash\logs'),
    [string]$BackupDirectory = (Join-Path $env:ProgramData 'HyperVDash\backups'),
    [string]$WrapperDirectory = (Join-Path $env:ProgramFiles 'HyperVDashService'),
    [string]$Bind = '127.0.0.1',
    [ValidateRange(1,65535)][int]$Port = 8722,
    [string]$Origin
)
. (Join-Path $PSScriptRoot 'paths.ps1')
$name = 'HyperVDash'

function Build-Wrapper([string]$TargetDirectory) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (!(Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework 4.x C# compiler is required on the management machine.' }
    $exe = Join-Path $TargetDirectory 'HyperVDashService.exe'
    if (Test-Path -LiteralPath $exe) { throw "Wrapper already exists: $exe" }
    & $compiler /nologo /target:winexe /optimize+ "/out:$exe" /reference:System.ServiceProcess.dll (Join-Path $PSScriptRoot 'HyperVDashService.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Service wrapper build failed.' }
    return $exe
}

switch ($Action) {
    'Build' {
        $wrapper = Resolve-HvPath $WrapperDirectory
        [IO.Directory]::CreateDirectory($wrapper) | Out-Null
        Build-Wrapper $wrapper
    }
    'Prepare' {
        if (!$Account) { throw 'Pass -Account DOMAIN\service-user (or MACHINE\service-user).' }
        $sid = Resolve-HvSid $Account
        foreach ($dir in @($StateDirectory,$LogDirectory,$BackupDirectory)) {
            if (Test-Path -LiteralPath (Resolve-HvPath $dir)) { throw "Prepare requires three new directories. Already exists: $dir" }
        }
        New-HvPrivateDir $StateDirectory $sid
        New-HvPrivateDir $LogDirectory $sid
        New-HvPrivateDir $BackupDirectory $sid
    }
    'Install' {
        if (!$Credential) { throw 'Supply the service identity with -Credential (Get-Credential).' }
        if (Get-Service $name -ErrorAction SilentlyContinue) { throw 'The HyperVDash service is already installed.' }
        if (!$Origin) { $Origin = "https://localhost:$Port" }
        $uri = [Uri]$Origin
        if (!$uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo -or $uri.AbsolutePath -ne '/') { throw 'Origin must be an HTTPS origin, for example https://dashboard.example:8722.' }
        $app = Resolve-HvPath $AppDirectory
        $state = Resolve-HvPath $StateDirectory
        $logs = Resolve-HvPath $LogDirectory
        foreach ($p in @((Join-Path $app 'server.mjs'),(Join-Path $state 'fleet.sqlite'),(Join-Path $state 'tls\cert.pem'),(Join-Path $state 'tls\key.pem'))) {
            if (!(Test-Path -LiteralPath (Resolve-HvPath $p) -PathType Leaf)) { throw "Missing $p. Prepare and initialize state before installation." }
        }
        if (!(Test-Path -LiteralPath $logs -PathType Container)) { throw 'Prepare the log directory before installing.' }
        if (!$NodePath) { $NodePath = (Get-Command node.exe -CommandType Application).Source }
        $node = Resolve-HvPath $NodePath
        if (!(Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node executable missing.' }
        $sid = Resolve-HvSid $Credential.UserName
        # Source files belong to the administrator deploying the release. Add
        # read-only access for the runtime; its image cache is a separate ACL.
        $appAcl = Get-Acl -LiteralPath $app
        $read = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
        $appAcl.AddAccessRule($read)
        Set-Acl -LiteralPath $app -AclObject $appAcl
        $cache = Resolve-HvPath (Join-Path $app 'cache')
        if (!(Test-Path -LiteralPath $cache)) { [IO.Directory]::CreateDirectory($cache) | Out-Null }
        Set-HvAcl $cache $sid Modify
        Set-HvAcl $state $sid Modify
        Set-HvAcl $logs $sid Modify
        Set-HvAcl (Join-Path $state 'tls') $sid ReadAndExecute
        Set-HvAcl (Join-Path $state 'tls\key.pem') $sid Read
        Set-HvAcl (Join-Path $state 'tls\cert.pem') $sid Read
        $wrapper = New-HvPrivateDir $WrapperDirectory $sid ReadAndExecute
        $exe = Build-Wrapper $wrapper
        $config = Join-Path $wrapper 'service.xml'
        $doc = New-Object Xml.XmlDocument
        $element = $doc.CreateElement('service')
        foreach ($pair in @{node=$node;app=$app;data=$state;logs=$logs;bind=$Bind;port="$Port";origin=$Origin.TrimEnd('/');identity=$sid.Value}.GetEnumerator()) {
            $element.SetAttribute($pair.Key,$pair.Value)
        }
        $null = $doc.AppendChild($element)
        $doc.Save($config)
        New-Service -Name $name -DisplayName 'Hyper-V Dash' -Description 'Hyper-V fleet management API' -StartupType Automatic -Credential $Credential -BinaryPathName ('"{0}" "{1}"' -f $exe,$config) | Out-Null
        & sc.exe failure $name reset= 3600 actions= restart/10000/restart/30000/restart/60000
        if ($LASTEXITCODE) { throw 'Service installed, but SCM failure policy was not applied. Inspect its Recovery settings before starting.' }
        Write-Output "Installed $name (Automatic). Run service.ps1 -Action Start."
    }
    'UseState' {
        if ((Get-Service $name).Status -ne 'Stopped') { throw 'Stop the service before switching its database.' }
        $config = Resolve-HvPath (Join-Path $WrapperDirectory 'service.xml')
        $doc = New-Object Xml.XmlDocument
        $doc.XmlResolver = $null
        $doc.Load($config)
        $state = Resolve-HvPath $StateDirectory
        & $doc.DocumentElement.GetAttribute('node') (Join-Path $PSScriptRoot 'check-snapshot.mjs') check $state
        if ($LASTEXITCODE) { throw 'The target state failed validation.' }
        $doc.DocumentElement.SetAttribute('data', $state)
        $tmp = Join-Path $WrapperDirectory ('service-' + [guid]::NewGuid().ToString('N') + '.xml')
        $doc.Save($tmp)
        [IO.File]::Replace($tmp, $config, ($config + '.previous'))
        Write-Output "Service configured for $state. The previous state directory is still available."
    }
    'Start' { Start-Service $name; (Get-Service $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(30)); Get-Service $name }
    'Stop' { Stop-Service $name; (Get-Service $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30)); Get-Service $name }
    'Remove' {
        $service = Get-Service $name
        if ($service.Status -ne 'Stopped') { throw 'Stop the service before removing its registration.' }
        & sc.exe delete $name
        if ($LASTEXITCODE) { throw 'Service registration removal failed.' }
        Write-Output 'Service registration removed. Keep the wrapper archive, data and backups for rollback.'
    }
    'Status' { Get-Service $name }
}
