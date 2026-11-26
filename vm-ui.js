import {graphicalConsole} from './console-ui.js';

function el(tag,text,attrs={}) {
  const e=document.createElement(tag);
  if(text!==null&&text!==undefined)e.textContent=text;
  Object.assign(e,attrs);return e;
}
function wrap(tag,...children){const e=el(tag);e.append(...children);return e;}
function field(label,input){return wrap('label',el('span',label),input);}
function section(title,...children){const d=el('details');d.append(el('summary',title),...children);return d;}
function table(head,rows) {
  const t=el('table');
  t.append(wrap('thead',wrap('tr',...head.map(h=>el('th',h)))));
  const body=el('tbody');
  for(const cells of rows)body.append(wrap('tr',...cells.map(c=>{const td=el('td');td.append(c instanceof Node?c:String(c??'—'));return td;})));
  if(!rows.length){const td=el('td','None');td.colSpan=head.length;body.append(wrap('tr',td));}
  t.append(body);return wrap('div',t);
}
function numeric(value,min,max){return el('input',null,{type:'number',value,min,max,step:1,required:true});}
function select(value,choices){const s=el('select');s.append(...choices.map(x=>el('option',x,{value:x})));s.value=value;return s;}
function binaryGB(v){return v==null?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:3})+' GiB';}
function age(ts){if(!ts)return 'Unknown';const hrs=Math.max(0,Math.floor((Date.now()-new Date(ts))/3600000));return hrs<24?hrs+' h':Math.floor(hrs/24)+' d';}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function mountVMPanel(container,{host,name,user,api,refresh}) {
  const pane=el('article',null,{className:'hv-vm-panel'});
  const title=el('h2',name),subtitle=el('p',host),notice=el('p','Loading VM…',{role:'status'}),body=el('div');
  pane.append(title,subtitle,notice,body);container.replaceChildren(pane);
  let disposed=false,busy=false,consoleSession=null,serialTimer=null,version=0,screenConsole=null;
  async function disconnect(){
    const id=consoleSession;consoleSession=null;clearTimeout(serialTimer);
    if(id)await api('/api/console/close',{id}).catch(()=>{});
  }
  async function load(){
    const seq=++version;
    let vm;
    try{vm=await api('/api/vm?'+new URLSearchParams({host,name}));}catch(e){if(!disposed&&version===seq)notice.textContent=e.message;return;}
    if(disposed||seq!==version)return;
    const admin=user.role==='admin',ops=admin||user.role==='operator';
    screenConsole?.dispose();
    body.replaceChildren();notice.textContent='';
    subtitle.textContent=[host,vm.state,vm.protected?'Protected':'',vm.managed?'Dashboard managed':'Externally managed'].filter(Boolean).join(' · ');
    const makeButton=(label,fn,disabled=false)=>{const b=el('button',label,{type:'button',disabled});b.onclick=async()=>{
      if(busy||disposed)return;try{await fn();}catch(e){if(!disposed)notice.textContent=e.message;}
    };return b;};
    async function act(action,extra={},warning){
      const payload={host,name:vm.name,id:vm.id,action,...extra};
      if(warning){
        const answer=prompt(warning+'\n\nType the exact VM name to continue: '+vm.name);
        if(answer===null)return;
        if(answer!==vm.name)throw Error('The VM name did not match.');
        payload.confirm=answer;
      }
      busy=true;
      try{
        const result=await api('/api/vm',payload);
        if(result.job){
          notice.textContent='Job '+result.job+' is running…';
          // Refresh the detail once the recorded host job has completed.
          while(!disposed){
            const job=await api('/api/job?id='+encodeURIComponent(result.job));
            if(job.status!=='running'){
              if(job.status!=='done')throw Error(job.log?.at(-1)||job.status);
              break;
            }
            await sleep(850);
          }
        }
        if(disposed)return;
        if(action==='delete'){body.replaceChildren();notice.textContent='VM and listed disks deleted.';}
        else {await load();notice.textContent='Saved.';}
        refresh?.();
      }finally{busy=false;}
    }
    const facts=table(['Property','Value'],[
      ['VM ID',vm.id],['Generation',vm.generation],['Created',vm.created?new Date(vm.created).toLocaleString():'Unknown'],
      ['Creator',vm.creator||'Unknown'],['vCPUs',vm.vcpu],['Assigned RAM',vm.memMB+' MiB'],
      ['Startup RAM',vm.startupMB+' MiB'],['Memory policy',vm.dynamic?'Dynamic · '+vm.minMB+'–'+vm.maxMB+' MiB':'Static'],
      ['Automatic start / stop',vm.autoStart+' / '+vm.autoStop],['Notes',vm.notes||'—'],['Tags',(vm.tags||[]).join(', ')||'—']
    ]);
    const power=el('div',null,{className:'vm-actions'});
    function powerButton(label,action,warning){power.append(makeButton(label,()=>act(action,{},warning),vm.protected&&action!=='start'&&action!=='resume'));}
    if(ops){
      if(vm.state==='Off'||vm.state==='Saved')powerButton('Start','start');
      if(vm.state==='Paused')powerButton('Resume','resume');
      if(vm.state==='Running'){
        powerButton('Shut down','stop','Shut down the guest operating system.');
        powerButton('Restart','restart','Restart this VM. Unsaved guest data may be lost.');
        powerButton('Pause','pause','Suspend execution of this VM.');
      }
      if(['Running','Paused'].includes(vm.state))powerButton('Save state','save','Save current memory and stop this VM.');
      if(vm.state!=='Off')powerButton('Power off','off','Cut power to this VM. Unsaved guest data will be lost.');
    }
    if(admin){
      power.append(makeButton(vm.protected?'Lift protection':'Protect VM',()=>act(vm.protected?'unprotect':'protect',{},vm.protected?'Allow disruptive actions on this VM.':null)));
      if(vm.managed)power.append(makeButton('Delete VM and disks',()=>act('delete',{confirmFiles:vm.ownedFiles},'Permanently delete VM '+vm.name+' and these disk files:\n'+vm.ownedFiles.join('\n')),vm.protected||vm.state!=='Off'||vm.checkpoints.length>0));
    }
    body.append(power);
    if(admin){screenConsole=graphicalConsole(vm,host,api);body.append(screenConsole.element);}
    body.append(section('Hardware and ownership',facts));
    body.append(section('Storage ('+vm.disks.length+')',table(['Disk path','Type','Provisioned','On disk'],vm.disks.map(d=>[d.path,d.type,binaryGB(d.sizeGB),binaryGB(d.fileGB)]))));
    body.append(section('Network adapters ('+vm.adapters.length+')',table(['Adapter','Switch','MAC','IP addresses'],vm.adapters.map(a=>[a.name,a.switch,a.mac,(a.ips||[]).join(', ')]))));
    const cps=vm.checkpoints.map(c=>{
      const buttons=el('div');
      for(const action of ['restore','delete'])if(admin)buttons.append(makeButton(action==='restore'?'Apply':'Delete',async()=>{
        const warning=action==='restore'?'Applying this checkpoint replaces the current guest state.':'Delete this checkpoint and merge its disk changes.';
        const cp=prompt(warning+'\nType the checkpoint name: '+c.name);
        if(cp===null)return;if(cp!==c.name)throw Error('Checkpoint name did not match.');
        await act('checkpoint-'+action,{checkpointId:c.id,confirmCheckpoint:cp},warning+'\nCheckpoint: '+c.name);
      },vm.protected));
      return [c.name,age(c.created),c.created?new Date(c.created).toLocaleString():'—',binaryGB(c.sizeGB),buttons];
    });
    const snapshots=section('Checkpoints ('+cps.length+')',table(['Checkpoint','Age','Created','Size¹',''],cps));
    if(cps.length)snapshots.append(el('small','¹ Configuration, saved state and attached checkpoint differencing files. Shared parent disks are excluded.'));
    if(admin)snapshots.append(makeButton('Create checkpoint',async()=>{const n=prompt('Checkpoint name');if(n!==null)await act('checkpoint-create',{checkpointName:n});}));
    body.append(snapshots);
    if(admin){
      const f=el('form',null,{className:'vm-edit'});
      const ins={vcpu:numeric(vm.vcpu,1,2048),startupMB:numeric(vm.startupMB,32,12582912),dynamic:el('input',null,{type:'checkbox',checked:vm.dynamic}),
        minMB:numeric(vm.minMB||vm.startupMB,32,12582912),maxMB:numeric(vm.maxMB||vm.startupMB,32,12582912),
        autoStart:select(vm.autoStart,['Nothing','Start','StartIfRunning']),autoStop:select(vm.autoStop,['Save','ShutDown','TurnOff']),
        notes:el('textarea',null,{value:vm.notes||'',maxLength:1024}),tags:el('input',null,{value:(vm.tags||[]).join(', ')})};
      const labels={vcpu:'Virtual CPUs',startupMB:'Startup RAM (MiB)',dynamic:'Dynamic memory',minMB:'Minimum RAM (MiB)',maxMB:'Maximum RAM (MiB)',
        autoStart:'Automatic start',autoStop:'Automatic stop',notes:'Notes',tags:'Tags (comma separated)'};
      for(const [k,i] of Object.entries(ins))f.append(field(labels[k],i));
      const adjust=()=>{ins.minMB.disabled=!ins.dynamic.checked;ins.maxMB.disabled=!ins.dynamic.checked;};adjust();ins.dynamic.onchange=adjust;
      f.append(el('button','Apply changes',{type:'submit',disabled:vm.state!=='Off'||vm.protected}));
      if(vm.state!=='Off')f.append(el('small','Shut down the VM before applying hardware changes.'));
      f.onsubmit=async e=>{e.preventDefault();if(busy)return;const values=Object.fromEntries(Object.entries(ins).map(([k,i])=>[k,i.type==='number'?Number(i.value):i.type==='checkbox'?i.checked:i.value]));
        values.tags=values.tags.split(',').map(x=>x.trim()).filter(Boolean);
        try{await act('edit',values);}catch(err){notice.textContent=err.message;}};
      body.append(section('Edit VM',f));
      const sc=section('Serial console');body.append(sc);
      if(!vm.consolePipe){
        sc.append(el('p','Configure COM1 while the VM is off. The guest must have a serial login on ttyS0.'),
          makeButton('Configure COM1',()=>act('console-configure',{},'Assign a dedicated Hyper-V named pipe to COM1.'),vm.hasOtherConsole||vm.state!=='Off'||vm.protected));
      } else {
        const term=el('pre','',{tabIndex:0,ariaLabel:'Serial terminal'});
        const state=el('small','Connect and focus the terminal. Press Enter for a prompt.');
        let text='',keypress=Promise.resolve();
        const send=data=>{const id=consoleSession;if(!id)return;keypress=keypress.then(async()=>{if(id===consoleSession)await api('/api/console/write',{id,data});}).catch(e=>{state.textContent=e.message;});};
        term.onkeydown=e=>{
          if(!consoleSession||e.metaKey||e.altKey)return;
          const keys={Enter:'\r',Backspace:'\x7f',Tab:'\t',Escape:'\x1b',ArrowUp:'\x1b[A',ArrowDown:'\x1b[B',ArrowRight:'\x1b[C',ArrowLeft:'\x1b[D'};
          let data=keys[e.key]||(e.key.length===1?e.key:null);
          if(e.ctrlKey && e.key.length===1)data=String.fromCharCode(e.key.toUpperCase().charCodeAt(0)&31);
          if(data){e.preventDefault();send(data);}
        };
        term.onpaste=e=>{if(consoleSession){e.preventDefault();send(e.clipboardData.getData('text/plain').slice(0,1000));}};
        const closeButton=makeButton('Disconnect',async()=>{await disconnect();state.textContent='Disconnected.';connect.disabled=false;closeButton.disabled=true;},true);
        const connect=makeButton('Connect',async()=>{
          connect.disabled=true;let id;
          try{
            const opened=await api('/api/console/open',{host,name,id:vm.id});id=opened.id;
            if(disposed){await api('/api/console/close',{id});return;}
            consoleSession=id;closeButton.disabled=false;term.focus();state.textContent='Connected. Input is sent directly to COM1.';
            const poll=async()=>{
              if(disposed||consoleSession!==id)return;
              try{
                const reply=await api('/api/console/read?id='+encodeURIComponent(id));
                if(consoleSession!==id)return;
                // A text console supports shells, login, Ctrl+C, TAB and arrows.
                // Render received text only; do not echo typed passwords locally.
                text=(text+reply.text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[^\n]\x08/g,'').replace(/\r\n/g,'\n').slice(-32768);
                term.textContent=text;term.scrollTop=term.scrollHeight;serialTimer=setTimeout(poll,350);
              }catch(e){state.textContent=e.message;await disconnect();connect.disabled=false;closeButton.disabled=true;}
            };
            await poll();
          }catch(e){connect.disabled=false;throw e;}
        },vm.state!=='Running'||vm.protected);
        sc.append(wrap('div',connect,closeButton),state,term);
      }
    }
  }
  await load();
  return ()=>{disposed=true;version++;screenConsole?.dispose();void disconnect();};
}
