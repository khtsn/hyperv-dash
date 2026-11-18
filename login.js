if(new URLSearchParams(location.search).get('changed')==='1'){
 document.querySelector('main > p').textContent='Password changed. Sign in with your new password.';
}
document.querySelector('form').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
 try{const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
 if(!res.ok)throw Error((await res.json()).error||'Sign-in failed');location.replace('/');}
 catch(e){document.querySelector('#error').textContent=e.message;}finally{button.disabled=false;}
});
