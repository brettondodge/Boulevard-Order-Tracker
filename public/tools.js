(async()=>{
  const me=await fetch('/api/me');if(!me.ok){location.href='/login';return;}
  document.querySelector('#user').textContent=(await me.json()).user.full_name;
  // Phones (portrait or landscape) only get tools that work on a small screen.
  const phone=matchMedia('(max-width: 760px), (max-height: 500px) and (pointer: coarse)').matches;
  try{const response=await fetch('/api/tools');if(!response.ok)throw new Error('Unable to load tools.');
    const tools=await response.json();
    for(const tool of tools){
      if(!/^\/(?!\/)/.test(tool.path)||(phone&&tool.desktopOnly))continue;
      const a=document.createElement('a');a.className='tool-card';a.href=tool.path;
      const label=document.createElement('p');label.className='eyebrow';label.textContent=tool.label;
      const title=document.createElement('h2');title.textContent=tool.title;
      const description=document.createElement('p');description.textContent=tool.description;
      const open=document.createElement('strong');open.textContent='Open tool →';
      a.append(label,title,description,open);document.querySelector('#tools').append(a);
    }
    if(phone&&tools.some(tool=>tool.desktopOnly))document.querySelector('#message').textContent='Freeport Billing is available on a computer.';
  }catch(error){document.querySelector('#message').textContent=error.message;}
  document.querySelector('#logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login';};
})();
