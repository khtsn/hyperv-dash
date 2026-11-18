import {removeFixture} from './temp-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';

process.env.HVDASH_FAKE='1';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hvdash-vm-check-'));process.env.HVDASH_DATA=temp;
const {vmRoute}=await import('../vm.mjs');
const {db,put,get}=await import('../store.mjs');
const {startJob}=await import('../jobs.mjs');
test.after(()=>{db.close();removeFixture(temp,'hvdash-vm-check-');});
const h={name:'lab',transport:'local'}, id=randomUUID(), name='example';
const session={id:'session-one',name:'alice',role:'admin'};
const cp={id:randomUUID(),name:'first'};
const machine={name,id,memMB:512,vcpu:2,state:'Off',notes:'hvdash',checkpoints:[cp],adapters:[],disks:[],ips:[],consolePipe:'mock'};
let applies=[];
const fake=async(host,op,args)=>{
  if(op==='vmDetail')return {...machine};
  assert.equal(host,h);assert.equal(op,'vmApply');applies.push(args);return {ok:true};
};
function req(key,b={},user=session,extra={}){
  const url=new URL(key.split(' ')[1],'https://localhost');
  return vmRoute({key:key.split('?')[0],url,b,user,hosts:()=>[h],host:()=>h,stats:()=>({vms:[machine]}),runPs:fake,startJob,...extra});
}
function act(action,other={},user=session){return req('POST /api/vm',{name,id,host:'lab',confirm:name,action,...other},user);}
async function wait(job){for(let i=0;i<15;i++){const j=db.prepare('SELECT status,log FROM jobs WHERE id=?').get(job.job);if(j.status!=='running'){assert.equal(j.status,'done',j.log);return;}await sleep(10);}assert.fail('job still running');}
test('roles, typed confirmation, GUID ownership, protection and exclusive VM jobs',async()=>{
  await assert.rejects(act('start',{}, {...session,role:'viewer'}),{status:403});
  await assert.rejects(act('off',{confirm:'wrong'}),{status:400});
  await assert.rejects(act('delete',{confirmFiles:[]}),{status:403}); // notes alone are not ownership
  await assert.rejects(act('checkpoint-restore',{checkpointId:cp.id,confirmCheckpoint:'old'}),{status:400});
  await wait(await act('protect'));
  for(const op of ['off','delete','restart','edit','checkpoint-restore','console-configure'])await assert.rejects(act(op),{status:409});
  await assert.rejects(act('unprotect',{}, {...session,role:'operator'}),{status:403});
  await wait(await act('unprotect'));
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const j=startJob('alice','lab',name,'test-lock',()=>gate);
  await assert.rejects(act('off'),{status:409});
  release();await wait(j);
  const files=['C:\\hvdash\\example\\os.vhdx'];put('vmOwnership','lab/example',{id,files,creator:'alice'});
  const list=await req('GET /api/vms?q=EXAM&state=off&sort=host');
  assert.equal(list.length,1);assert.equal(list[0].creator,'alice');
  await assert.rejects(act('delete',{confirmFiles:['C:\\other']}),{status:400});
  await assert.rejects(act('delete',{id:randomUUID(),confirmFiles:files}),{status:409});
  await wait(await act('delete',{confirmFiles:files}));
  assert.equal(get('vmOwnership','lab/example'),undefined);assert.equal(applies.at(-1).ownership.id,id);
});
test('serial session ownership and VM lock',async()=>{
  machine.state='Running';
  const s=await req('POST /api/console/open',{host:'lab',name,id});
  await assert.rejects(req('POST /api/console/write',{id:s.id,data:'secret'},{...session,id:'another'}),{status:404});
  await req('POST /api/console/write',{id:s.id,data:'hello'});
  assert.match((await req('GET /api/console/read?id='+s.id)).text,/hello/);
  await assert.rejects(act('off'),{status:409});
  await req('POST /api/console/close',{id:s.id});await wait({job:s.job});
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM jobs WHERE id=?').get(s.job)),/hello|secret/);
});
test('Windows serial bridge transfers bytes through a real local named pipe', {skip:process.platform!=='win32',timeout:18000},async t=>{
  const id=randomUUID(), pipe='\\\\.\\pipe\\hvdash-'+id;
  let received='',socket;
  const server=net.createServer(s=>{socket=s;s.on('data',data=>{received+=data.toString();s.write(Buffer.from('guest: hÃ©llo\r\n'));});});
  server.listen(pipe);await once(server,'listening');
  t.after(()=>{socket?.destroy();server.close();});
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./serial-fixture.ps1',import.meta.url)),id],{windowsHide:true});
  t.after(()=>child.kill());child.stderr.resume();
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  async function send(s){child.stdin.write(s+'\n');const msg=await lines.next();assert.equal(msg.done,false);const r=JSON.parse(msg.value);assert.ok(r.ok,r.value);return r.value;}
  await send(Buffer.from(JSON.stringify({transport:'local',id})).toString('base64'));
  await send(JSON.stringify({command:'write',bytes:Buffer.from('uname\r').toString('base64')}));
  let output='';
  for(let i=0;i<30&&!output;i++){await sleep(40);output=await send('{"command":"read"}');}
  assert.equal(received,'uname\r');assert.equal(Buffer.from(output,'base64').toString(),'guest: hÃ©llo\r\n');
  await send('{"command":"close"}');child.stdin.end();await once(child,'exit');
});
