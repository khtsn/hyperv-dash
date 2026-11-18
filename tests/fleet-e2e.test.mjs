import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const root=fileURLToPath(new URL('../',import.meta.url));

async function fixture(t) {
  const parent=realpathSync(tmpdir()), dir=mkdtempSync(path.join(parent,'hvdash-e2e-'));
  const listener=net.createServer().listen(0,'127.0.0.1');
  await once(listener,'listening');
  const origin='https://127.0.0.1:'+listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const env={...process.env,HVDASH_DATA:dir,HVDASH_FAKE:'1',HVDASH_PORT:new URL(origin).port,
    HVDASH_BIND:'127.0.0.1',HVDASH_ORIGIN:origin,HVDASH_FAKE_FAIL_VM:'failed-build'};
  delete env.HVDASH_ACCOUNT_PASSWORD;
  delete env.HVDASH_SLACK_WEBHOOK;
  let server,ca;
  async function stop() {
    if(server&&server.exitCode===null&&server.signalCode===null){
      const closed=once(server,'exit');server.kill();await closed;
    }
  }
  t.after(async()=>{
    await stop();
    // Only the unique tmpdir allocated above belongs to this test.
    const resolved=realpathSync(dir);
    assert.equal(path.dirname(resolved),parent);
    assert.match(path.basename(resolved),/^hvdash-e2e-[a-zA-Z0-9]+$/);
    rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  function cli(args,password){
    const result=spawnSync(process.execPath,['admin.mjs',...args],{cwd:root,env:password?{...env,HVDASH_ACCOUNT_PASSWORD:password}:env,windowsHide:true,encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,result.stderr);
  }
  function request(route,actor,body,more={}){
    const headers={Origin:origin,...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf}:{}),...more};
    if(body!==undefined)headers['Content-Type']='application/json';
    return new Promise((resolve,reject)=>{
      const req=https.request(origin+route,{method:body===undefined?'GET':'POST',ca,headers,agent:false},res=>{
        let raw='';res.setEncoding('utf8').on('data',s=>{raw+=s;}).on('end',()=>{
          try{resolve({code:res.statusCode,headers:res.headers,data:String(res.headers['content-type']).includes('application/json')?JSON.parse(raw):raw});}
          catch(err){reject(err);}
        });
      });
      req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Timed out: '+route)));
      req.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  async function start(){
    server=spawn(process.execPath,['server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stderr='';server.stderr.setEncoding('utf8').on('data',d=>{stderr=(stderr+d).slice(-1500);});
    server.stdout.resume();
    for(let i=0;i<160;i++){
      if(server.exitCode!==null)throw Error('Server exited: '+stderr);
      try{if((await request('/login')).code===200)return;}catch{}
      await delay(50);
    }
    throw Error('HTTPS server never became ready: '+stderr);
  }
  const accounts={};
  for(const role of ['admin','viewer','operator']){
    const password=randomBytes(24).toString('hex');
    cli(role==='admin'?['init',role]:['user',role,role],password);
    accounts[role]=password;
  }
  ca=readFileSync(path.join(dir,'tls','cert.pem'));
  await start();
  async function login(role){
    const r=await request('/api/login',null,{name:role,password:accounts[role]});
    assert.equal(r.code,200,'login '+role);
    const cookie=r.headers['set-cookie'][0];
    assert.match(cookie,/Max-Age=604800(?:;|$)/);
    assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/i);assert.match(cookie,/SameSite=Strict/i);
    const actor={cookie:cookie.split(';')[0],csrf:'-'};
    const me=await request('/api/session',actor);assert.equal(me.data.role,role);
    assert.ok(me.data.csrf);actor.csrf=me.data.csrf;
    return actor;
  }
  async function ok(route,actor,body){
    const r=await request(route,actor,body);
    assert.ok([200,201,202,204].includes(r.code),route+' returned '+r.code+': '+(r.data?.error||'unexpected status'));
    return r.data;
  }
  async function job(ticket,actor,expected='done'){
    assert.ok(ticket.job,'job ID required');
    for(let i=0;i<150;i++){
      const result=await ok('/api/job?id='+encodeURIComponent(ticket.job),actor);
      if(result.status!=='running'){
        assert.equal(result.status,expected,'job '+result.op+': '+result.log?.at(-1));return result;
      }
      await delay(30);
    }
    throw Error('Job did not finish');
  }
  return {origin,dir,cli,login,accounts,request,ok,job,stop,start};
}

test('HTTPS dashboard manages an isolated fleet through its normal public routes', {timeout:120000}, async t=>{
  const {dir,cli,login,request,ok,job,stop,start}=await fixture(t);
  const anonymous=await request('/api/hosts');assert.equal(anonymous.code,401);
  assert.ok([302,303,401].includes((await request('/')).code));
  const admin=await login('admin'), viewer=await login('viewer'), operator=await login('operator');
  const host={name:'test-lab',address:'hv-test.invalid',transport:'winrm',user:'Test\\fleet-service',password:randomBytes(20).toString('base64url')};
  const tooShort=spawnSync(process.execPath,['admin.mjs','user','weak','viewer'],{cwd:root,env:{...process.env,HVDASH_DATA:dir,HVDASH_ACCOUNT_PASSWORD:'short'},windowsHide:true,encoding:'utf8'});
  assert.notEqual(tooShort.status,0);
  assert.equal((await request('/api/hosts/save',viewer,host)).code,403);
  assert.equal((await request('/api/hosts/save',operator,host)).code,403);
  assert.equal((await request('/api/hosts/save',admin,host,{'X-CSRF-Token':'incorrect'})).code,403);
  assert.equal((await request('/api/hosts/save',admin,host,{Origin:'https://different.invalid'})).code,403);
  await ok('/api/hosts/test',admin,host);
  const offline=await request('/api/hosts/test',admin,{...host,address:'offline.invalid'});
  assert.match(JSON.stringify(offline.data),/DNS|resolve|unreach/i);
  await ok('/api/hosts/save',admin,host);
  const hosts=await ok('/api/hosts',viewer);
  assert.ok(hosts.some(h=>h.name===host.name));assert.ok(!JSON.stringify(hosts).includes(host.password));
  await ok('/api/hosts/save',admin,{name:host.name,originalName:host.name,displayName:'Edited lab',address:host.address,transport:host.transport});
  const updatedHost=(await ok('/api/hosts',viewer)).find(h=>h.name===host.name);
  assert.equal(updatedHost.displayName,'Edited lab');assert.equal(updatedHost.hasCredential,true);
  let fleet;
  for(let wait=0;wait<40;wait++){
    fleet=await ok('/api/fleet',viewer);
    if(fleet.hosts.some(h=>h.name===host.name&&h.status==='online'))break;
    await delay(25);
  }
  const sample=fleet.hosts.find(h=>h.name===host.name);
  assert.equal(sample.status,'online');assert.ok(sample.lastSeen&&sample.cpuModel&&sample.capacity);
  assert.ok(fleet.totals.freeDiskGB>0&&sample.networks[0].adapters.length);
  assert.equal((await request('/api/history?host=test-lab')).code,401);
  assert.equal((await request('/api/alerts/thresholds',operator,{diskFreePct:80,memoryUsedPct:90})).code,403);
  assert.equal((await request('/api/alerts/thresholds',admin,{diskFreePct:101,memoryUsedPct:90})).code,400);
  const limits={diskFreePct:80,memoryUsedPct:90};
  assert.deepEqual(await ok('/api/alerts/thresholds',admin,limits),limits);
  assert.deepEqual((await ok('/api/alerts',viewer)).thresholds,limits);
  const hostHistory=await ok('/api/history?host=test-lab&range=30d',viewer);
  assert.equal(hostHistory.points.at(-1).value.io[0].receiveBps,32768);
  const vmHistory=await ok('/api/history?host=test-lab&vm='+hostHistory.vms[0].id,viewer);
  assert.equal(vmHistory.points.at(-1).value.io[0].sendBps,0);
  assert.equal((await request('/api/history?host=test-lab&range=1y',viewer)).code,400);
  const vmList=await ok('/api/vms?host='+host.name+'&state=Running&q=legacy&sort=vcpu',viewer);
  assert.equal(vmList.length,1);assert.equal(vmList[0].name,'Legacy VM');
  assert.deepEqual(await ok('/api/vms?tag=none-match',viewer),[]);
  const images=await ok('/api/images',viewer);
  assert.ok(images.some(i=>i.id==='debian-13'&&i.version));
  const profile='offline-test';
  await ok('/api/profile',admin,{id:profile,label:'Test profile',packages:['curl'],runcmd:[],files:[],isDefault:true});
  assert.ok((await ok('/api/profiles',viewer)).some(p=>p.id===profile&&p.isDefault));
  const name='demo-guest',guestPassword=randomBytes(25).toString('base64url');
  const create={host:host.name,name,user:'debian',password:guestPassword,cpu:2,memMB:2048,diskGB:16,
    switch:'Lab NAT',volume:'D:',profile,ip:'192.0.2.12/24',gateway:'192.0.2.1',dns:'192.0.2.1'};
  assert.equal((await request('/api/create',viewer,create)).code,403);
  for(const overrides of [{name:'over-ram',memMB:64000},{name:'over-disk',diskGB:380}]) {
    const r=await request('/api/create',operator,{...create,...overrides,ip:''});
    if(r.data?.job)await job(r.data,operator,'failed');else assert.ok([400,409,422].includes(r.code));
  }
  const ticket=await ok('/api/create',operator,create);
  const duplicate=await request('/api/create',operator,create);
  assert.ok([400,409].includes(duplicate.code),'overlapping work must be refused immediately, got '+duplicate.code);
  const done=await job(ticket,operator);assert.equal(done.actor,'operator');assert.ok(done.started&&done.ended&&done.log.length>=2);
  const detailPath='/api/vm?'+new URLSearchParams({host:host.name,name});
  const detail=await ok(detailPath,viewer),vm={host:host.name,name,id:detail.id};
  assert.ok(detail.id);assert.equal(detail.state,'Running');assert.ok(detail.disks.some(d=>d.path.startsWith('D:')));
  const mutation=(action,extra={})=>({ ...vm,action,confirm:name,...extra });
  const action=async(who,what,extra={})=>{
    const result=await ok('/api/vm',who,mutation(what,extra));
    if(result.job)await job(result,who);
  };
  await action(admin,'protect');
  const blocked=await request('/api/vm',operator,mutation('off'));
  if(blocked.data?.job)await job(blocked.data,operator,'failed');else assert.ok([400,403,409].includes(blocked.code));
  assert.equal((await ok(detailPath,viewer)).state,'Running');
  await action(admin,'unprotect');
  await action(operator,'pause');assert.equal((await ok(detailPath,viewer)).state,'Paused');
  await action(operator,'resume');await action(operator,'save');assert.equal((await ok(detailPath,viewer)).state,'Saved');
  await action(operator,'start');await action(operator,'restart');await action(operator,'stop');
  assert.equal((await ok(detailPath,viewer)).state,'Off');
  assert.ok((await ok('/api/ledger',viewer)).some(row=>row.vm===name&&row.address==='192.0.2.12'));
  await action(admin,'edit',{vcpu:3,startupMB:1536,minMB:768,maxMB:3072,dynamic:true,autoStart:'Start',autoStop:'Save',notes:'resize validation',tags:['blue']});
  const edited=await ok(detailPath,viewer);
  assert.equal(edited.vcpu,3);assert.equal(edited.startupMB,1536);assert.equal(edited.notes,'resize validation');
  assert.deepEqual(edited.tags,['blue']);assert.equal(edited.creator,'operator');
  await action(admin,'checkpoint-create',{checkpointName:'before-change'});
  const snapshot=(await ok(detailPath,viewer)).checkpoints.find(c=>c.name==='before-change');
  assert.ok(snapshot?.id);
  await action(admin,'checkpoint-restore',{checkpointId:snapshot.id,confirmCheckpoint:snapshot.name});
  await action(admin,'checkpoint-delete',{checkpointId:snapshot.id,confirmCheckpoint:snapshot.name});
  await action(admin,'console-configure');
  await action(operator,'start');
  const consoleSession=await ok('/api/console/open',admin,vm);
  await ok('/api/console/write',admin,{id:consoleSession.id,data:'serial smoke\n'});
  const reply=await ok('/api/console/read?id='+consoleSession.id,admin);
  assert.match(reply.text,/serial smoke/);
  // Keeping the session open is a deterministic long-running operation.
  assert.equal((await request('/api/vm',operator,mutation('restart'))).code,409);
  await ok('/api/console/close',admin,{id:consoleSession.id});
  await job(consoleSession,admin);
  const failedTicket=await ok('/api/create',operator,{...create,name:'failed-build',ip:'192.0.2.13/24'});
  await job(failedTicket,operator,'failed');
  const failedVM=await request('/api/vm?'+new URLSearchParams({host:host.name,name:'failed-build'}),viewer);
  assert.ok(failedVM.code>=400,'partial guest should have been cleaned up');
  const ledger=await ok('/api/ledger',viewer);
  assert.ok(ledger.some(r=>r.vm===name&&r.address==='192.0.2.12'));
  assert.ok(!ledger.some(r=>r.vm==='failed-build'));
  const free=await ok('/api/freeip?'+new URLSearchParams({host:host.name,switch:'Lab NAT'}),operator);
  assert.ok(free.ip&&free.ip!=='192.0.2.12/24');
  const mapping={host:host.name,action:'add',nat:'lab-nat',protocol:'TCP',externalIP:'0.0.0.0',externalPort:2222,internalIP:'192.0.2.12',internalPort:22};
  const added=await ok('/api/nat',admin,mapping);if(added.job)await job(added,admin);
  const natPath='/api/nat?host='+host.name;
  const nat=await ok(natPath,viewer);const rule=nat.mappings.find(r=>r.externalPort===2222);assert.ok(rule);
  const removed=await ok('/api/nat',admin,{...rule,host:host.name,action:'remove',confirm:rule.nat+'/'+rule.id});if(removed.job)await job(removed,admin);
  assert.equal((await ok(natPath,viewer)).mappings.length,0);
  const audit=await ok('/api/audit?q=test-lab',admin);assert.ok(audit.some(e=>e.actor==='operator'));
  assert.ok(audit.some(e=>e.outcome==='denied'&&e.actor==='viewer'));
  assert.equal((await request('/api/audit',viewer)).code,403);
  const csv=await ok('/api/audit.csv?q=test-lab',admin);assert.ok(csv.includes('operator'));
  assert.ok(!JSON.stringify(done).includes(guestPassword));assert.ok(!csv.includes(host.password));
  const interrupted=await ok('/api/console/open',admin,vm);
  await stop();await start();
  assert.deepEqual((await ok('/api/alerts',viewer)).thresholds,limits);
  assert.ok((await ok('/api/history?host=test-lab&range=24h',viewer)).points.some(p=>p.value));
  await job(interrupted,admin,'interrupted');
  assert.equal((await ok(detailPath,viewer)).id,vm.id);
  assert.equal((await ok('/api/job?id='+ticket.job,operator)).status,'done');
  const conflict=await request('/api/create',operator,{...create,name:'collision'});
  if(conflict.data?.job)await job(conflict.data,operator,'failed');else assert.ok([400,409].includes(conflict.code));
  const invalid=await request('/api/vm',admin,mutation('delete',{confirm:'not-the-name'}));assert.ok([400,403,409].includes(invalid.code));
  // Preserve a consistent operator backup before the successful deletion.
  const backup=path.join(dir,'backup.sqlite');cli(['backup',backup]);
  const copied=new DatabaseSync(backup,{readOnly:true});
  try{
    assert.equal(copied.prepare('SELECT status FROM jobs WHERE id=?').get(ticket.job).status,'done');
    assert.ok(copied.prepare('SELECT count(*) AS n FROM audit').get().n>0);
    assert.equal(copied.prepare("SELECT count(*) AS n FROM kv WHERE category='hosts' AND id=?").get(host.name).n,1);
    assert.equal(copied.prepare("SELECT count(*) AS n FROM kv WHERE category='profiles' AND id=?").get(profile).n,1);
    assert.ok(copied.prepare('SELECT count(*) AS n FROM metrics WHERE host=?').get(host.name).n>0);
    assert.equal(copied.prepare("SELECT address FROM ip_ledger WHERE vm=? AND source='static'").get(name).address,'192.0.2.12');
  }finally{copied.close();}
  for(const secret of [guestPassword,host.password])assert.ok(!readFileSync(backup).includes(Buffer.from(secret)),'backup contains a cleartext credential');
  await action(admin,'delete',{confirmFiles:edited.ownedFiles});assert.ok((await request(detailPath,viewer)).code>=400);
  await ok('/api/hosts/remove',admin,{name:host.name,confirm:host.name});
  assert.equal((await ok('/api/hosts',viewer)).length,0);
  // Inactivity no longer cuts short a seven-day session.
  const appDB=new DatabaseSync(path.join(dir,'fleet.sqlite'));
  try{
    appDB.prepare('UPDATE sessions SET seen=? WHERE username=?').run(Date.now()-6*86400000,'operator');
    assert.equal((await request('/api/session',operator)).code,200);
    appDB.prepare('UPDATE sessions SET expires=? WHERE username=?').run(Date.now()-1,'operator');
  }finally{appDB.close();}
  assert.equal((await request('/api/session',operator)).code,401);
  await ok('/api/logout',viewer,{});assert.equal((await request('/api/session',viewer)).code,401);
});

test('admin password change requires current credentials and revokes every admin session',async t=>{
  const {dir,login,accounts,request}=await fixture(t);
  const admin=await login('admin'), second=await login('admin'), viewer=await login('viewer');
  const route='/api/change-password', change={currentPassword:accounts.admin,newPassword:randomBytes(30).toString('hex')};
  assert.equal((await request(route,viewer,change)).code,403);
  assert.equal((await request(route,admin,change,{'X-CSRF-Token':'incorrect'})).code,403);
  assert.equal((await request(route,admin,{...change,currentPassword:'incorrect'})).code,403);
  assert.equal((await request(route,admin,{...change,newPassword:'short'})).code,400);
  const state=new DatabaseSync(path.join(dir,'fleet.sqlite'));
  try {
    const row=state.prepare("SELECT expires,seen FROM sessions WHERE username='admin' ORDER BY seen DESC LIMIT 1").get();
    assert.equal(row.expires-row.seen,7*86400000);
  }finally{state.close();}
  const done=await request(route,admin,change);
  assert.equal(done.code,200);assert.match(done.headers['set-cookie'][0],/Max-Age=0/);
  for(const old of [admin,second])assert.equal((await request('/api/session',old)).code,401);
  assert.equal((await request('/api/session',viewer)).code,200);
  assert.equal((await request('/api/login',null,{name:'admin',password:change.currentPassword})).code,401);
  assert.equal((await request('/api/login',null,{name:'admin',password:change.newPassword})).code,200);
});

test('upgrading live eight-hour sessions preserves their original login time and drops idle sessions',async t=>{
  const {dir,login,stop,start,request}=await fixture(t);
  const admin=await login('admin'), viewer=await login('viewer');
  await stop();
  const now=Date.now(), issued=now-2*3600000, expected=issued+7*86400000;
  const state=new DatabaseSync(path.join(dir,'fleet.sqlite'));
  try{
    state.prepare("DELETE FROM kv WHERE category='meta' AND id='weekSessions'").run();
    state.prepare('UPDATE sessions SET seen=?,expires=?').run(now,issued+8*3600000);
    state.prepare("UPDATE sessions SET seen=? WHERE username='viewer'").run(now-31*60000);
    await start();
    assert.equal((await request('/api/session',admin)).code,200);
    assert.equal((await request('/api/session',viewer)).code,401);
    await stop();await start();
    assert.equal(state.prepare("SELECT expires FROM sessions WHERE username='admin'").get().expires,expected);
  }finally{state.close();}
});

test('a failed sampler retains its last-seen snapshot while another host stays available', {timeout:30000},async t=>{
  const {dir,ok,login,stop,start}=await fixture(t);
  const admin=await login('admin');
  for(const name of ['site-a','site-b']){
    await ok('/api/hosts/save',admin,{name,address:name+'.invalid',transport:'winrm'});
  }
  async function waitFleet(predicate){
    for(let i=0;i<100;i++){
      const fleet=await ok('/api/fleet',admin);
      if(predicate(fleet))return fleet;
      await delay(30);
    }
    assert.fail('Timed out waiting for both inventory samples');
  }
  const healthy=await waitFleet(f=>f.hosts.length===2&&f.hosts.every(h=>h.status==='online'));
  const before=healthy.hosts.find(h=>h.name==='site-a');
  await stop();
  // This fixture DB is the simulated hypervisor, separate from the management DB.
  const simulator=new DatabaseSync(path.join(dir,'simulated-hosts.sqlite'));
  try{
    const row=simulator.prepare('SELECT state FROM simulated WHERE host=?').get(before.name);
    const state=JSON.parse(row.state);state.connected=false;
    simulator.prepare('UPDATE simulated SET state=? WHERE host=?').run(JSON.stringify(state),before.name);
  }finally{simulator.close();}
  await start();
  const degraded=await waitFleet(f=>f.hosts.some(h=>h.name==='site-a'&&h.status==='unreachable')&&f.hosts.some(h=>h.name==='site-b'&&h.status==='online'));
  const lost=degraded.hosts.find(h=>h.name==='site-a');
  assert.equal(lost.lastSeen,before.lastSeen);
  assert.equal(lost.fresh,false);assert.ok(lost.suggestion);
  assert.ok((await ok('/api/host?name=site-b',admin)).memTotalMB>0);
});
