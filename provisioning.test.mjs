import {removeFixture} from './tests/temp-state.mjs';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const state=mkdtempSync(path.join(tmpdir(),'hvdash-prov-'));
process.env.HVDASH_DATA=state;
process.env.HVDASH_FAKE='1';
const {db,get,put,migrate}=await import('./store.mjs');
const {provisionRoute,recordObserved,staticNetwork}=await import('./provisioning.mjs');
const {startJob}=await import('./jobs.mjs');
migrate();
after(()=>{db.close();removeFixture(state,'hvdash-prov-')});
const snapshot={networks:[{name:'External',type:'External',id:'sw1'}],disks:[{name:'C:'}],vms:[]};
const b={host:'rack1',name:'linux1',cpu:2,memMB:1024,diskGB:10,switch:'External',volume:'C:',user:'debian',password:'synthetic-password',ip:'192.0.2.11/24',gateway:'192.0.2.1',dns:'192.0.2.53'};
const created=[];
function ctx(body,runPs=async(h,op,p)=>{
  if(op==='preflight')return true;
  if(op==='create'){created.push(p);await sleep(20);return {id:'304cd10f-d82d-4ebb-8588-0d750d4cb37d',files:['C:\\hvdash\\linux1\\os.vhdx','C:\\hvdash\\linux1\\seed.vhdx'],directory:'C:\\hvdash\\linux1',firstBoot:'done'};}
  throw Error('Unexpected host op: '+op);
}){return {user:{name:'operator',role:'operator'},key:'POST /api/create',url:new URL('https://example.test/api/create'),b:body,
 host:name=>({name}),stats:()=>snapshot,runPs,startJob};}
async function result(id){
 for(let i=0;i<100;i++){const j=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(j.status!=='running')return j;await sleep(10);}
 throw Error('Timed out waiting for the job');
}

test('validate addresses before leasing and isolate unknown data',()=>{
 assert.throws(()=>staticNetwork({...b,ip:'192.0.2.0/24'}));
 assert.throws(()=>staticNetwork({...b,gateway:'198.51.100.1'}));
 assert.throws(()=>staticNetwork({...b,dns:'x'}));
 assert.equal(staticNetwork(b).prefix,24);
});
test('reserve before parallel creation, confirm first boot, retain static address and ownership',async()=>{
 const {job}=await provisionRoute(ctx(b));
 await assert.rejects(provisionRoute(ctx({...b,name:'second',host:'rack2'})),/already reserved/);
 const done=await result(job);
 assert.equal(done.status,'done');assert.doesNotMatch(done.log,/synthetic-password/);
 assert.equal(get('vmOwnership','rack1/linux1').creator,'operator');
 assert.equal(db.prepare('SELECT source FROM ip_ledger WHERE address=?').get('192.0.2.11').source,'static');
 const cloud=JSON.parse(created[0].userData.replace('#cloud-config',''));
 assert.equal(cloud.users[0].name,'debian');assert.ok(cloud.runcmd.some(v=>typeof v==='string'&&v.includes('serial-getty')));
 assert.ok(cloud.bootcmd.some(v=>v.join(' ').includes('systemd-run --no-block')));
 assert.equal(JSON.parse(created[0].networkConfig).network.ethernets.eth0.nameservers.addresses[0],'192.0.2.53');
});
test('known rollback releases the address; interrupted cleanup keeps it reserved',async()=>{
 for(const [suffix,reason,retained] of [[12,'cloud-init failed [rolled back]',false],[13,'transport timed out',true],[14,'unconfirmed',true]]){
  const body={...b,name:'fail-'+suffix,ip:'192.0.2.'+suffix+'/24'};
  const {job}=await provisionRoute(ctx(body,async(h,op)=>{if(op==='create'){if(suffix===14)return {id:'x'};throw Error(reason);}}));
  assert.equal((await result(job)).status,'failed');
  assert.equal(Boolean(db.prepare('SELECT 1 FROM ip_ledger WHERE address=?').get('192.0.2.'+suffix)),retained);
 }
});
test('observed addresses survive guest shutdown; reader cannot create or alter profiles',async()=>{
 const observed={...snapshot,vms:[{name:'other',adapters:[{switch:'External',ips:['192.0.2.55']}]}]};
 recordObserved('rack2',observed);recordObserved('rack2',{...snapshot,vms:[{name:'other',adapters:[]}]});
 await assert.rejects(provisionRoute(ctx({...b,name:'wrong',ip:'192.0.2.55/24'})),/already reserved/);
 await assert.rejects(provisionRoute({...ctx(b),user:{name:'reader',role:'viewer'}}),/Operator/);
 await assert.rejects(provisionRoute({...ctx({id:'x'}),key:'POST /api/profile'}),/Administrator/);
});
test('capacity refusal fails before any create invocation; chosen volume validated',async()=>{
 const calls=[];const body={...b,name:'oversize',ip:'192.0.2.63/24'};
 const {job}=await provisionRoute(ctx(body,async(h,op)=>{calls.push(op);throw Error('Insufficient safe disk capacity');}));
 assert.deepEqual(calls,['preflight']);assert.equal((await result(job)).status,'failed');
 assert.equal(db.prepare('SELECT 1 FROM ip_ledger WHERE address=?').get('192.0.2.63'),undefined);
 await assert.rejects(provisionRoute(ctx({...body,volume:'Z:'})),/listed by this host/);
});

test('provision with one SSH key per line, including Windows line endings',async()=>{
 const keys=['ssh-rsa YWJj first workstation','ssh-ed25519 ZGVm mobile','ssh-rsa Z2hp third workstation'];
 const body={...b,name:'keys',ip:'',password:'',sshKey:'\r\n'+keys.join('\r\n\r\n')+'\r\n'};
 const {job}=await provisionRoute(ctx(body));
 assert.equal((await result(job)).status,'done');
 const cloud=JSON.parse(created.at(-1).userData.slice('#cloud-config\n'.length));
 assert.deepEqual(cloud.users[0].ssh_authorized_keys,keys);
 assert.equal(cloud.ssh_pwauth,false);
 assert.equal(cloud.users[0].lock_passwd,true);
 assert.equal(created.at(-1).joinTailscale,false);
 assert.ok(!cloud.write_files?.some(file=>file.path==='/run/hvdash-tailscale.sh'));
 await assert.rejects(provisionRoute(ctx({...body,sshKey:keys[0]+'\ninvalid-key'})),/line 2/);
 await assert.rejects(provisionRoute(ctx({...body,sshKey:'\n  '})),/at least one SSH public key/);
});

test('Tailscale key is limited to create and success requires a guest address',async()=>{
 const key='tskey-auth-synthetic-test-only';
 const body={...b,name:'tailnet',ip:'',tailscaleAuthKey:key};
 for(const address of ['', '100.64.0.42']) {
  const {job}=await provisionRoute(ctx(body,async(h,op,p)=>{
   if(op==='preflight'){assert.ok(p.joinTailscale);assert.ok(!Object.hasOwn(p,'tailscaleAuthKey'));return;}
   assert.equal(p.tailscaleAuthKey,key);
   assert.ok(!p.userData.includes(key));
   const cloud=JSON.parse(p.userData.slice('#cloud-config\n'.length));
   assert.ok(cloud.bootcmd[0].at(-1).endsWith(' --tailscale'));
   assert.ok(cloud.write_files.some(f=>f.path==='/run/hvdash-tailscale.sh' && f.content.includes('--auth-key="file:')));
   return {id:'fixture',firstBoot:'done',files:[],directory:'fixture',tailscaleIP:address};
  }));
  const ended=await result(job);
  assert.equal(ended.status,address?'done':'failed');
  assert.ok(!ended.log.includes(key));
  if(address)assert.ok(ended.log.includes(address));
 }
 await assert.rejects(provisionRoute(ctx({...body,tailscaleAuthKey:key+'\ninjected'})),/single-line Tailscale auth key/);
 assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes(key));
 assert.ok(!JSON.stringify(db.prepare('SELECT * FROM kv').all()).includes(key));
});

test('Windows validates hardware and isolates setup credentials from preflight and job records',async()=>{
 const body={...b,image:'windows-11',user:'vmadmin',name:'win11-qa',ip:'',cpu:2,memMB:4096,diskGB:64,tailscaleAuthKey:'tskey-auth-windows-fixture'};
 for (const overrides of [{name:'12345'},{user:'Administrator'},{profile:'docker'},{cpu:1},{memMB:4095},{diskGB:63},{password:'short'}]){
   await assert.rejects(provisionRoute(ctx({...body,...overrides})));
 }
 const {job}=await provisionRoute(ctx(body,async(h,op,p)=>{
   assert.equal(p.image,'windows-11');
   if(op==='preflight'){assert.ok(!('windowsGuest' in p));assert.ok(!('tailscaleAuthKey' in p));return;}
   assert.equal(p.windowsGuest.password,b.password);assert.equal(p.windowsGuest.user,'vmadmin');
   assert.equal(p.userData,undefined);assert.equal(p.imageHash,'1'.repeat(64));
   return {id:'fixture-win',firstBoot:'done',files:['os.vhdx'],directory:'fixture',tailscaleIP:'100.64.1.4'};
 }));
 const ended=await result(job);
 assert.equal(ended.status,'done');assert.match(ended.log,/Windows 11 setup/);assert.doesNotMatch(ended.log,/cloud-init|synthetic-password|tskey-auth/);
});
