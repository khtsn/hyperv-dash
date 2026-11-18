$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$project = Split-Path -Parent $PSScriptRoot
$base = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$runId = 'hvdash-ops-' + [guid]::NewGuid().ToString('N')
$dir = Join-Path $base $runId
[IO.Directory]::CreateDirectory($dir) | Out-Null
$state = Join-Path $dir 'state'
$logs = Join-Path $dir 'logs'
$archives = Join-Path $dir 'backups'
$wrapper = Join-Path $dir 'wrapper'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$oldData = $env:HVDASH_DATA
$oldPassword = $env:HVDASH_ACCOUNT_PASSWORD
$oldFake = $env:HVDASH_FAKE
$oldFixtureCipher = $env:HVDASH_TEST_CIPHER
try {
    foreach ($file in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1')) {
        $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
        if ($errors) { throw ($errors -join ', ') }
    }
    & (Join-Path $PSScriptRoot 'service.ps1') -Action Prepare -StateDirectory $state -LogDirectory $logs -BackupDirectory $archives -Account $user
    & (Join-Path $PSScriptRoot 'service.ps1') -Action Build -WrapperDirectory $wrapper
    $exe = Join-Path $wrapper 'HyperVDashService.exe'
    [void][Reflection.AssemblyName]::GetAssemblyName($exe)
    # Invoke the same ServiceBase methods SCM invokes, inside a child PowerShell
    # process so Windows can release the loaded EXE before fixture cleanup.
    $fixture = Join-Path $dir 'fixture'
    [void][IO.Directory]::CreateDirectory($fixture)
    [IO.File]::WriteAllText((Join-Path $fixture 'server.mjs'), @'
import {writeFileSync} from 'node:fs';
writeFileSync('up.json',JSON.stringify({service:process.env.HVDASH_WINDOWS_SERVICE,port:process.env.HVDASH_PORT,data:process.env.HVDASH_DATA}));
process.stdin.on('data',b=>{if(b.toString().trim()==='shutdown'){writeFileSync('down.txt','ok');process.exit(0);}});
'@)
    $xml = [xml]'<service/>'
    foreach ($kv in @{node=(Get-Command node.exe).Source;app=$fixture;data=$state;logs=$logs;bind='127.0.0.1';port='19991';origin='https://localhost:19991'}.GetEnumerator()) {
        $xml.DocumentElement.SetAttribute($kv.Key, $kv.Value)
    }
    $xmlFile = Join-Path $dir 'fixture.xml'
    $xml.Save($xmlFile)
    $runner = Join-Path $dir 'exercise.ps1'
    [IO.File]::WriteAllText($runner,@'
param($exe,$xmlFile,$fixture)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.ServiceProcess
$type=[Reflection.Assembly]::LoadFrom($exe).GetType('DashboardService',$true)
$obj=$type.GetConstructor('Instance,NonPublic',$null,@([string]),$null).Invoke(@($xmlFile))
$flags=[Reflection.BindingFlags]'Instance,NonPublic'
$start=$type.GetMethod('OnStart',$flags)
$stop=$type.GetMethod('OnStop',$flags)
$start.Invoke($obj,@(,[string[]]@()))
try {
    $up=Join-Path $fixture 'up.json'
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    while (!(Test-Path -LiteralPath $up) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    $status=Get-Content -Raw -LiteralPath $up | ConvertFrom-Json
    if ($status.service -ne '1' -or $status.port -ne '19991') { throw 'Invalid service environment.' }
} finally { $stop.Invoke($obj,@()) }
if (!(Test-Path -LiteralPath (Join-Path $fixture 'down.txt'))) { throw 'Graceful shutdown did not reach the application.' }
'@)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner $exe $xmlFile $fixture
    if ($LASTEXITCODE) { throw 'Service lifecycle test failed.' }
    $env:HVDASH_DATA = $state
    $env:HVDASH_ACCOUNT_PASSWORD = [guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()
    $env:HVDASH_FAKE = '1'
    & node (Join-Path $project 'admin.mjs') init ops-test
    if ($LASTEXITCODE) { throw 'Fixture initialization failed.' }
    $fixtureTool = Join-Path $dir 'fixture-db.mjs'
    [IO.File]::WriteAllText($fixtureTool,@'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const db=new DatabaseSync(join(process.argv[2],'fleet.sqlite'));
if (process.argv[3]==='seed'){
 db.prepare("INSERT INTO kv VALUES ('hosts','test',?)").run(JSON.stringify({credential:{user:'test',secret:process.env.HVDASH_TEST_CIPHER}}));
 db.prepare("INSERT INTO sessions VALUES ('test','ops-test','x',18,19)").run();
 db.prepare("INSERT INTO jobs(id,host,name,actor,op,status,started) VALUES('j','h','n','ops-test','create','running','2026-01-01')").run();
 db.prepare("INSERT INTO ip_ledger VALUES ('n','192.0.2.10','h','n','static')").run();
} else {
 assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n,0);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='j'").get().status,'interrupted');
 const {credential}=JSON.parse(db.prepare("SELECT value FROM kv WHERE category='hosts' AND id='test'").get().value);
 assert.equal(credential.secret,process.env.HVDASH_TEST_CIPHER);
 assert.equal(db.prepare("SELECT count(*) AS n FROM ip_ledger WHERE address='192.0.2.10'").get().n,1);
 assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE action='restore'").get().n,1);
}
db.close();
'@)
    Add-Type -AssemblyName System.Security
    $secret=[guid]::NewGuid().ToString()
    $env:HVDASH_TEST_CIPHER=[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect(
        [Text.Encoding]::UTF8.GetBytes($secret),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
    & node $fixtureTool $state seed
    if ($LASTEXITCODE) { throw 'Fixture seeding failed.' }
    $snapshot = Join-Path $archives 'snapshot'
    $restored = Join-Path $dir 'restored'
    $recovery = Join-Path $PSScriptRoot 'recovery.ps1'
    & $recovery -Action Backup -StateDirectory $state -BackupDirectory $snapshot
    & $recovery -Action Verify -BackupDirectory $snapshot
    & $recovery -Action Restore -BackupDirectory $snapshot -RestoreDirectory $restored
    & node $fixtureTool $restored verify
    if ($LASTEXITCODE) { throw 'Restore content check failed.' }
    $restoredCipher = & node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.parse(db.prepare('SELECT value FROM kv WHERE category=? AND id=?').get('hosts','test').value).credential.secret);db.close()" (Join-Path $restored 'fleet.sqlite')
    if ($LASTEXITCODE -or [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($restoredCipher),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)) -cne $secret) {
        throw 'DPAPI credential roundtrip failed.'
    }
    Add-Content -LiteralPath (Join-Path $snapshot 'tls\cert.pem') -Value 'tampered'
    $rejected=$false
    try { & $recovery -Action Verify -BackupDirectory $snapshot } catch { $rejected = $_.Exception.Message -like '*checksum mismatch*' }
    if (!$rejected) { throw 'Tampered snapshot was accepted.' }
    Write-Output 'PASS: service build, lifecycle, ACL setup, backup, restore and checksum rejection.'
} finally {
    $env:HVDASH_DATA=$oldData; $env:HVDASH_ACCOUNT_PASSWORD=$oldPassword; $env:HVDASH_FAKE=$oldFake; $env:HVDASH_TEST_CIPHER=$oldFixtureCipher
    $actual = (Resolve-Path -LiteralPath $dir -ErrorAction Stop).Path
    if ([IO.Path]::GetDirectoryName($actual) -eq $base -and [IO.Path]::GetFileName($actual) -eq $runId -and $runId -match '^hvdash-ops-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $actual -Recurse -Force
    }
}
