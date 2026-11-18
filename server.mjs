import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {db,root,dataDir,audit,session,login,migrate,list,fail,SESSION_SECONDS,migrateSessions,changeAdminPassword} from './store.mjs';
import {startJob,recoverJobs,decodeJob} from './jobs.mjs';
import {runPs} from './driver.mjs';
import {host,stats,startFleet,fleetRoute} from './fleet.mjs';
import {vmRoute} from './vm.mjs';
import {provisionRoute} from './provisioning.mjs';
import {monitoringRoute} from './monitoring.mjs';

const port=Number(process.env.HVDASH_PORT||8722), bind=process.env.HVDASH_BIND||'127.0.0.1';
const publicURL=new URL(process.env.HVDASH_ORIGIN||('https://127.0.0.1:'+port));
if(publicURL.protocol!=='https:'||publicURL.username||publicURL.password||publicURL.search||publicURL.hash||publicURL.pathname!=='/')throw Error('HVDASH_ORIGIN must be an HTTPS origin.');
if(!db.prepare('SELECT name FROM users LIMIT 1').get())throw Error('Initialize a named administrator using node admin.mjs init NAME. See README.md.');
const tls=path.join(dataDir,'tls');
if(!existsSync(path.join(tls,'key.pem'))||!existsSync(path.join(tls,'cert.pem')))throw Error('Missing TLS certificate or private key. See README.md.');
const publicAssets=new Set(['login.js','login.css']);
const assets=new Set(['dashboard.js','dashboard.css','vm-ui.js','provision-ui.js','fleet-ui.js','console-ui.js',...publicAssets]);
const rolePower={viewer:0,operator:1,admin:2};
const loginLimit=new Map();
const cookie=(token,seconds)=>'__Host-hvdash='+token+'; Max-Age='+seconds+'; Secure; HttpOnly; SameSite=Strict; Path=/';
function throttle(ip){
 const now=Date.now();
 for(const [k,entry] of loginLimit)if(entry.until<=now)loginLimit.delete(k);
 const entry=loginLimit.get(ip)||{tries:0,until:now+60000};
 if(entry.tries>=12)throw fail('Too many sign-in attempts. Try again in a minute.',429);
 entry.tries++;loginLimit.set(ip,entry);
}
function send(res,status,value){
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));
}
function file(res,name){
 const mime={'.html':'text/html','.css':'text/css','.js':'application/javascript'}[path.extname(name)];
 const data=readFileSync(path.join(root,name));res.writeHead(200,{'Content-Type':mime+'; charset=utf-8'});res.end(data);
}
async function body(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw fail('Use application/json.',415);
 const chunks=[];let size=0;
 for await(const chunk of req){if((size+=chunk.length)>160000)throw fail('Request is too large.',413);chunks.push(chunk);}
 try{const b=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(b&&typeof b==='object'&&!Array.isArray(b))return b;}catch{}
 throw fail('Invalid JSON object.');
}
function requireRole(u,min){if(rolePower[u.role]<rolePower[min])throw fail('This operation requires the '+min+' role.',403);}
function required(key,b){
 if(key==='POST /api/logout'||key==='POST /api/activity')return 'viewer';
 if(key==='POST /api/create')return 'operator';
 if(key==='POST /api/vm'&&['start','stop','off','restart','pause','resume','save'].includes(b.action))return 'operator';
 if(key.startsWith('POST ')||key.includes('/api/console/')||key.includes('/api/audit'))return 'admin';
 return 'viewer';
}
function page(url){const value=Number(url.searchParams.get('offset')||0);return Number.isSafeInteger(value)&&value>=0?value:0;}
function auditQuery(q){
 return {sql:' FROM audit WHERE instr(lower(actor||char(32)||action||char(32)||target||char(32)||outcome),lower(?))>0 ORDER BY seq DESC',param:(q||'').slice(0,200)};
}
function csv(value){const s=String(value);return '"'+(/^[\s]*[=+@-]/.test(s)?"'":'')+s.replaceAll('"','""')+'"';}
async function handle(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; form-action 'self'; base-uri 'none'");
 let actor=null,target='',action='',tracked=false;
 try{
  if(req.headers.host?.toLowerCase()!==publicURL.host.toLowerCase() || (req.headers.origin&&req.headers.origin!==publicURL.origin))throw fail('Unexpected request origin.',403);
  const url=new URL(req.url,publicURL);
  if(url.origin!==publicURL.origin)throw fail('Unexpected request origin.',403);
  if(!['GET','POST'].includes(req.method))throw fail('Unsupported method.',405);
  if(req.method==='POST'&&req.headers.origin!==publicURL.origin)throw fail('A same-origin request is required.',403);
  const key=req.method+' '+url.pathname, asset=url.pathname.slice(1);
  if(key==='GET /login')return file(res,'login.html');
  if(req.method==='GET'&&publicAssets.has(asset))return file(res,asset);
  if(key==='POST /api/login'){
   throttle(req.socket.remoteAddress);const b=await body(req), u=await login(b.name,b.password);
   if(!u){audit('anonymous','login','','denied');throw fail('Incorrect username or password.',401);}
   loginLimit.delete(req.socket.remoteAddress);
   res.setHeader('Set-Cookie',cookie(u.token,SESSION_SECONDS));
   audit(u.name,'login','','ok');return send(res,200,{name:u.name,role:u.role,csrf:u.csrf});
  }
  actor=session(req);
  if(!actor){if(key==='GET /'){res.writeHead(303,{Location:'/login'});return res.end();}throw fail('Sign in to continue.',401);}
  if(key==='GET /')return file(res,'dashboard.html');
  if(req.method==='GET'&&assets.has(asset))return file(res,asset);
  if(key==='GET /api/session'){
   // Persist an existing browser-session cookie after upgrading from the old release.
   const token=req.headers.cookie.match(/(?:^|;\s*)__Host-hvdash=([a-f0-9]{64})(?:;|$)/)[1];
   res.setHeader('Set-Cookie',cookie(token,Math.max(0,Math.floor((actor.expires-Date.now())/1000))));
   return send(res,200,{name:actor.name,role:actor.role,csrf:actor.csrf});
  }
  const write=req.method==='POST';
  if(write&&req.headers['x-csrf-token']!==actor.csrf)throw fail('Session token expired. Reload the page.',403);
  const b=write?await body(req):{};
  // Older open dashboards may still send this heartbeat. Expiry is fixed at login.
  if(key==='POST /api/activity')return send(res,200,{ok:true});
  action=url.pathname.replace(/^\/api\//,'').slice(0,80);
  if(typeof b.action==='string')action+=':'+b.action.slice(0,40);
  target=[b.host,b.name].filter(x=>typeof x==='string').map(x=>x.slice(0,100)).join('/');
  tracked=write && !key.endsWith('/console/write');
  requireRole(actor,required(key,b));
  if(key==='POST /api/change-password'){
   target=actor.name;
   const limitKey='password:'+actor.name;
   throttle(limitKey);
   await changeAdminPassword(actor,b.currentPassword,b.newPassword);
   loginLimit.delete(limitKey);res.setHeader('Set-Cookie',cookie('',0));
   return send(res,200,{ok:true});
  }
  if(key==='POST /api/logout'){
   db.prepare('DELETE FROM sessions WHERE id=?').run(actor.id);res.setHeader('Set-Cookie','__Host-hvdash=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/');
   audit(actor.name,'logout','','ok');return send(res,200,{ok:true});
  }
  if(key==='GET /api/jobs')return send(res,200,db.prepare('SELECT * FROM jobs ORDER BY started DESC LIMIT 100 OFFSET ?').all(page(url)).map(decodeJob));
  if(key==='GET /api/job'){const j=decodeJob(db.prepare('SELECT * FROM jobs WHERE id=?').get(url.searchParams.get('id')||''));if(!j)throw fail('Job not found.',404);return send(res,200,j);}
  if(key==='GET /api/audit'||key==='GET /api/audit.csv'){
   const {sql,param}=auditQuery(url.searchParams.get('q'));
   if(key.endsWith('.csv')){
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="hyperv-audit.csv"'});
    function* records(){
     yield 'sequence,time,actor,action,target,outcome\r\n';
     for(const row of db.prepare('SELECT *'+sql).iterate(param))yield Object.values(row).map(csv).join(',')+'\r\n';
    }
    await pipeline(Readable.from(records()),res);return;
   }
   return send(res,200,db.prepare('SELECT *'+sql+' LIMIT 200 OFFSET ?').all(param,page(url)));
  }
  const ctx={key,url,b,user:actor,host,hosts:()=>list('hosts'),stats:h=>stats(typeof h==='string'?h:h.name),runPs,startJob,
   isBusy:(h,n)=>!!db.prepare("SELECT 1 FROM jobs WHERE host=? COLLATE NOCASE AND name=? COLLATE NOCASE AND status='running'").get(h,n),
   request:req,response:res};
  let result;
  for(const handler of [fleetRoute,monitoringRoute,vmRoute,provisionRoute]){result=await handler(ctx);if(result!==undefined)break;}
  if(result===undefined)throw fail('Resource not found.',404);
  if(tracked)audit(actor.name,action,target,result?.job?'queued':'ok');
  send(res,result?.job?202:200,result);
 }catch(e){
  if(tracked)audit(actor?.name||'anonymous',action,target,e.status===403?'denied':'failed');
  if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Operation failed. Check the management service and try again.'});else res.end();
 }
}
const server=https.createServer({key:readFileSync(path.join(tls,'key.pem')),cert:readFileSync(path.join(tls,'cert.pem')),minVersion:'TLSv1.2'},handle);
server.requestTimeout=30000;server.headersTimeout=15000;
const identity=crypto.createHash('sha256').update(realpathSync(dataDir).toLowerCase()).digest('hex').slice(0,32);
const guard=net.createServer(s=>s.destroy());
guard.on('error',()=>{console.error('The state directory is in use by another server.');process.exit(1);});
guard.listen('\\\\.\\pipe\\hvdash-'+identity,()=>{
 server.on('error',e=>{console.error('HTTPS listener failed:',e.code);process.exit(1);});
 server.listen(port,bind,()=>{migrate();migrateSessions();recoverJobs();startFleet();console.log('Hyper-V Fleet listening on '+publicURL.origin);});
});
function shutdown(){server.close();server.closeAllConnections();guard.close();process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
if(process.env.HVDASH_WINDOWS_SERVICE==='1'){process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{if(chunk.trim()==='shutdown')shutdown();});}
