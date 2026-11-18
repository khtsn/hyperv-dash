import {randomUUID} from 'node:crypto';
import {db,audit,stamp,fail} from './store.mjs';
export function recoverJobs(){db.prepare("UPDATE jobs SET status='interrupted',ended=? WHERE status='running'").run(stamp());}
export const decodeJob=r=>r&&({...r,log:JSON.parse(r.log)});
export function startJob(actor,host,name,op,work){
 const id=randomUUID();
 try{db.prepare("INSERT INTO jobs(id,actor,host,name,op,started,status) VALUES(?,?,?,?,?,?,'running')").run(id,actor,host,name,op,stamp());}
 catch(e){if(e.message.includes('UNIQUE'))throw fail('An operation on this VM is already running.',409);throw e;}
 audit(actor,op,host+'/'+name,'started');
 const log=[stamp()+' Queued'];
 const step=message=>{log.push(stamp()+' '+message);db.prepare('UPDATE jobs SET log=? WHERE id=?').run(JSON.stringify(log.slice(-200)),id);};
 const finish=(status,msg)=>{step(msg);db.prepare('UPDATE jobs SET status=?,ended=? WHERE id=?').run(status,stamp(),id);audit(actor,op,host+'/'+name,status);};
 Promise.resolve().then(()=>work(step)).then(()=>finish('done','Completed'),e=>finish('failed',e.message||'Operation failed'));
 return {job:id};
}
