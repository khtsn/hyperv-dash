import path from 'node:path';
import {existsSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {root,dataDir,migrate,db,setUser,audit,backup} from './store.mjs';
const [command,name,role]=process.argv.slice(2);
try{
 if(command==='init'||command==='user'){
  if(command==='init'&&db.prepare('SELECT name FROM users LIMIT 1').get())throw Error('Already initialized. Use user to manage accounts.');
  const password=process.env.HVDASH_ACCOUNT_PASSWORD;
  if(!password)throw Error('Set HVDASH_ACCOUNT_PASSWORD for this command.');
  if(command==='init'){
   const tls=path.join(dataDir,'tls');mkdirSync(tls,{recursive:true});
   const key=path.join(tls,'key.pem'),cert=path.join(tls,'cert.pem');
   if(existsSync(key)!==existsSync(cert))throw Error('Both TLS files must be provided together.');
   if(!existsSync(cert)){
    const r=spawnSync('openssl',['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','365','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{windowsHide:true});
    if(r.error||r.status!==0)throw Error('Install OpenSSL or supply tls/key.pem and tls/cert.pem before initialization.');
   }
   migrate();
  }
  setUser(name,password,command==='init'?'admin':role);audit('local-cli',command,name,'ok');
  console.log('Account saved:',name);
 }else if(command==='backup'){
  if(!name)throw Error('Supply a new SQLite backup path.');
  backup(name);console.log('Database backup created:',path.resolve(name));
 }else throw Error('Usage: node admin.mjs init NAME | user NAME admin|operator|viewer | backup NEW_FILE');
}catch(e){console.error(e.message);process.exitCode=1;}
