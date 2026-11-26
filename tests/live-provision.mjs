// Explicit opt-in: creates one real local VM, then deletes only that recorded VM.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import {removeFixture} from './temp-state.mjs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import {once} from 'node:events';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
if(process.argv[2]!=='--create-and-delete-local-vm')throw Error('Pass --create-and-delete-local-vm to allocate a real temporary Hyper-V guest.');
const windows=process.argv[3]==='--windows-11';
if(process.argv[3] && !windows)throw Error('Unknown image option.');
const root=fileURLToPath(new URL('../',import.meta.url)), tmp=mkdtempSync(path.join(os.tmpdir(),'hvdash-live-')),data=path.join(tmp,'state');
const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin='https://127.0.0.1:'+port,pass=randomBytes(32).toString('base64url'),env={...process.env,HVDASH_DATA:data,HVDASH_PORT:String(port),HVDASH_ORIGIN:origin,HVDASH_BIND:'127.0.0.1',HVDASH_FAKE:'0',HVDASH_ACCOUNT_PASSWORD:pass};
delete env.HVDASH_SLACK_WEBHOOK;
const name=(windows?'hvwin-':'hvdash-qa-')+randomBytes(4).toString('hex');
function run(args){const r=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('Test initialization failed: '+r.stderr);}
run(['--input-type=module','-e',"import {put} from './store.mjs';put('meta','imported',true);"]);
run(['admin.mjs','init','lab-verifier']);delete env.HVDASH_ACCOUNT_PASSWORD;
const ca=readFileSync(path.join(data,'tls','cert.pem'));
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
server.stdout.resume();server.stderr.resume();
let cookie='',csrf='';
async function api(url,body){
 return new Promise((resolve,reject)=>{
  const req=https.request(origin+url,{method:body?'POST':'GET',ca,timeout:60000,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf}},res=>{
   let text='';res.on('data',x=>text+=x);res.on('end',()=>{
    if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];
    let value;try{value=JSON.parse(text);}catch{return reject(Error('Invalid response on '+url));}
    if(res.statusCode>=400)return reject(Error(res.statusCode+' '+value.error));
    resolve(value);
   });
  });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('API timeout')));req.end(body?JSON.stringify(body):undefined);
 });
}
async function job(id){
 const end=Date.now()+55*60_000;let n=0;
 while(Date.now()<end){const j=await api('/api/job?id='+id);for(const line of j.log.slice(n))console.log(line);n=j.log.length;
  if(j.status==='done')return;if(j.status!=='running')throw Error(j.op+' '+j.status);await delay(1500);}
 throw Error('Job timed out.');
}
console.log('Acceptance state: '+data+'; VM: '+name);
const target={host:'local-acceptance',name};
let created=false, passed=false;
async function removeOwned(){
 const detail=await api('/api/vm?host=local-acceptance&name='+name);
 assert(detail.managed && detail.id && detail.name===name,'Cannot establish ownership of acceptance VM');
 const op={...target,id:detail.id,confirm:name};
 if(detail.state!=='Off')await job((await api('/api/vm',{...op,action:'off'})).job);
 await job((await api('/api/vm',{...op,action:'delete',confirmFiles:detail.ownedFiles})).job);
 created=false;
}
try{
 for(let i=0;;i++){try{csrf=(await api('/api/login',{name:'lab-verifier',password:pass})).csrf;break;}catch(e){if(i>=24)throw e;await delay(250);}}
 await api('/api/hosts/save',{name:'local-acceptance',address:'localhost',transport:'local'});
 let s;for(let i=0;i<25;i++){s=await api('/api/host?name=local-acceptance');if(s.fresh)break;await delay(1000);}
 assert(s.fresh && s.switches.includes('Default Switch'));assert(!s.vms.some(v=>v.name===name));
 if(windows){
   const entry=(await api('/api/images')).find(i=>i.id==='windows-11');
   assert(entry?.available && /^[0-9a-f]{64}$/.test(entry.sha256),'Missing verified Windows template');
   console.log('HTTPS image catalog selected '+entry.version+' SHA-256 '+entry.sha256);
 }
 const image=windows?{image:'windows-11',user:'vmadmin',memMB:4096,diskGB:64}:{image:'debian-13',user:'debian',memMB:2048,diskGB:8};
 const guestPassword='Hv!4'+randomBytes(28).toString('base64url');
 await job((await api('/api/create',{...target,...image,volume:'D:',switch:'Default Switch',password:guestPassword,cpu:2})).job);
 created=true;
 const detail=await api('/api/vm?host=local-acceptance&name='+name);
 assert(detail.id && detail.managed && detail.state==='Running');
 if(windows){
   const verify=`$ErrorActionPreference='Stop'
   $p=[Console]::In.ReadToEnd() | ConvertFrom-Json
   $vm=Get-VM -Id $p.id
   if ($vm.Name -ne $p.name -or $vm.Generation -ne 2 -or !(Get-VMSecurity -VM $vm).TpmEnabled -or (Get-VMFirmware -VM $vm).SecureBoot -ne 'On') {throw 'Unexpected VM security configuration.'}
   $cred=[pscredential]::new(($vm.Name+'\\'+$p.user),(ConvertTo-SecureString $p.password -AsPlainText -Force))
   $os=Invoke-Command -VMId $vm.VMId -Credential $cred -ScriptBlock {Get-CimInstance Win32_OperatingSystem | Select-Object Caption,BuildNumber,CSName}
   if($os.CSName -ne $vm.Name -or [int]$os.BuildNumber -lt 22000){throw 'Unexpected Windows guest identity.'}
   Write-Output ($os.Caption+' build '+$os.BuildNumber+' verified with the final guest password, Secure Boot and vTPM.')`;
   const checked=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',verify],{
     windowsHide:true,encoding:'utf8',timeout:90000,input:JSON.stringify({name,id:detail.id,user:image.user,password:guestPassword})});
   assert.equal(checked.status,0,checked.stderr||'PowerShell Direct verification failed');console.log(checked.stdout.trim());
 }
 console.log('Guest setup confirmed and recorded VM is running; cleaning up '+detail.id);
 await removeOwned();
 passed=true;
 console.log('PASS: provision, guest first boot, power off and owned-disk deletion.');
}finally{
 try{if(created)await removeOwned();}
 finally{const stopped=server.exitCode===null&&server.signalCode===null?once(server,'close'):Promise.resolve();server.kill();await stopped;if(passed)removeFixture(tmp,'hvdash-live-');}
}
