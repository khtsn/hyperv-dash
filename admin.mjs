import path from 'node:path';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {root,dataDir,migrate,db,setUser,audit,backup} from './store.mjs';
const [command,name,role]=process.argv.slice(2);
// DER type-length-value; hex strings are pre-encoded fields. Lengths stay below 64 KiB.
function tlv(tag,...parts){
 const body=Buffer.concat(parts.map(p=>typeof p==='string'?Buffer.from(p,'hex'):p)),n=body.length;
 return Buffer.concat([Buffer.from([tag,...(n<128?[n]:n<256?[0x81,n]:[0x82,n>>8,n&255])]),body]);
}
// Self-signed X.509 v3 for CN=localhost, SAN DNS:localhost and IP:127.0.0.1, valid 365 days.
function localhostCertificate(){
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:3072});
 const sha256WithRSA=tlv(0x30,'06092a864886f70d01010b','0500');
 const cn=tlv(0x30,tlv(0x31,tlv(0x30,'0603550403',tlv(0x0c,Buffer.from('localhost')))));
 const time=d=>tlv(0x17,Buffer.from(d.toISOString().slice(2,19).replace(/\D/g,'')+'Z'));
 const now=new Date(),serial=randomBytes(16);serial[0]=serial[0]&0x7f|0x40;
 const extensions=tlv(0xa3,tlv(0x30,
  tlv(0x30,'0603551d13','0101ff',tlv(0x04,tlv(0x30,'0101ff'))),
  tlv(0x30,'0603551d11',tlv(0x04,tlv(0x30,tlv(0x82,Buffer.from('localhost')),'87047f000001')))));
 const tbs=tlv(0x30,tlv(0xa0,'020102'),tlv(0x02,serial),sha256WithRSA,cn,
  tlv(0x30,time(now),time(new Date(now.getTime()+365*864e5))),cn,publicKey.export({type:'spki',format:'der'}),extensions);
 const der=tlv(0x30,tbs,sha256WithRSA,tlv(0x03,'00',sign('sha256',tbs,privateKey)));
 return {key:privateKey.export({type:'pkcs8',format:'pem'}),cert:'-----BEGIN CERTIFICATE-----\n'+der.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n'};
}
try{
 if(command==='init'||command==='user'){
  if(command==='init'&&db.prepare('SELECT name FROM users LIMIT 1').get())throw Error('Already initialized. Use user to manage accounts.');
  const password=process.env.HVDASH_ACCOUNT_PASSWORD;
  if(!password)throw Error('Set HVDASH_ACCOUNT_PASSWORD for this command.');
  if(command==='init'){
   const tls=path.join(dataDir,'tls');mkdirSync(tls,{recursive:true});
   const key=path.join(tls,'key.pem'),cert=path.join(tls,'cert.pem');
   if(existsSync(key)!==existsSync(cert))throw Error('Found only one of '+key+' and '+cert+'. Supply both, or delete the one that exists to generate a localhost certificate.');
   if(!existsSync(cert)){
    const pair=localhostCertificate();
    writeFileSync(key,pair.key,{flag:'wx'});writeFileSync(cert,pair.cert,{flag:'wx'});
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
