import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {root,fail} from './store.mjs';

function openBridge(host,id,mode) {
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',path.join(root,'console-bridge.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const reader=createInterface({input:child.stdout});
  const decoder=new StringDecoder('utf8');
  let pending=null,ended=false,queue=Promise.resolve(),queueDepth=0,killTimer;
  const exited=new Promise(resolve=>child.once('close',resolve));
  function stop(error=fail('Console closed.',410)) {
    if (ended) return;
    ended=true;
    if (pending) {clearTimeout(pending.timer);pending.reject(error);pending=null;}
    // EOF lets the host release pressed devices before the helper exits.
    if(!child.stdin.writableEnded && !child.stdin.destroyed)child.stdin.end();
    if(child.exitCode===null && child.signalCode===null){
      killTimer=setTimeout(()=>child.kill(),5000);
      killTimer.unref();
    }
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
      if(!reply.ok){stop(fail(mode==='screen'?'Hyper-V display or input is unavailable. Check VM power, host permissions and the remoting connection.':'Cannot reach the serial console. Check COM1, VM power and WinRM.',502));return;}
      clearTimeout(pending.timer);pending.resolve(reply.value);pending=null;
    } catch {stop(fail('Invalid console bridge response.',502));}
  });
  child.on('error',()=>stop(fail('Could not launch the console bridge.',502)));
  child.stdin.on('error',()=>stop());child.stderr.resume();
  child.once('close',()=>{stop();clearTimeout(killTimer);});
  const ready=exchange(Buffer.from(JSON.stringify({id,mode,address:host.address,transport:host.transport||'winrm',
    credential:host.credential,userEnv:host.userEnv,passEnv:host.passEnv})).toString('base64'),18000);
  queue=ready.catch(()=>{});
  function command(payload){
    if(queueDepth>=4)return Promise.reject(fail('Console busy. Wait for pending input.',429));
    queueDepth++;
    const reply=queue.then(()=>exchange(JSON.stringify(payload),8000));
    queue=reply.catch(()=>{}).finally(()=>{queueDepth--;});return reply;
  }
  return {ready,read:async()=>{
    const value=await command({command:'read'});
    return mode==='screen'?value:decoder.write(Buffer.from(value,'base64'));
  },write:data=>command(mode==='screen'?{command:'input',events:data}:{command:'write',bytes:Buffer.from(data,'utf8').toString('base64')}),
    close:()=>{stop();return exited;}};
}

export function openSerial(host,id) {
  if(process.env.HVDASH_FAKE!=='1')return openBridge(host,id,'serial');
  let output='Fake serial console connected.\r\n';
  return {ready:Promise.resolve(),read:async()=>{const text=output;output='';return text;},
    write:async data=>{output=(output+data).slice(-32768);},close:()=>{}};
}

export function openScreen(host,id) {
  if(process.env.HVDASH_FAKE!=='1')return openBridge(host,id,'screen');
  const image=readFileSync(path.join(root,'fake-console.png')).toString('base64');
  return {ready:Promise.resolve(),read:async()=>image,write:async()=>{},close:()=>{}};
}
