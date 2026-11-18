import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, existsSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFileSync } from 'node:child_process';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.resolve(process.env.HVDASH_DATA || path.join(root, 'state'));
const freshDirectory=!existsSync(dataDir);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if(freshDirectory && process.platform==='win32'){
 try {
  const system32=path.join(process.env.SystemRoot,'System32');
  const sid=execFileSync(path.join(system32,'whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-[\d-]+/)?.[0];
  if(!sid)throw Error('Cannot secure the new state directory: Windows user SID unavailable.');
  const grants=[...new Set([sid,'S-1-5-18','S-1-5-32-544'])].map(s=>'*'+s+':(OI)(CI)F');
  execFileSync(path.join(system32,'icacls.exe'),[dataDir,'/inheritance:r','/grant:r',...grants],{windowsHide:true,stdio:'pipe'});
 } catch(e){rmdirSync(dataDir);throw e;}
}
export const db = new DatabaseSync(path.join(dataDir, 'fleet.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY COLLATE NOCASE, role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, username TEXT REFERENCES users(name) ON DELETE CASCADE, csrf TEXT NOT NULL, seen INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (category TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(category,id));
CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, host TEXT NOT NULL, name TEXT NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL, status TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, log TEXT NOT NULL DEFAULT '[]');
CREATE UNIQUE INDEX IF NOT EXISTS active_vm_job ON jobs(host COLLATE NOCASE,name COLLATE NOCASE) WHERE status='running';
CREATE TABLE IF NOT EXISTS metrics (host TEXT, at TEXT, value TEXT NOT NULL, PRIMARY KEY(host,at));
CREATE INDEX IF NOT EXISTS metrics_expiry ON metrics(at);
CREATE TABLE IF NOT EXISTS vm_metrics (host TEXT NOT NULL, vm TEXT NOT NULL, at TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(host,vm,at));
CREATE INDEX IF NOT EXISTS vm_metrics_expiry ON vm_metrics(at);
CREATE TABLE IF NOT EXISTS metric_guests (host TEXT NOT NULL, vm TEXT NOT NULL, name TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(host,vm));
CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY, host TEXT NOT NULL, rule TEXT NOT NULL, resource TEXT NOT NULL, message TEXT NOT NULL, opened TEXT NOT NULL, resolved TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS active_alert ON alerts(host,rule,resource) WHERE resolved IS NULL;
CREATE TABLE IF NOT EXISTS alert_delivery (id INTEGER PRIMARY KEY, alert INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE, transition TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, sent TEXT, UNIQUE(alert,transition));
CREATE TABLE IF NOT EXISTS ip_ledger (network TEXT, address TEXT, host TEXT NOT NULL, vm TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(network,address,host,vm));
`);
export const stamp = () => new Date().toISOString();
export const fail = (message,status=400)=>Object.assign(new Error(message),{status});
export function put(cat,id,value){db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?,?)').run(cat,id,JSON.stringify(value));}
export function get(cat,id){const r=db.prepare('SELECT value FROM kv WHERE category=? AND id=?').get(cat,id);return r && JSON.parse(r.value);}
export function list(cat){return db.prepare('SELECT value FROM kv WHERE category=? ORDER BY id').all(cat).map(r=>JSON.parse(r.value));}
export function del(cat,id){db.prepare('DELETE FROM kv WHERE category=? AND id=?').run(cat,id);}
export function audit(actor,action,target,outcome){db.prepare('INSERT INTO audit(at,actor,action,target,outcome) VALUES(?,?,?,?,?)').run(stamp(),actor,action,target,outcome);}
export function migrate(){
 if(get('meta','imported'))return;
 db.exec('BEGIN IMMEDIATE');
 try {
  const hostFile=path.join(root,'hosts.json');
  const oldHosts=process.env.HVDASH_FAKE==='1'||!existsSync(hostFile)?[]:JSON.parse(readFileSync(hostFile,'utf8'));
  for(const h of oldHosts)put('hosts',h.name,{name:h.name,address:h.address,transport:h.transport||'winrm',userEnv:h.userEnv,passEnv:h.passEnv});
  for(const f of readdirSync(path.join(root,'profiles')).filter(f=>f.endsWith('.json'))){const id=f.slice(0,-5);put('profiles',id,{...JSON.parse(readFileSync(path.join(root,'profiles',f),'utf8')),id});}
  if(existsSync(path.join(root,'settings.json')))put('config','settings',JSON.parse(readFileSync(path.join(root,'settings.json'),'utf8')));
  put('meta','imported',true);db.exec('COMMIT');
 } catch(e){db.exec('ROLLBACK');throw e;}
}
export function setUser(name,password,role){
 if(!/^[a-zA-Z0-9_.-]{1,48}$/.test(name)||!['admin','operator','viewer'].includes(role)||typeof password!=='string'||password.length<14||password.length>256)throw fail('Use a named account, admin/operator/viewer role, and a password of 14–256 characters.');
 if(role!=='admin' && db.prepare("SELECT role FROM users WHERE name=?").get(name)?.role==='admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n===1)throw fail('Keep at least one administrator.');
 const salt=randomBytes(24).toString('hex'), hash=scryptSync(password,salt,64).toString('hex');
 db.prepare('INSERT INTO users VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET role=excluded.role,salt=excluded.salt,hash=excluded.hash').run(name,role,salt,hash);
 db.prepare('DELETE FROM sessions WHERE username=? COLLATE NOCASE').run(name);
}
const digest=token=>createHash('sha256').update(token).digest('hex');
const derive=promisify(scrypt);
export const SESSION_SECONDS=7*24*60*60;
export function migrateSessions(now=Date.now()){
 db.exec('BEGIN IMMEDIATE');
 try{
  if(!get('meta','weekSessions')){
   // Apply the old rules first so changing the policy cannot revive an expired token.
   db.prepare('DELETE FROM sessions WHERE expires<=? OR seen<=?').run(now,now-30*60000);
   db.prepare('UPDATE sessions SET expires=expires+?').run(SESSION_SECONDS*1000-8*3600000);
   put('meta','weekSessions',true);
  }
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export async function login(name,password){
 if(typeof name!=='string'||typeof password!=='string'||password.length>256)return;
 const user=db.prepare('SELECT * FROM users WHERE name=?').get(name);
 const candidate=await derive(password,user?.salt||'unknown-account',64);
 if(!user||!timingSafeEqual(candidate,Buffer.from(user.hash,'hex')))return;
 const token=randomBytes(32).toString('hex'), csrf=randomBytes(24).toString('hex'), now=Date.now();
 db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
 // The account may have changed while scrypt was running.
 const inserted=db.prepare('INSERT INTO sessions SELECT ?,name,?,?,? FROM users WHERE name=? AND hash=? AND role=?').run(digest(token),csrf,now,now+SESSION_SECONDS*1000,user.name,user.hash,user.role);
 if(!inserted.changes)return;
 return {token,csrf,name:user.name,role:user.role};
}
export function session(req){
 const token=(req.headers.cookie||'').match(/(?:^|;\s*)__Host-hvdash=([a-f0-9]{64})(?:;|$)/)?.[1];
 if(!token)return;
 const id=digest(token),now=Date.now();
 const r=db.prepare('SELECT s.id,s.csrf,s.expires,u.name,u.role FROM sessions s JOIN users u ON s.username=u.name WHERE s.id=? AND s.expires>?').get(id,now);
 return r;
}
export async function changeAdminPassword(actor,currentPassword,newPassword){
 if(actor.role!=='admin')throw fail('Administrator access required.',403);
 if(typeof currentPassword!=='string'||currentPassword.length>256||!currentPassword)throw fail('Enter your current password.');
 if(typeof newPassword!=='string'||newPassword.length<14||newPassword.length>256||newPassword===currentPassword)throw fail('Choose a different password of 14–256 characters.');
 const account=db.prepare("SELECT hash,salt FROM users WHERE name=? AND role='admin'").get(actor.name);
 if(!account||!timingSafeEqual(await derive(currentPassword,account.salt,64),Buffer.from(account.hash,'hex')))throw fail('Current password is incorrect.',403);
 const salt=randomBytes(24).toString('hex'), hash=(await derive(newPassword,salt,64)).toString('hex');
 db.exec('BEGIN IMMEDIATE');
 try{
  const changed=db.prepare("UPDATE users SET salt=?,hash=? WHERE name=? AND hash=? AND role='admin' AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND username=users.name AND expires>?)").run(salt,hash,actor.name,account.hash,actor.id,Date.now());
  if(!changed.changes)throw fail('Sign in again before changing your password.',401);
  db.prepare('DELETE FROM sessions WHERE username=? COLLATE NOCASE').run(actor.name);
  audit(actor.name,'change-password',actor.name,'ok');
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function backup(file){if(existsSync(file))throw fail('Choose a new backup filename');db.prepare('VACUUM INTO ?').run(path.resolve(file));}
