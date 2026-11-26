# Persistent stdin/stdout console protocol. Device operations run on the VM's host.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$session=$null
$serialOp = {
    param($op)
    $ErrorActionPreference='Stop'
    switch ($op.command) {
        'open' {
            $vm=Get-VM -Id ([guid]$op.id)
            if ($vm.State -ne 'Running') { throw 'Start the VM before opening its console.' }
            $pipeName="hvdash-$($vm.Id)"
            $com=Get-VMComPort -VM $vm -Number 1
            if ($com.Path -ne "\\.\pipe\$pipeName") { throw 'Configure COM1 for this VM first.' }
            $global:hvSerialPipe=[IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
            $global:hvSerialPipe.Connect(4000)
            $global:hvSerialBuf=New-Object byte[] 8192
            $global:hvSerialRead=$global:hvSerialPipe.ReadAsync($global:hvSerialBuf,0,8192)
            return 'ready'
        }
        'read' {
            if (!$global:hvSerialRead.IsCompleted) { return '' }
            $n=$global:hvSerialRead.GetAwaiter().GetResult()
            if ($n -le 0) { throw 'The guest serial pipe closed.' }
            $data=[Convert]::ToBase64String($global:hvSerialBuf,0,$n)
            $global:hvSerialRead=$global:hvSerialPipe.ReadAsync($global:hvSerialBuf,0,8192)
            return $data
        }
        'write' {
            $bytes=[Convert]::FromBase64String($op.bytes)
            if ($bytes.Length -gt 4096) { throw 'Serial write is too large.' }
            $task=$global:hvSerialPipe.WriteAsync($bytes,0,$bytes.Length)
            if (!$task.Wait(3000)) { throw 'Timed out writing to serial console.' }
            return ''
        }
        'close' { if ($global:hvSerialPipe) {$global:hvSerialPipe.Dispose()}; return '' }
        default {throw 'Unsupported serial operation'}
    }
}
function Send([bool]$Ok,[string]$Value){ [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ok=$Ok;value=$Value} -Compress)); [Console]::Out.Flush() }
try {
    $cfg=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())) | ConvertFrom-Json
    $deviceOp=$serialOp
    if($cfg.mode -eq 'screen'){
        . (Join-Path $PSScriptRoot 'screen-bridge.ps1')
        $deviceOp=$screenOp
    }
    if ($cfg.transport -in @('winrm','winrm-https')) {
        $opts=@{ComputerName=[string]$cfg.address; SessionOption=(New-PSSessionOption -OpenTimeout 8000 -OperationTimeout 15000)}
        if ($cfg.transport -eq 'winrm-https') {$opts.UseSSL=$true}
        if ($cfg.credential) {
            Add-Type -AssemblyName System.Security
            $clear=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($cfg.credential.secret),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
            try {
                $plain=[Text.Encoding]::UTF8.GetString($clear)
                if ($cfg.credential.format -eq 2) {
                    $pair=$plain | ConvertFrom-Json
                    $user=[string]$pair.user; $pass=[string]$pair.password
                } else { $user=[string]$cfg.credential.user; $pass=$plain }
                if (!$user -or !$pass){throw 'Missing stored remoting credential.'}
                $opts.Credential=New-Object pscredential($user,(ConvertTo-SecureString $pass -AsPlainText -Force))
            } finally { [Array]::Clear($clear,0,$clear.Length); $plain=$null; $pair=$null; $pass=$null }
        } elseif ($cfg.userEnv) {
            $user=[Environment]::GetEnvironmentVariable($cfg.userEnv);$pass=[Environment]::GetEnvironmentVariable($cfg.passEnv)
            if (!$user -or !$pass){throw 'Missing remoting credential.'}
            $opts.Credential=New-Object pscredential($user,(ConvertTo-SecureString $pass -AsPlainText -Force))
        }
        $session=New-PSSession @opts
    } elseif ($cfg.transport -ne 'local'){throw 'Unsupported console transport.'}
    $op=@{command='open';id=$cfg.id}
    while ($op) {
        $reply=if($session){Invoke-Command -Session $session -ScriptBlock $deviceOp -ArgumentList $op}else{& $deviceOp $op}
        Send $true ([string]$reply)
        if ($op.command -eq 'close') { break }
        $line=[Console]::ReadLine()
        if ($null -eq $line){break}
        $op=$line | ConvertFrom-Json
    }
} catch {
    Send $false 'Console connection failed.'
} finally {
    if($cfg.mode -eq 'screen' -and $deviceOp){
        try {
            if($session){$null=Invoke-Command -Session $session -ScriptBlock $deviceOp -ArgumentList @{command='close'}}
            else {$null=& $deviceOp @{command='close'}}
        } catch {}
    }
    if ($session){ Remove-PSSession $session -ErrorAction SilentlyContinue } elseif($global:hvSerialPipe){$global:hvSerialPipe.Dispose()}
}
