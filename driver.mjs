import {spawn} from 'node:child_process';
import path from 'node:path';
import {root,fail} from './store.mjs';
import {StringDecoder} from 'node:string_decoder';
export function invoke(file,args,input,timeout=60000,progress=()=>{}){
 return new Promise((resolve,reject)=>{
  const proc=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,file),...args],{windowsHide:true});
  const decoder=new StringDecoder('utf8');let buffer='',result,error;
  function line(l){try{if(l.startsWith('RESULT '))result=JSON.parse(l.slice(7));else if(l.startsWith('ERROR '))error=l.slice(6);else if(l.startsWith('STEP '))progress(l.slice(5,300));}catch{error='Malformed host response';}}
  proc.stdout.on('data',b=>{buffer+=decoder.write(b);let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i).trimEnd());buffer=buffer.slice(i+1);}if(buffer.length>8000000){error='Host response too large';proc.kill();}});
  proc.stderr.resume();proc.stdin.on('error',()=>{});
  const timer=setTimeout(()=>{error='Host operation timed out. Check WinRM connectivity and reconcile the current host state before retrying.';proc.kill();},timeout);
  proc.on('error',e=>{clearTimeout(timer);reject(e);});
  proc.on('close',code=>{clearTimeout(timer);line((buffer+decoder.end()).trimEnd());if(code===0&&!error&&result!==undefined)resolve(result);else reject(fail(error||'Host operation failed. Check the service identity, host event log and remoting configuration.',502));});
  proc.stdin.end(Buffer.from(JSON.stringify(input),'utf8').toString('base64')+'\n');
 });
}
export const protectSecret=secret=>invoke('vault.ps1',[],{secret},10000);
export async function runPs(host,op,params={},options={}){
 if(process.env.HVDASH_FAKE==='1')return (await import('./fake-host.mjs')).runFake(host,op,params,options);
 const args=['-Op',op,'-Address',host.address,'-Transport',host.transport||'winrm','-InputPipe'];
 if(host.userEnv)args.push('-UserEnv',host.userEnv);
 if(host.passEnv)args.push('-PassEnv',host.passEnv);
 return invoke('hv.ps1',args,{params,credential:host.credential||null},options.timeoutMs,options.onLine);
}
