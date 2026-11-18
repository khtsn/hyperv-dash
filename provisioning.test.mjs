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
