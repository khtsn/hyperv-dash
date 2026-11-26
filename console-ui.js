// One graphical session, bound to the VM details panel that opened it.
export function graphicalConsole(vm, host, api) {
  const element = document.createElement('section');
  element.className = 'graphical-console';
  const button = (label, action) => {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.onclick = action;
    return control;
  };
  const connect = button('Open graphical console', open);
  connect.disabled = vm.state !== 'Running' || vm.protected;
  if (connect.disabled) connect.title = vm.protected ? 'Lift VM protection to connect.' : 'Start the VM to connect.';
  const viewer = document.createElement('div');
  viewer.className = 'screen-viewer';
  viewer.hidden = true;
  const screen = document.createElement('canvas');
  screen.width = 800;
  screen.height = 600;
  screen.tabIndex = 0;
  screen.setAttribute('role', 'application');
  screen.setAttribute('aria-label', 'Interactive screen of '+vm.name);
  const tools = document.createElement('div');
  tools.className = 'vm-actions';
  const disconnect = button('Disconnect', () => {stop('Disconnected.');connect.focus();});
  tools.append(button('Send Ctrl+Alt+Delete', () => {enqueue({type:'cad'});screen.focus();}), disconnect);
  if (document.fullscreenEnabled) tools.append(button('Full screen', async () => {
    try {
      if (document.fullscreenElement === viewer) await document.exitFullscreen();
      else await viewer.requestFullscreen();
      screen.focus();
    } catch { status.textContent = 'Full screen is unavailable in this browser.'; }
  }));
  const hint = document.createElement('small');
  hint.textContent = 'Click the screen to type. Ctrl+Alt+Left returns focus to the console controls.';
  const status = document.createElement('small');
  status.setAttribute('role','status');
  viewer.append(tools, screen, hint);
  element.append(connect, status, viewer);
  const context = screen.getContext('2d');
  let session = null, generation = 0, disposed = false, pollTimer, inputTimer, sending = false;
  let events = [];

  function stop(message) {
    generation++;
    const id = session;
    session = null;
    events = [];
    sending = false;
    clearTimeout(inputTimer);
    inputTimer=undefined;
    clearTimeout(pollTimer);
    if (document.fullscreenElement === viewer) document.exitFullscreen().catch(()=>{});
    viewer.hidden = true;
    context.clearRect(0,0,screen.width,screen.height);
    connect.hidden = false;
    connect.disabled = false;
    status.textContent = message;
    if (id) void api('/api/console/close',{id}).catch(()=>{});
  }
  async function open() {
    const token = ++generation;
    connect.disabled = true;
    status.textContent = 'Connecting…';
    try {
      const {id} = await api('/api/console/screen/open',{host,name:vm.name,id:vm.id});
      if (disposed || token !== generation) { await api('/api/console/close',{id}); return; }
      session = id;
      viewer.hidden = false;
      connect.hidden = true;
      status.textContent = 'Waiting for the guest display…';
      screen.focus();
      await frame(id);
    } catch (e) { if (!disposed && token === generation) stop(e.message); }
  }
  async function frame(id) {
    try {
      const result = await api('/api/console/read?id='+encodeURIComponent(id));
      if (session !== id) return;
      if (result.image) {
        const bytes = Uint8Array.from(atob(result.image), ch => ch.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes],{type:bytes[0]===0x89?'image/png':'image/jpeg'}));
        try {
          if (session !== id) return;
          if (screen.width !== bitmap.width || screen.height !== bitmap.height) {
            screen.width = bitmap.width;
            screen.height = bitmap.height;
          }
          context.drawImage(bitmap,0,0);
          status.textContent = 'Connected';
        } finally { bitmap.close(); }
      }
      if (id === session) pollTimer = setTimeout(()=>frame(id),180);
    } catch (e) { if (session === id) stop(e.message); }
  }
  function enqueue(event) {
    if (!session) return;
    if (event.type==='move' && events.at(-1)?.type==='move') events[events.length-1]=event;
    else events.push(event);
    if (events.length>256) { stop('Input is delayed. Reconnect to the console.'); return; }
    if (!sending && inputTimer===undefined) inputTimer=setTimeout(flush,20);
  }
  async function flush() {
    inputTimer=undefined;
    if (sending || !session || !events.length) return;
    const id=session;
    sending=true;
    try {
      while(session===id && events.length) await api('/api/console/write',{id,events:events.splice(0,64)});
    } catch(e){ if(session===id) stop(e.message); }
    finally { if(session===id) sending=false; }
  }
  const sidedKeys = {ShiftLeft:160,ShiftRight:161,ControlLeft:162,ControlRight:163,
    AltLeft:164,AltRight:165,MetaLeft:91,MetaRight:92};
  function key(e) {
    if(!session) return;
    if(e.ctrlKey && e.altKey && e.code==='ArrowLeft'){
      e.preventDefault(); disconnect.focus(); return;
    }
    const value=sidedKeys[e.code] || e.keyCode;
    if(value<8 || value>254 || value===229) return;
    e.preventDefault();
    e.stopPropagation();
    if(!e.repeat) enqueue({type:'key',key:value,down:e.type==='keydown'});
  }
  screen.onkeydown=screen.onkeyup=key;
  screen.onblur=()=>enqueue({type:'release'});
  function move(e) {
    const box=screen.getBoundingClientRect();
    const normalize=n=>Math.round(65535*Math.max(0,Math.min(1,n)));
    enqueue({type:'move',x:normalize((e.clientX-box.left)/box.width),y:normalize((e.clientY-box.top)/box.height)});
  }
  screen.onpointermove=e=>{if(e.isPrimary)move(e);};
  const mouseButtons=[1,3,2]; // DOM left/middle/right to Hyper-V left/right/middle.
  function pointer(e) {
    if(!e.isPrimary || !mouseButtons[e.button] || !session)return;
    e.preventDefault();
    const down=e.type==='pointerdown';
    if(down){screen.focus();screen.setPointerCapture(e.pointerId);}
    move(e);
    enqueue({type:'button',button:mouseButtons[e.button],down});
  }
  screen.onpointerdown=screen.onpointerup=pointer;
  screen.onpointercancel=()=>enqueue({type:'release'});
  screen.oncontextmenu=e=>e.preventDefault();
  screen.addEventListener('wheel',e=>{
    if(!session || !e.deltaY)return;
    e.preventDefault();move(e);enqueue({type:'wheel',delta:e.deltaY<0?120:-120});
  },{passive:false});
  const release=()=>enqueue({type:'release'});
  const leave=()=>{if(session || (connect.disabled && !vm.protected && vm.state==='Running')) stop('Disconnected.');};
  const hide=()=>{if(document.hidden)leave();};
  window.addEventListener('blur',release);
  window.addEventListener('pagehide',leave);
  document.addEventListener('visibilitychange',hide);
  return {element,dispose(){
    disposed=true;
    stop('');
    window.removeEventListener('blur',release);
    window.removeEventListener('pagehide',leave);
    document.removeEventListener('visibilitychange',hide);
  }};
}
