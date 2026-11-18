import {randomUUID} from 'node:crypto';
import {db,get,put,del,fail} from './store.mjs';
import {openSerial} from './serial.mjs';

const actions=new Set(['start','stop','off','restart','pause','resume','save','edit','delete','protect','unprotect',
  'checkpoint-create','checkpoint-restore','checkpoint-delete','console-configure']);
const confirmations=new Set(['stop','off','restart','pause','save','delete','unprotect','checkpoint-restore','checkpoint-delete','console-configure']);
const adminActions=new Set(['delete','protect','unprotect','edit','checkpoint-create','checkpoint-restore','checkpoint-delete','console-configure']);
const protectedActions=new Set(['stop','off','restart','pause','save','delete','edit','checkpoint-restore','checkpoint-delete','console-configure']);
const consoleSessions=new Map();
const str=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const fold=x=>x.toLowerCase();
const requireRole=(user,admin=false)=>{if(!user||(admin?user.role!=='admin':!['operator','admin'].includes(user.role)))throw fail('Insufficient privileges.',403);};
const vmKey=(host,id)=>fold(host)+'/'+fold(id);
function ownership(host,vm){
  const owned=get('vmOwnership',vmKey(host,vm.name));
  return owned?.id && fold(owned.id)===fold(vm.id||'') ? owned:null;
}
function decorate(host,vm){
  const owned=ownership(host,vm),meta=get('vmMeta',vmKey(host,vm.id||vm.name));
  return {...vm,host,managed:Boolean(owned),protected:Boolean(meta?.protected),tags:meta?.tags||[],creator:owned?.creator||null,
    ownedFiles:owned?.files||[]};
}
function integer(v,min,max,label){if(!Number.isSafeInteger(v)||v<min||v>max)throw fail(label+' must be an integer from '+min+' to '+max+'.');return v;}
function editSpec(b) {
  if(typeof b.notes!=='string'||b.notes.length>1024||b.notes.includes('\0'))throw fail('Notes must contain up to 1024 characters.');
  if(!Array.isArray(b.tags)||b.tags.length>12||b.tags.some(t=>!str(t,40)))throw fail('Supply up to twelve short tags.');
  if(!['Nothing','Start','StartIfRunning'].includes(b.autoStart)||!['TurnOff','Save','ShutDown'].includes(b.autoStop))throw fail('Invalid automatic power policy.');
  if(typeof b.dynamic!=='boolean')throw fail('Choose static or dynamic memory.');
  const startupMB=integer(b.startupMB,32,12582912,'Startup RAM');
  return {notes:b.notes,tags:[...new Set(b.tags)],vcpu:integer(b.vcpu,1,2048,'vCPU'),startupMB,dynamic:b.dynamic,
    minMB:b.dynamic?integer(b.minMB,32,startupMB,'Minimum RAM'):startupMB,
    maxMB:b.dynamic?integer(b.maxMB,startupMB,12582912,'Maximum RAM'):startupMB,autoStart:b.autoStart,autoStop:b.autoStop};
}
function ids(b) {
  if(!str(b.host,128)||!str(b.name,128)||!uuid(b.id))throw fail('Select a VM by its current host, name and ID.');
}
function checkedDetails(d,b){
  if(!uuid(d?.id)||fold(d.id)!==fold(b.id)||d.name!==b.name)throw fail('VM identity changed. Reopen its details.',409);
}
async function listVMs({hosts,stats,url}) {
  const q=url.searchParams, list=[];
  for(const h of hosts()){
    if(q.get('host')&&fold(q.get('host'))!==fold(h.name))continue;
    const snapshot=await stats(h);
    for(const item of snapshot?.vms||[]){
      const v=decorate(h.name,item);
      if(q.get('state') && fold(v.state)!==fold(q.get('state')))continue;
      if(q.get('tag')&&!v.tags.some(t=>fold(t)===fold(q.get('tag'))))continue;
      if(q.get('q')&&!fold([v.name,v.host,...v.tags,...(v.ips||[])].join(' ')).includes(fold(q.get('q'))))continue;
      list.push(v);
    }
  }
  const field=q.get('sort')||'name';
  if(!['host','name','state','vcpu','memMB','ip','cpuPct','uptimeSec'].includes(field))throw fail('Unsupported sort field.');
  const val=v=>field==='ip'?(v.ips||[])[0]||'':v[field]??'';
  return list.sort((a,b)=>(q.get('order')==='desc'?-1:1)*String(val(a)).localeCompare(String(val(b)),undefined,{numeric:true})||a.name.localeCompare(b.name));
}
async function vmAction(ctx){
  const {b,user}=ctx;ids(b);
  const op=b.action;
  if(!actions.has(op))throw fail('Unknown VM action.');
  requireRole(user,adminActions.has(op));
  const h=ctx.host(b.host), key=vmKey(h.name,b.id);
  if(confirmations.has(op)&&b.confirm!==b.name)throw fail('Type the exact VM name to confirm this operation.');
  if(protectedActions.has(op)&&get('vmMeta',key)?.protected)throw fail('An administrator must lift VM protection first.',409);
  const d=await ctx.runPs(h,'vmDetail',{name:b.name});checkedDetails(d,b);
  const owned=ownership(h.name,d);
  if(op==='delete'&&!owned)throw fail('Deletion requires an ownership record for this VM ID and its disks.',403);
  const p={action:op,name:d.name,id:d.id};
  if(op==='delete'){
    if(!Array.isArray(b.confirmFiles)||!Array.isArray(owned.files)||JSON.stringify(b.confirmFiles)!==JSON.stringify(owned.files))throw fail('Review and confirm the exact disk list before deleting.');
    p.ownership=owned;
  }
  if(op==='edit')Object.assign(p,editSpec(b));
  if(op==='checkpoint-create'){if(!str(b.checkpointName,100))throw fail('Specify a checkpoint name.');p.checkpointName=b.checkpointName;}
  if(['checkpoint-delete','checkpoint-restore'].includes(op)){
    const cp=(d.checkpoints||[]).find(x=>uuid(b.checkpointId)&&fold(x.id)===fold(b.checkpointId));
    if(!cp||b.confirmCheckpoint!==cp.name)throw fail('Refresh checkpoints and confirm the exact checkpoint name.');
    p.checkpointId=cp.id;p.checkpointName=cp.name;
  }
  // The detail read may have overlapped another request. Recheck inside the
  // durable VM lock; use only the recorded GUID for the host-side action.
  return ctx.startJob(user.name,h.name,d.name,op,async step=>{
    const meta=get('vmMeta',key)||{};
    if(meta.protected&&protectedActions.has(op))throw fail('VM is protected.',409);
    if(op==='protect'||op==='unprotect'){put('vmMeta',key,{...meta,protected:op==='protect'});return;}
    step('Applying '+op+' on '+h.name);
    const timeoutMs=op.startsWith('checkpoint-')?1200000:180000;
    const expectsStop=['stop','off','delete','checkpoint-restore','restart'].includes(op);
    if(expectsStop)put('expectedStop',key,{expires:Date.now()+timeoutMs+60000});
    if(op==='start'||op==='resume')del('expectedStop',key);
    try{
      await ctx.runPs(h,'vmApply',p,{timeoutMs});
    }catch(error){
      if(expectsStop)del('expectedStop',key);
      throw error;
    }
    if(op==='delete')del('expectedStop',key);
    else if(expectsStop)put('expectedStop',key,{finishedAt:Date.now()});
    if(op==='edit')put('vmMeta',key,{...meta,tags:p.tags});
    if(op==='delete'){del('vmMeta',key);del('vmOwnership',vmKey(h.name,d.name));
      db.prepare('DELETE FROM ip_ledger WHERE host=? COLLATE NOCASE AND vm=? COLLATE NOCASE').run(h.name,d.name);}
  });
}
async function consoleRoute(ctx){
  const {b,user,key,url}=ctx;
  requireRole(user,true);
  if(key==='POST /api/console/open'){
    ids(b);const h=ctx.host(b.host),d=await ctx.runPs(h,'vmDetail',{name:b.name});checkedDetails(d,b);
    if(get('vmMeta',vmKey(h.name,d.id))?.protected)throw fail('Lift VM protection before opening an interactive console.',409);
    if(!d.consolePipe||d.state!=='Running')throw fail('Configure COM1 while the VM is off, then start it to use serial.',409);
    if(consoleSessions.size>=8)throw fail('Console session limit reached.',429);
    const id=randomUUID();
    let connected,failed,finish;
    const ready=new Promise((resolve,reject)=>{connected=resolve;failed=reject;});
    const lifetime=new Promise(resolve=>{finish=resolve;});
    const {job}=ctx.startJob(user.name,h.name,d.name,'console',async step=>{
      let serial,timer;
      try{
        if(get('vmMeta',vmKey(h.name,d.id))?.protected)throw fail('VM is protected.',409);
        serial=openSerial(h,d.id);await serial.ready;
        const session={owner:user.id,id,serial,finish,last:Date.now()};
        consoleSessions.set(id,session);
        timer=setInterval(()=>{if(Date.now()-session.last>45000)finish();},5000);timer.unref();
        step('Serial console connected');connected();await lifetime;
      } catch(e){failed(e);throw e;}
      finally{clearInterval(timer);consoleSessions.delete(id);serial?.close();}
    });
    await ready;return {id,job};
  }
  const id=b?.id||url.searchParams.get('id'),s=consoleSessions.get(id);
  if(!s||s.owner!==user.id)throw fail('Serial session unavailable. Reconnect to the VM.',404);
  s.last=Date.now();
  if(key==='POST /api/console/close'){s.finish();return {ok:true};}
  if(key==='POST /api/console/write'){
    if(typeof b.data!=='string'||!b.data||Buffer.byteLength(b.data)>4096)throw fail('Input must be 1–4096 bytes.');
    try{await s.serial.write(b.data);}catch(e){s.finish();throw e;}return {ok:true};
  }
  if(key==='GET /api/console/read'){
    try{return {text:await s.serial.read(),closed:false};}catch(e){s.finish();throw e;}
  }
  throw fail('Unknown serial operation.',404);
}
export async function vmRoute(ctx) {
  if(ctx.key==='GET /api/vms')return listVMs(ctx);
  if(ctx.key==='GET /api/vm'){
    const name=ctx.url.searchParams.get('name');
    if(!str(name,128))throw fail('Choose a VM.');
    const h=ctx.host(ctx.url.searchParams.get('host'));const d=await ctx.runPs(h,'vmDetail',{name});
    return decorate(h.name,d);
  }
  if(ctx.key==='POST /api/vm')return vmAction(ctx);
  if(ctx.url.pathname.startsWith('/api/console/'))return consoleRoute(ctx);
  return undefined;
}
