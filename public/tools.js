(async()=>{
  const me=await fetch('/api/me');if(!me.ok){location.href='/login';return;}
  document.querySelector('#user').textContent=(await me.json()).user.full_name;
  try{const response=await fetch('/api/tools');if(!response.ok)throw new Error('Unable to load tools.');
    for(const tool of await response.json()){
      if(!/^\/(?!\/)/.test(tool.path))continue;
      const a=document.createElement('a');a.className='tool-card';a.href=tool.path;
      const label=document.createElement('p');label.className='eyebrow';label.textContent=tool.label;
      const title=document.createElement('h2');title.textContent=tool.title;
      const description=document.createElement('p');description.textContent=tool.description;
      const open=document.createElement('strong');open.textContent='Open tool →';
      a.append(label,title,description,open);document.querySelector('#tools').append(a);
    }
  }catch(error){document.querySelector('#message').textContent=error.message;}
  document.querySelector('#logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login';};
})();
