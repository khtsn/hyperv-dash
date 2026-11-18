import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import {root,fail} from './store.mjs';

export function openSerial(host,id) {
  if (process.env.HVDASH_FAKE === '1') {
    let output = 'Fake serial console connected.\r\n';
    return {
      ready: Promise.resolve(), read: async () => {const text=output;output='';return text;},
      write: async data => {output=(output+data).slice(-32768);}, close: () => {}
    };
  }
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',path.join(root,'console-bridge.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const reader=createInterface({input:child.stdout});
  const decoder=new StringDecoder('utf8');
  let pending=null,ended=false,serialQueue=Promise.resolve(),queueDepth=0;
  function stop(error=fail('Console closed.',410)) {
    if (ended) return;
    ended=true;
    if (pending) {clearTimeout(pending.timer);pending.reject(error);pending=null;}
    child.stdin.end();child.kill();
  }
  function exchange(line,timeout) {
    if(ended)return Promise.reject(fail('Console closed.',410));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>stop(fail('Console timed out. Check the host connection.',504)),timeout);
      pending={resolve,reject,timer};
      child.stdin.write(line+'\n');
    });
  }
  reader.on('line',line=>{
    if(!pending)return;
    try {
      const reply=JSON.parse(line);
      if(!reply.ok){stop(fail('Cannot reach the serial console. Check COM1, VM power and WinRM.',502));return;}
      clearTimeout(pending.timer);pending.resolve(reply.value);pending=null;
    } catch {stop(fail('Invalid serial bridge response.',502));}
  });
  child.on('error',()=>stop(fail('Could not launch the console bridge.',502)));
  child.stdin.on('error',()=>stop());child.stderr.resume();child.on('close',()=>stop());
  const ready=exchange(Buffer.from(JSON.stringify({id,address:host.address,transport:host.transport||'winrm',
    credential:host.credential,userEnv:host.userEnv,passEnv:host.passEnv})).toString('base64'),18000);
  serialQueue=ready.catch(()=>{});
  function command(payload){
    if(queueDepth>=4)return Promise.reject(fail('Console busy. Wait for pending input.',429));
    queueDepth++;
    const reply=serialQueue.then(()=>exchange(JSON.stringify(payload),8000));
    serialQueue=reply.catch(()=>{}).finally(()=>{queueDepth--;});return reply;
  }
  return {ready,read:async()=>decoder.write(Buffer.from(await command({command:'read'}),'base64')),
    write:data=>command({command:'write',bytes:Buffer.from(data,'utf8').toString('base64')}),
    close:()=>{if(ended)return;child.stdin.end('{"command":"close"}\n');const t=setTimeout(()=>stop(),1500);t.unref();}};
}
