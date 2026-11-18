import {db,put,get,list,del,fail as bad} from './store.mjs';
import {randomUUID} from 'node:crypto';
import {isIPv4} from 'node:net';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const arr=x=>x==null?[]:[].concat(x);
const loadProfiles=()=>[{id:'minimal',label:'Minimal',cloudConfig:{}},...list('profiles').filter(p=>p.id!=='minimal')];
const loadSettings=()=>get('config','settings')||{};
const saveSettings=s=>put('config','settings',s);
function defaultProfileId(profiles = loadProfiles()) {
  const id = loadSettings().defaultProfile;
  return profiles.some((p) => p.id === id) ? id : 'minimal';
}

export function listProfiles() {
  const profiles = loadProfiles();
  const def = defaultProfileId(profiles);
  return profiles.map((p) => {
    const c = p.cloudConfig;
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      builtin: p.id === 'minimal',
      isDefault: p.id === def,
      timezone: typeof c.timezone === 'string' ? c.timezone : '',
      packages: arr(c.packages).filter((x) => typeof x === 'string'),
      runcmd: arr(c.runcmd).filter((x) => typeof x === 'string'),
      files: arr(c.write_files).map((f) => ({ path: f.path || '', permissions: f.permissions || '0644', content: f.content || '' })),
    };
  });
}

function saveProfile(b) {
  const id = String(b.id || '');
  if (id !== 'minimal') {
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw bad('profile id: lowercase letters, digits and "-"');
    const label = String(b.label || '').trim();
    if (!label) throw bad('give the profile a name');
    const packages = arr(b.packages).map((x) => String(x).trim()).filter(Boolean);
    const badPkg = packages.find((x) => !/^[a-z0-9][a-z0-9+.-]+$/.test(x));
    if (badPkg) throw bad(`'${badPkg}' is not a valid Debian package name (lowercase letters, digits, + . -)`);
    const runcmd = arr(b.runcmd).map((x) => String(x).trim()).filter(Boolean);
    const timezone = String(b.timezone || '').trim();
    if (timezone && !/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(timezone)) throw bad('timezone looks like Asia/Ho_Chi_Minh');
    const files = arr(b.files).map((f) => ({
      path: String(f.path || '').trim(),
      permissions: String(f.permissions || '0644').trim(),
      content: String(f.content || '').replace(/\r\n/g, '\n'),
    }));
    for (const f of files) {
      if (!/^\/[^\0]*[^/]$/.test(f.path)) throw bad(`file path must be absolute: '${f.path}'`);
      if (!/^0[0-7]{3}$/.test(f.permissions)) throw bad(`file mode must look like 0755: '${f.permissions}'`);
    }
    // Keep any hand-written cloud-config keys the editor does not know about.
    let existing = {};
    if (get('profiles',id)) {
      try { existing = get('profiles',id).cloudConfig || {}; } catch { existing = {}; }
    }
    const cloudConfig = { ...existing };
    const set = (k, v, keep) => { if (keep) cloudConfig[k] = v; else delete cloudConfig[k]; };
    set('timezone', timezone, Boolean(timezone));
    set('packages', [...new Set(packages)], packages.length > 0);
    set('runcmd', runcmd, runcmd.length > 0);
    set('write_files', files, files.length > 0);
    put('profiles',id,{ id, label, description: String(b.description || '').trim(), cloudConfig });
  }
  const settings = loadSettings();
  if (b.isDefault) settings.defaultProfile = id;
  else if (settings.defaultProfile === id) delete settings.defaultProfile;
  saveSettings(settings);
  return { ok: true, id };
}

function deleteProfile(b) {
  const id = String(b.id || '');
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id) || id === 'minimal' || !get('profiles',id)) throw bad('unknown profile');
  if (b.confirm !== id) throw bad('Type the exact profile ID to remove it.');
  del('profiles',id);
  const settings = loadSettings();
  if (settings.defaultProfile === id) { delete settings.defaultProfile; saveSettings(settings); }
  return { ok: true };
}

export function networkKey(network, host) {
  if (!network) throw bad('Select an available switch.');
  // Overlapping private/internal switches are separate L2 domains. External switches
  // may span hosts, so be conservative and reject reused addresses fleet-wide.
  return String(network.type).toLowerCase() === 'external' ? 'external'
    : (host.name + '/' + (network.id || network.name)).toLowerCase();
}

export function recordObserved(hostName, snapshot) {
  const host = typeof hostName === 'string' ? {name: hostName} : hostName;
  const networks = snapshot.networks || [];
  const insert = db.prepare('INSERT OR IGNORE INTO ip_ledger(network,address,host,vm,source) VALUES(?,?,?,?,?)');
  for (const vm of snapshot.vms || []) {
    const seen=new Map();
    for (const nic of vm.adapters || []) {
      const network = networks.find(n => n.name === nic.switch || (nic.switchId && n.id === nic.switchId));
      if (!network) continue;
      const key=networkKey(network,host);
      if(!seen.has(key))seen.set(key,{ips:new Set(),complete:true});
      const live=seen.get(key);
      if(!arr(nic.ips).some(isIPv4))live.complete=false;
      for (const ip of arr(nic.ips).filter(isIPv4)) {
        live.ips.add(ip);
        insert.run(key,ip,host.name,vm.name,'observed');
      }
    }
    if(vm.state==='Running'){
      for(const [key,live] of seen){
        if(!live.complete||!live.ips.size)continue;
        const rows=db.prepare("SELECT address FROM ip_ledger WHERE source='observed' AND network=? AND host=? AND vm=?").all(key,host.name,vm.name);
        for(const row of rows)if(!live.ips.has(row.address)){
          db.prepare("DELETE FROM ip_ledger WHERE source='observed' AND network=? AND address=? AND host=? AND vm=?").run(key,row.address,host.name,vm.name);
        }
      }
    }
  }
}

function number(v,min,max,what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n<min || n>max) throw bad(what + ' must be an integer between ' + min + ' and ' + max);
  return n;
}
function asInt(ip) { return ip.split('.').reduce((a,n)=>a*256+Number(n),0); }
export function staticNetwork(b) {
  if (!b.ip) return {};
  const match = /^([^/]+)\/(\d{1,2})$/.exec(String(b.ip).trim());
  if (!match || !isIPv4(match[1]) || +match[2]<1 || +match[2]>30) throw bad('Static IP requires an IPv4 address and a prefix between /1 and /30.');
  const ip=match[1], prefix=+match[2], gateway=String(b.gateway||'').trim();
  const size=2**(32-prefix), start=Math.floor(asInt(ip)/size)*size, end=start+size-1;
  if(asInt(ip)<=start || asInt(ip)>=end || !isIPv4(gateway) || asInt(gateway)<=start || asInt(gateway)>=end || gateway===ip)throw bad('IP and gateway must be distinct usable addresses in the same subnet.');
  const dns=String(b.dns||'1.1.1.1,8.8.8.8').split(',').map(x=>x.trim());
  if(!dns.length||dns.some(x=>!isIPv4(x)))throw bad('Supply comma-separated IPv4 DNS servers.');
  return {ip,address:ip,prefix,gateway,dns};
}
function reserve(network,address,host,vm) {
  if(!address)return;
  if(db.prepare('SELECT 1 AS used FROM ip_ledger WHERE network=? AND address=?').get(network,address))throw bad('This IP address is already reserved or observed on this network.',409);
  db.prepare('INSERT INTO ip_ledger VALUES(?,?,?,?,?)').run(network,address,host,vm,'reserved');
}
const imageId='debian-13';
const catalogPath=path.join(dir,'cache','catalog-v1','debian-13','manifest.json');
const reportScript=readFileSync(path.join(dir,'firstboot.py')).toString('base64');
function spec(b) {
  if(typeof b.name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,30}$/.test(b.name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(b.name))throw bad('Use a VM name of 1â€“31 letters, digits and hyphens. Device names are reserved.');
  if(typeof b.user!=='string'||!/^[a-z_][a-z0-9_-]{0,30}$/.test(b.user))throw bad('Supply a valid Linux login user.');
  const password=String(b.password||''), sshKey=String(b.sshKey||'').trim();
  if(!password&&!sshKey || /[\r\n\0]/.test(password+sshKey))throw bad('Supply a single-line password or SSH public key.');
  if(sshKey&&!/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh.com) [A-Za-z0-9+/]+=*( .*)?$/.test(sshKey))throw bad('Supply an OpenSSH public key.');
  if(typeof b.switch!=='string'||!b.switch||b.switch.length>128||/[\x00-\x1f*?\[\]]/.test(b.switch))throw bad('Select a valid virtual switch.');
  const volume=String(b.volume||'').toUpperCase();
  if(!/^[A-Z]:$/.test(volume))throw bad('Select a local fixed volume from the host.');
  if(b.image && b.image!==imageId)throw bad('Select an image in the library.');
  const p=loadProfiles().find(x=>x.id===(b.profile||defaultProfileId()));
  if(!p)throw bad('Unknown software profile.');
  const network=staticNetwork(b), reportId=randomUUID();
  const user={name:b.user,sudo:'ALL=(ALL) NOPASSWD:ALL',shell:'/bin/bash',lock_passwd:!password};
  if(password)user.plain_text_passwd=password;
  if(sshKey)user.ssh_authorized_keys=[sshKey];
  const extra=JSON.parse(JSON.stringify(p.cloudConfig||{}).replaceAll('{{user}}',b.user));
  const cloud={...extra,hostname:b.name,users:[user],ssh_pwauth:Boolean(password),package_update:true,
    packages:[...new Set(['hyperv-daemons',...arr(extra.packages)])],
    bootcmd:[['sh','-c','umask 077; echo '+reportScript+' | base64 -d >/run/hvdash-firstboot.py && systemd-run --no-block --unit=hvdash-firstboot-'+reportId+' /usr/bin/python3 /run/hvdash-firstboot.py '+reportId],...arr(extra.bootcmd)],
    runcmd:['set -e','udevadm control --reload','udevadm trigger --action=add --subsystem-match=misc','systemctl --no-block start hv-kvp-daemon.service','systemctl enable --no-block --now serial-getty@ttyS0.service',...arr(extra.runcmd)]};
  return {name:b.name,image:imageId,reportId,volume,switch:b.switch,cpu:number(b.cpu,1,32,'vCPU'),memMB:number(b.memMB,512,262144,'Memory'),diskGB:number(b.diskGB,4,2000,'Disk size'),
    ip:network.ip||'',gateway:network.gateway||'',prefix:network.prefix??null,userData:'#cloud-config\n'+JSON.stringify(cloud)+'\n',
    networkConfig:network.ip?JSON.stringify({network:{version:2,ethernets:{eth0:{dhcp4:false,addresses:[network.ip+'/'+network.prefix],routes:[{to:'0.0.0.0/0',via:network.gateway}],nameservers:{addresses:network.dns}}}}}):'',
    metaData:'instance-id: hvdash-'+reportId+'\nlocal-hostname: '+b.name+'\n'};
}
function inventoryNet(snapshot, name) {
  return (snapshot?.networks||[]).find(n=>n.name===name);
}
const activeImages = new Map();
const upstream='https://cloud.debian.org/images/cloud/trixie/latest/';
const archiveName='debian-13-generic-amd64.tar.xz';
let catalogFetch;
async function refreshUpstream(){
  if(process.env.HVDASH_FAKE==='1')return;
  const cached=get('catalog','debian-13');
  if(cached && Date.now()-cached.checked<6*3600000)return;
  if(!catalogFetch)catalogFetch=(async()=>{
    const options={signal:AbortSignal.timeout(7000)};
    const [sums,archive]=await Promise.all([fetch(upstream+'SHA512SUMS',options),fetch(upstream+archiveName,{...options,method:'HEAD'})]);
    if(!sums.ok||!archive.ok)return;
    const line=(await sums.text()).split(/\r?\n/).find(l=>l.trim().split(/\s+/)[1]?.replace(/^\*/,'')===archiveName);
    const archiveSha512=line?.split(/\s+/)[0];
    const archiveBytes=Number(archive.headers.get('content-length'));
    if(/^[a-f0-9]{128}$/i.test(archiveSha512)&&archiveBytes>0)
      put('catalog','debian-13',{archiveSha512,archiveBytes,checked:Date.now(),version:'13-'+archiveSha512.slice(0,12)});
  })().catch(()=>{}).finally(()=>{catalogFetch=undefined});
  return catalogFetch;
}
async function imageLibrary(ctx) {
  let meta={};
  try{meta=JSON.parse(readFileSync(catalogPath,'utf8').replace(/^\uFEFF/,''));}catch{}
  const hosts=list('hosts');
  const probes=[refreshUpstream()];
  for(const host of hosts) {
    if((activeImages.get(host.name)||0)>Date.now())continue;
    activeImages.set(host.name,Date.now()+60000);
    probes.push(ctx.runPs(host,'images',{}, {timeoutMs:30000}).then(info=>put('imageCopies',host.name,info)).catch(()=>{}));
  }
  await Promise.race([Promise.all(probes),new Promise(resolve=>setTimeout(resolve,150))]);
  const known=get('catalog','debian-13')||{};
  const copy=hosts.map(h=>get('imageCopies',h.name)).find(i=>i?.present)||{};
  return [{id:imageId,os:'Debian GNU/Linux',version:meta.version||copy.version||known.version||'13 (trixie)',sizeBytes:meta.sizeBytes||copy.sizeBytes||null,sha256:meta.sha256||copy.sha256||null,archiveSha512:meta.archiveSha512||known.archiveSha512||null,archiveBytes:known.archiveBytes||null,sourceURL:upstream,
    hosts:hosts.filter(h=>{const info=get('imageCopies',h.name);return info?.present && (meta.sha256?info.sha256===meta.sha256:true);}).map(h=>h.name)}];
}
export async function provisionRoute(ctx){
  const {key,b,url,user,runPs,startJob}=ctx;
  if(key==='GET /api/profiles')return listProfiles();
  if(key==='POST /api/profile' || key==='POST /api/profile/delete') {
    if(user.role!=='admin')throw bad('Administrator access required.',403);
    return key.endsWith('/delete')?deleteProfile(b):saveProfile(b);
  }
  if(key==='GET /api/ledger')return db.prepare('SELECT * FROM ip_ledger ORDER BY network,address').all();
  if(key==='GET /api/images')return imageLibrary(ctx);
  if(key!=='GET /api/freeip' && key!=='POST /api/create')return;
  const host=ctx.host(key.startsWith('GET')?url.searchParams.get('host'):b.host);
  const sw=key.startsWith('GET')?url.searchParams.get('switch'):b.switch;
  const snap=await ctx.stats(host.name);
  const network=inventoryNet(snap,sw);
  if(!network)throw bad('Refresh the host inventory and select a switch it exposes.');
  const networkId=networkKey(network,host);
  if(key==='GET /api/freeip'){
    const exclude=db.prepare('SELECT DISTINCT address FROM ip_ledger WHERE network=?').all(networkId).map(r=>r.address);
    return runPs(host,'freeip',{switch:sw,exclude},{timeoutMs:120000});
  }
  if(user.role==='viewer')throw bad('Operator access required.',403);
  const params=spec(b);
  if(snap.vms?.some(v=>v.name.toLowerCase()===b.name.toLowerCase()))throw bad('This VM name already exists on the host.',409);
  if(!snap.disks?.some(d=>d.name.toUpperCase()===params.volume))throw bad('Choose a volume listed by this host.');
  // Reserve the IP and the durable VM job in one transaction, before asynchronous host I/O.
  db.exec('BEGIN IMMEDIATE');
  try{
    if(db.prepare("SELECT 1 FROM jobs WHERE host=? COLLATE NOCASE AND op='create' AND status='running'").get(host.name))
      throw bad('A provisioning job already holds this hostâ€™s capacity reservation. Retry after it finishes.',409);
    reserve(networkId,params.ip,host.name,b.name);
    const job=startJob(user.name,host.name,b.name,'create',async step=>{
      const release=()=>db.prepare("DELETE FROM ip_ledger WHERE network=? AND address=? AND host=? AND vm=? AND source='reserved'").run(networkId,params.ip,host.name,b.name);
      step('Checking live name, switch, address, RAM and free disk');
      const {userData,metaData,networkConfig,...resources}=params;
      try{await runPs(host,'preflight',resources,{timeoutMs:30000});}catch(e){release();throw e;}
      try{
        const made=await runPs(host,'create',params,{timeoutMs:50*60000,onLine:step});
        if(!made?.id || made.firstBoot!=='done')throw bad('First-boot result unavailable. Reconcile the VM and its reserved address on the host.',502);
        put('vmOwnership',(host.name+'/'+b.name).toLowerCase(),{id:made.id,directory:made.directory,files:made.files,creator:user.name,created:new Date().toISOString()});
        if(params.ip)db.prepare("UPDATE ip_ledger SET source='static' WHERE network=? AND address=? AND host=? AND vm=?").run(networkId,params.ip,host.name,b.name);
        activeImages.delete(host.name);
        step('Debian cloud-init confirmed successful');
      }catch(e){
        // A disconnected remote call can leave a VM alive. Never make its IP available speculatively.
        if(e.message.includes('[rolled back]')||e.message.includes('[not created]'))release();
        throw e;
      }
    });
    db.exec('COMMIT');return job;
  }catch(e){db.exec('ROLLBACK');throw e;}
}
