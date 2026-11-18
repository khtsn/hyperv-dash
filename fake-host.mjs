// Offline adapter. Model the hypervisor separately from the management database:
// restarting the server or restoring a dashboard backup cannot rewind this host.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let database;
function store() {
  if (process.env.HVDASH_FAKE !== '1' || !process.env.HVDASH_DATA)
    throw Error('The fake adapter requires HVDASH_FAKE=1 and an isolated HVDASH_DATA directory.');
  if (!database) {
    database = new DatabaseSync(path.join(process.env.HVDASH_DATA, 'simulated-hosts.sqlite'));
    database.exec('CREATE TABLE IF NOT EXISTS simulated (host TEXT PRIMARY KEY, state TEXT NOT NULL)');
  }
  return database;
}
const imageHash = createHash('sha256').update('synthetic Debian 13 base').digest('hex');
const sw = 'Lab NAT';
const gateway = '192.0.2.1';
const stamp = () => new Date().toISOString();
const disk = (p, gb) => ({ path:p, type:'Dynamic', sizeGB:gb, fileGB:1.5 });
function newVM(name, p={}) {
  const id = randomUUID();
  const root = (p.volume || 'C:').slice(0, 2);
  const directory = path.win32.join(root+'\\', 'hvdash', name);
  const ips = p.ip ? [p.ip.split('/')[0]] : [];
  const startupMB = p.memMB ?? 2048;
  return {
    id, name, state:'Running', vcpu:p.cpu ?? 2, memMB:startupMB, startupMB, dynamic:false,
    minMB:512, maxMB:8192, notes:p.userData?'hvdash debian-13':'Existing guest', autoStart:'StartIfRunning',
    autoStop:'Save', created:stamp(), adapters:[{name:'Network Adapter', switch:p.switch || sw, mac:'020000000001', ips}],
    disks:[disk(path.win32.join(directory, 'os.vhdx'), p.diskGB ?? 16),disk(path.win32.join(directory,'seed.vhdx'),0.0625)],
    checkpoints:[], consolePipe:p.userData?'\\\\.\\pipe\\hvdash-'+id:null, uptimeSec:60, cpuPct:4, directory, ips, tags:[], managed:Boolean(p.userData),
  };
}
function readHost(host) {
  const row = store().prepare('SELECT state FROM simulated WHERE host=?').get(host.name);
  if (row) return JSON.parse(row.state);
  const initial = { vms:[newVM('Legacy VM')], mappings:[], seq:0 };
  writeHost(host, initial);
  return initial;
}
function writeHost(host,state) {
  store().prepare('INSERT OR REPLACE INTO simulated VALUES(?,?)').run(host.name,JSON.stringify(state));
}
function stats(host,state) {
  const vms=state.vms.map(vm=>({...vm, memMB:vm.state==='Off'?0:vm.startupMB,
    io:[...vm.adapters.map((a,i)=>({kind:'nic',id:'nic-'+i,name:a.name,receiveBps:vm.state==='Running'?8192:0,sendBps:0})),
      ...vm.disks.map(d=>({kind:'disk',id:d.path,name:d.path,readBps:vm.state==='Running'?65536:0,writeBps:0,latencyMs:0.7}))],
    diskGB:vm.disks.reduce((sum,d)=>sum+d.sizeGB,0),ips:vm.state==='Off'?[]:vm.ips,
    adapters:vm.adapters.map(a=>({...a,ips:vm.state==='Off'?[]:a.ips}))}));
  const adapters=vms.flatMap(vm=>vm.adapters.map(a=>({vm:vm.name,adapter:a.name})));
  return {
    computer:host.name,os:'Windows Server 2022 (simulated)',build:'20348',cpuModel:'Simulated CPU',cores:8,
    logicalProcessors:16,hyperVVersion:'10.0',lastBoot:'2026-01-01T00:00:00Z',uptimeSec:9000,cpuPct:8,
    memFreeMB:65536-4096-vms.reduce((s,v)=>s+v.memMB,0),memTotalMB:65536,
    io:[{kind:'nic',id:'lab-nic',name:'Lab Ethernet',receiveBps:32768,sendBps:8192},
      ...['C:','D:'].map(name=>({kind:'disk',id:name,name,readBps:524288,writeBps:65536,latencyMs:1.7}))],
    disks:['C:','D:'].map(name=>({name,sizeGB:512,freeGB:400-vms.flatMap(v=>v.disks).filter(d=>d.path.startsWith(name)).reduce((n,d)=>n+d.fileGB,0)})),
    networks:[{id:'fa190ffe-be6c-4c73-8a7e-82e5bfe2fad9',name:sw,type:'Internal',adapters,ipv4:[{address:gateway,prefixLength:24}]}],
    switches:[sw],vms,warnings:[],
  };
}
const vmByName=(state,name)=>state.vms.find(v=>v.name.toLowerCase()===String(name).toLowerCase());
const must=(value,message)=>{if(!value)throw Error(message);return value;};
function preflight(host,p,state) {
  must(!vmByName(state,p.name),'A VM with that name already exists.');
  const s=stats(host,state), addr=p.ip?.split('/')[0];
  must(p.switch===sw,'Virtual switch not found.');
  must(!addr||!state.vms.some(v=>v.ips.includes(addr)),'Static IP is already in use.');
  must(s.memFreeMB>=p.memMB+512,'Insufficient host memory.');
  const d=s.disks.find(d=>d.name===(p.volume||'C:').slice(0,2));
  must(d && d.freeGB-p.diskGB-0.0625>=Math.max(10,d.sizeGB*0.1),'Insufficient storage safety margin.');
  return {ok:true};
}
export async function runFake(host,op,p={},options={}) {
  const state=readHost(host);
  if (state.connected===false || String(host.address).toLowerCase().includes('offline.invalid') || host.name.toLowerCase()==='offline')
    throw Error('Unable to resolve the host name. Check DNS and the WinRM endpoint.');
  switch(op){
    case 'fleet.test': return {computer:host.name,os:'Windows Server 2022 (simulated)'};
    case 'fleet.stats': case 'stats': return stats(host,state);
    case 'fleet.nat': return {networks:[{name:'lab-nat',prefix:'192.0.2.0/24'}],mappings:state.mappings};
    case 'fleet.natAdd':
      must(p.nat==='lab-nat','NAT network not found.');
      must(!state.mappings.some(m=>m.protocol===p.protocol&&m.externalPort===p.externalPort),'External port is already mapped.');
      state.mappings.push({...p,id:++state.seq});break;
    case 'fleet.natRemove': {
      const index=state.mappings.findIndex(m=>String(m.id)===String(p.id)&&m.nat===p.nat);
      must(index>=0,'NAT mapping not found.');state.mappings.splice(index,1);break;
    }
    case 'images': return {version:'13',sizeBytes:1610612736,sha256:imageHash,present:true};
    case 'preflight':return preflight(host,p,state);
    case 'freeip': {
      if(p.switch!==sw)return {ip:null,reason:'Select Lab NAT.'};
      const used=new Set([...(p.exclude||[]).map(s=>s.split('/')[0]),...state.vms.flatMap(v=>v.ips)]);
      for(let n=10;n<255;n++){const ip='192.0.2.'+n;if(!used.has(ip))return {ip:ip+'/24',gateway,reason:null};}
      return {ip:null,reason:'No free address.'};
    }
    case 'create': {
      preflight(host,p,state);
      options.onLine?.('Copying verified synthetic base');
      const vm=newVM(p.name,p);state.vms.push(vm);writeHost(host,state);
      await delay(250);
      options.onLine?.('Checking simulated cloud-init result');
      if(vm.name===process.env.HVDASH_FAKE_FAIL_VM){
        const latest=readHost(host);latest.vms=latest.vms.filter(v=>v.id!==vm.id);writeHost(host,latest);
        throw Error('cloud-init failed: simulated failure; partial VM and its disks removed. [rolled back]');
      }
      return {id:vm.id,directory:vm.directory,files:vm.disks.map(d=>d.path),firstBoot:'done'};
    }
    case 'vmDetail':return must(vmByName(state,p.name),'Virtual machine not found.');
    case 'vmApply': {
      // Yield while the job has the VM lock, as a real remoting call would.
      await delay(100);
      const latest=readHost(host),vm=must(vmByName(latest,p.name),'Virtual machine not found.');
      must(vm.id===p.id,'VM identity changed.');
      const transitions={start:'Running',stop:'Off',off:'Off',restart:'Running',pause:'Paused',resume:'Running',save:'Saved'};
      if(Object.hasOwn(transitions,p.action))vm.state=transitions[p.action];
      else switch(p.action){
        case 'delete': latest.vms=latest.vms.filter(v=>v.id!==vm.id);break;
        case 'edit':
          for(const prop of ['vcpu','startupMB','dynamic','minMB','maxMB','notes','autoStart','autoStop'])if(prop in p)vm[prop]=p[prop];break;
        case 'checkpoint-create':vm.checkpoints.push({id:randomUUID(),name:p.checkpointName,created:stamp(),sizeGB:0.25,state:vm.state});break;
        case 'checkpoint-restore':case 'checkpoint-delete':{
          const cp=must(vm.checkpoints.find(c=>c.id===p.checkpointId),'Checkpoint not found.');
          if(p.action==='checkpoint-delete')vm.checkpoints=vm.checkpoints.filter(c=>c.id!==cp.id);
          else vm.state=cp.state;
          break;
        }
        case 'console-configure': vm.consolePipe='\\\\.\\pipe\\hvdash-'+vm.id;break;
        default: throw Error('Unsupported simulated VM action: '+p.action);
      }
      writeHost(host,latest);return {ok:true};
    }
    default:throw Error('Unsupported simulated host operation: '+op);
  }
  writeHost(host,state);return {ok:true};
}
