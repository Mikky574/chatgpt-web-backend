const $=id=>document.getElementById(id);
const key='chatgpt-web-chat-v1';
let state;try{state=JSON.parse(localStorage.getItem(key));}catch{}
if(!state||!Array.isArray(state.chats))state={chats:[],selected:null};
if(!Array.isArray(state.projects)||!state.projects.length)state.projects=[{id:'default',name:'不使用官网项目（普通对话）'}];
state.projects.find(p=>p.id==='default')&&(state.projects.find(p=>p.id==='default').name='不使用官网项目（普通对话）');
for(const chat of state.chats)chat.projectId||='default';
state.projectId||=state.chats.find(c=>c.id===state.selected)?.projectId||state.projects[0].id;
const watching=new Set();
function save(){try{localStorage.setItem(key,JSON.stringify(state));}catch{$('notice').textContent='浏览器存储失败，刷新后可能丢失聊天记录。';}}
function current(){return state.chats.find(c=>c.id===state.selected);}
function create(){const chat={id:crypto.randomUUID(),projectId:state.projectId,title:'新任务',messages:[],reference:null,pending:null};state.chats.unshift(chat);state.selected=chat.id;save();render();$('input').focus();}
function render(){
 $('projects').replaceChildren();for(const project of state.projects){const option=document.createElement('option');option.value=project.id;option.textContent=project.name;$('projects').append(option);}$('projects').value=state.projectId;
 $('chats').replaceChildren();for(const chat of state.chats.filter(c=>c.projectId===state.projectId)){const b=document.createElement('button');b.className='chat'+(chat.id===state.selected?' selected':'');b.textContent=(chat.pending?'◷ ':'')+chat.title;b.onclick=()=>{const previous=current();if(previous)previous.draft=$('input').value;state.selected=chat.id;$('input').value=chat.draft||'';save();render();};$('chats').append(b);}
 const chat=current();if(!chat)return; $('title').textContent=chat.title;$('messages').replaceChildren();
 $('source').hidden=!/^https:\/\/chatgpt\.com\/(?:g\/g-p-[A-Za-z0-9-]+\/)?c\/[A-Za-z0-9-]+$/.test(chat.reference||'');if(!$('source').hidden)$('source').href=chat.reference;
 if(!chat.messages.length){const e=document.createElement('div');e.className='empty';e.textContent='发一条消息，开始体验主控后台。';$('messages').append(e);}
 for(const m of chat.messages){const e=document.createElement('div');e.className='message '+m.role;const label=document.createElement('div');label.className='label';label.textContent=m.role==='user'?'你':m.role==='notice'?'会话变更':'主控';const text=document.createElement('div');text.textContent=m.text;e.append(label,text);$('messages').append(e);}
 $('send').disabled=!!chat.pending;$('input').disabled=!!chat.pending;$('status').textContent=chat.status||'就绪';
 if(chat.pending&&!watching.has(chat.id)){const b=document.createElement('button');b.id='recover';b.textContent='恢复原请求';b.onclick=()=>recover(chat,'recover');$('status').append(b);if(chat.retry?.allowed){const retry=document.createElement('button');retry.textContent='重试本轮生成';retry.onclick=()=>recover(chat,'retry');$('status').append(retry);}if(chat.refresh?.allowed){const refresh=document.createElement('button');refresh.textContent='刷新官网并恢复';refresh.onclick=()=>recover(chat,'refresh');$('status').append(refresh);}}
 $('messages').scrollTop=$('messages').scrollHeight;
}
async function api(url,options){const r=await fetch(url,{...options,signal:AbortSignal.timeout(url==='/projects'?65000:12000)});const j=await r.json();if(!r.ok)throw Object.assign(new Error(j.error||'请求失败'),{data:j});return j;}
function update(chat){save();if(current()?.id===chat.id)render();}
async function recover(chat,operation){try{await api('/jobs/'+chat.pending.id+'/'+operation,{method:'POST'});chat.retry=null;await watch(chat);}catch(e){chat.status='恢复失败：'+e.message;update(chat);}}
async function watch(chat){
 if(watching.has(chat.id)||!chat.pending)return;watching.add(chat.id);render();
 try{while(chat.pending){const job=await api('/jobs/'+chat.pending.id);
   if(job.request_submitted===false){chat.pending=null;chat.status='本轮未发送：'+(job.error||'请求被拒绝')+'。可修改后再次发送。';chat.draft=job.question||'';if(chat.messages.at(-1)?.role==='user'&&chat.messages.at(-1)?.text===job.question)chat.messages.pop();if(current()?.id===chat.id)$('input').value=chat.draft;update(chat);break;}
   if(job.conversation_url)chat.reference=job.conversation_url;
   if(job.context_reset)chat.contextReset=job.context_reset;
   if(['queued','running'].includes(job.status)){const stages={locating_conversation:'定位网页会话',filling_composer:'填写输入框',submitting:'点击发送',submission_confirmed:'发送已确认',waiting_answer:'等待网页回答',reading_answer:'读取网页回答'};const status=job.status==='queued'?`排队中${job.queue_position?' · 等待位置 '+job.queue_position:''}`:(stages[job.stage]||'网页正在处理…');if(chat.status!==status){chat.status=status;update(chat);}await new Promise(r=>setTimeout(r,1500));continue;}
   if(['completed','awaiting_user_input'].includes(job.status)&&job.generation_complete){if(job.context_reset)chat.messages.push({role:'notice',text:'原对话不可访问，已新建对话。旧上下文未迁移，本轮只发送了当前问题。'});chat.messages.push({role:'assistant',text:job.answer});chat.pending=null;chat.status=job.user_action?.required?'网页已回复，可能需要你确认或补充':'已完成 · 来自 ChatGPT 网页';if(current()?.id===chat.id)setTimeout(()=>$('input').focus(),0);}
   else{chat.retry=job.retry;chat.refresh=job.refresh;chat.status=`${job.status==='interrupted'?'执行中断，结果不确定，请核对后处理':'网页尚未完成'} · ${job.error||job.status}。保留原请求，不自动重发。`;}
   update(chat);break;
 }}catch(e){chat.status='暂时无法读取结果：'+e.message+'。请重新查询原请求，不要重复发送。';update(chat);}
 finally{watching.delete(chat.id);update(chat);}
}
$('new').onclick=()=>{const chat=current();if(chat)chat.draft=$('input').value;$('input').value='';create();};
$('projects').onchange=()=>{const chat=current();if(chat)chat.draft=$('input').value;state.projectId=$('projects').value;state.selected=state.chats.find(c=>c.projectId===state.projectId)?.id;$('input').value=current()?.draft||'';if(!current())create();else{save();render();}};
$('project-form').onsubmit=async e=>{e.preventDefault();const name=$('project-name').value.trim();if(!name)return;const button=$('project-form').querySelector('button');button.disabled=true;try{const {project}=await api('/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});if(!state.projects.some(p=>p.id===project.id))state.projects.push(project);state.projectId=project.id;$('project-name').value='';$('input').value='';create();}catch(error){$('notice').textContent='创建官网项目未确认，请先刷新项目列表检查，勿重复创建。'+error.message;}finally{button.disabled=false;}};
$('refresh-projects').onclick=()=>loadProjects();
$('input').oninput=()=>{const chat=current();if(chat){chat.draft=$('input').value;save();}};
$('input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('form').requestSubmit();}};
$('form').onsubmit=async e=>{
 e.preventDefault();const chat=current(),text=$('input').value.trim();if(!chat||chat.pending||!text)return;
 if(new TextEncoder().encode(text).length>12000){chat.status='消息超过 12000 字节，请缩短后发送。';update(chat);return;}
 const id=crypto.randomUUID();chat.pending={id};chat.messages.push({role:'user',text});if(chat.messages.length===1)chat.title=text.slice(0,24);chat.status='正在提交…';chat.draft='';$('input').value='';update(chat);
 try{const project=state.projects.find(p=>p.id===chat.projectId);await api('/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:id,question:text,queue:true,project_id:chat.projectId,task_id:chat.id,project_name:project.name,...(project.url?{project_url:project.url}:{}),...(chat.reference?{conversation_url:chat.reference}:{})})});await watch(chat);}
 catch(error){if(error.data?.request_submitted===false||['invalid_request','wrong_provider_conversation_reference','invalid_queue_option','invalid_project_url','invalid_project_metadata','project_conversation_mismatch'].includes(error.data?.error)){chat.pending=null;chat.status='未提交：'+error.message+'，可重新发送。';chat.draft=text;if(current()?.id===chat.id)$('input').value=text;chat.messages.pop();}
 else chat.status='提交结果不确定，请查询原请求。'+error.message;update(chat);}
};
async function health(){try{const h=await api('/health');$('health').textContent=`${h.provider==='chatgpt-web'?'ChatGPT 网页通道':'非网页通道，请核对服务'} · 执行 ${h.active_jobs}/${h.max_concurrency} · 排队 ${h.queued_jobs||0}`;}catch{$('health').textContent='后台暂不可用';}}
if(!state.chats.length)create();else{if(!current())state.selected=state.chats[0].id;$('input').value=current().draft||'';render();}
for(const chat of state.chats)if(chat.pending)void watch(chat);
void health();setInterval(health,4000);
async function restoreHistory(){
 try{const {jobs}=await api('/history');const missing=new Set(jobs.filter(j=>!state.chats.some(c=>c.id===j.task_id)).map(j=>j.task_id));
 for(const taskId of missing){const turns=jobs.filter(j=>j.task_id===taskId),last=turns.at(-1);if(!state.projects.some(p=>p.id===last.project_id))state.projects.push({id:last.project_id,name:last.project_name,url:last.project_url});
 const chat={id:taskId,projectId:last.project_id,title:turns[0].question.slice(0,24),messages:[],reference:last.conversation_url,pending:null,status:'已从本机历史恢复'};
 for(const j of turns){chat.messages.push({role:'user',text:j.question});if(j.context_reset)chat.messages.push({role:'notice',text:'该轮已重建官网对话，旧上下文未迁移。'});if(j.answer)chat.messages.push({role:'assistant',text:j.answer});}
 if(!last.generation_complete&&last.request_submitted!==false)chat.pending={id:last.request_id};if(last.request_submitted===false)chat.status='上一轮未发送，可重新提问';state.chats.push(chat);if(chat.pending)void watch(chat);
 }save();render();}catch{$('notice').textContent='历史暂未同步，当前浏览器记录仍保留。';const retry=document.createElement('button');retry.textContent='重试加载历史';retry.onclick=()=>restoreHistory();$('notice').append(retry);}
}
void restoreHistory();
async function loadProjects(){try{const {projects}=await api('/projects');for(const project of projects){const old=state.projects.find(p=>p.id===project.id);if(old)Object.assign(old,project);else state.projects.push(project);}save();render();}catch{$('notice').textContent='官网项目列表暂不可用，普通对话仍可使用。';}}
void loadProjects();
