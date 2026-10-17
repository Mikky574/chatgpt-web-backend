import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {conversationUrl,projectUrl,projectForConversation} from './conversation-url.mjs';
import {withGuidance} from './error-guidance.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(id);

export async function createJobService({directory=root,runner,maxConcurrency=1,maxQueue=32,projects}={}) {
  if(typeof runner!=='function')throw new Error('Web runner required');
  const provider='chatgpt-web';
  const parseRef=conversationUrl;
  const toRef=id=>id;
  const store=path.join(directory,'records','web-jobs'),workspace=path.join(store,'workspace');await mkdir(workspace,{recursive:true});
  const active=new Map(),sessionLocks=new Map(),listeners=new Map(),queue=new Map();
  let admission=Promise.resolve();
  let projectBusy=false;
  function schedule(){
    if(projectBusy)return;
    for(const [id,job] of queue){
      if(active.size>=maxConcurrency)break;
      if(job.requested_session_id&&sessionLocks.has(job.requested_session_id))continue;
      queue.delete(id);job.status='running';job.generation_status='generating';active.set(id,job);
      if(job.requested_session_id)sessionLocks.set(job.requested_session_id,id);
      void execute(job).catch(()=>{});
    }
  }
  const file=id=>path.join(store,id+'.json');
  const save=async job=>{const temp=file(job.request_id)+'.tmp';await writeFile(temp,JSON.stringify(job,null,2));await rename(temp,file(job.request_id));};
  const read=async id=>{try{return JSON.parse(await readFile(file(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  for(const name of await readdir(store)) {
    if(!name.endsWith('.json'))continue;const job=await read(name.slice(0,-5));
    if(job?.status==='running'||job?.status==='queued'){job.status='interrupted';job.error='SERVICE_RESTART_RESULT_UNCERTAIN';await save(job);}
  }
  function notify(job,event){for(const response of listeners.get(job.request_id)||[])response.write(`data: ${JSON.stringify(event)}\n\n`);}
  async function execute(job) {
    let writes=Promise.resolve();
    const persist=()=>{const snapshot=structuredClone(job);writes=writes.then(()=>save(snapshot));void writes.catch(()=>{});return writes;};
    const emit=event=>{job.events.push(event);if(event.type==='session.started'){job.session_id=event.session_id;job.conversation_url=toRef(event.session_id);sessionLocks.set(event.session_id,job.request_id);}if(event.type==='answer.available')job.answer=event.text;if(event.type==='progress')job.stage=event.stage;notify(job,event);persist();};
    try {
      const result=await runner({requestId:job.request_id,question:job.question,sessionId:job.requested_session_id,projectUrl:job.project_url,workspace,onEvent:emit,operation:job.operation||'ask'});
      if(result.session_id){job.session_id=result.session_id;job.conversation_url=toRef(result.session_id);}job.answer=result.answer||'';job.usage=result.usage;
      job.generation_complete=result.generation_complete===true;job.status=result.status||(job.generation_complete?'completed':'interrupted');job.generation_status=result.generation_status||(job.generation_complete?'completed':'unknown');
      if(job.status==='completed'&&!job.generation_complete){job.status='interrupted';job.error='INCOMPLETE_WEB_RESULT';}
      for(const key of ['user_action','retry','refresh','files','error','stage','submission_confirmed','network','context_reset','request_submitted','guidance','blocking_request_id','pending','recovery','composer_diagnostics'])if(result[key]!==undefined)job[key]=result[key];
      if(job.generation_complete){delete job.retry;delete job.refresh;delete job.error;}
    }catch(e){job.status=/TIMEOUT|INCOMPLETE|UNCERTAIN/.test(e.message)?'interrupted':'failed';job.error=/^[A-Z_]+$/.test(e.message)?e.message:'EXECUTION_FAILED';job.generation_status='blocked';if(e.result?.error)job.backend_error=e.result.error;}
    finally{
      job.updated_at=new Date().toISOString();const event={type:job.status,request_id:job.request_id,generation_complete:job.generation_complete};job.events.push(event);notify(job,event);
      try{await persist();}finally{active.delete(job.request_id);if(job.session_id&&sessionLocks.get(job.session_id)===job.request_id)sessionLocks.delete(job.session_id);if(job.requested_session_id&&sessionLocks.get(job.requested_session_id)===job.request_id)sessionLocks.delete(job.requested_session_id);for(const response of listeners.get(job.request_id)||[])response.end();listeners.delete(job.request_id);schedule();}
    }
  }
  const server=http.createServer(async(req,res)=>{
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(withGuidance(value,{port:8789})));};
    if((req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)||req.headers['sec-fetch-site']==='cross-site'||!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host||''))return send(403,{error:'loopback_program_calls_only'});
    let unlock;
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/projects'&&projects){
        if(req.method==='GET')return send(200,await projects());
        if(req.method==='POST'){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1024)return send(413,{error:'body_too_large'});}let input;try{input=JSON.parse(text);}catch{return send(400,{error:'invalid_json'});}if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80)return send(400,{error:'invalid_project_name'});if(projectBusy||active.size||queue.size)return send(409,{error:'browser_busy',request_submitted:false});projectBusy=true;try{return send(200,await projects(input.name));}finally{projectBusy=false;schedule();}}
      }
      if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"});res.end(await readFile(path.join(root,'ui','index.html')));return;}
      if(req.method==='GET'&&url.pathname==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(await readFile(path.join(root,'ui','app.js')));return;}
      if(req.method==='GET'&&url.pathname==='/health')return send(200,{service:'chatgpt-web-controller',provider,cdp_required:true,active_jobs:active.size,queued_jobs:queue.size,max_concurrency:maxConcurrency,max_queue:maxQueue});
      if(req.method==='GET'&&url.pathname==='/history'){
        const jobs=[];for(const name of await readdir(store)){if(!name.endsWith('.json'))continue;const job=await read(name.slice(0,-5));if(job?.project_id&&job?.task_id)jobs.push(job);}
        jobs.sort((a,b)=>a.created_at.localeCompare(b.created_at));return send(200,{jobs:jobs.slice(-500)});
      }
      const match=url.pathname.match(/^\/jobs\/([A-Za-z0-9_-]{1,80})(\/events)?$/);
      if(req.method==='GET'&&match){
        const inFlight=active.get(match[1]);
        const waiting=queue.get(match[1]);
        const job=inFlight?{...inFlight,status:'running',generation_complete:false}:waiting?{...waiting,queue_position:[...queue.keys()].indexOf(match[1])+1}:await read(match[1]);if(!job)return send(404,{error:'job_not_found'});
        if(!match[2])return send(200,job);
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.flushHeaders();
        for(const event of job.events)res.write(`data: ${JSON.stringify(event)}\n\n`);
        if(!['running','queued'].includes(job.status)){res.end();return;}
        if(!listeners.has(job.request_id))listeners.set(job.request_id,new Set());listeners.get(job.request_id).add(res);
        const timer=setInterval(()=>res.write(': heartbeat\n\n'),10000);
        res.on('close',()=>{clearInterval(timer);listeners.get(job.request_id)?.delete(res);});return;
      }
      const recovery=url.pathname.match(/^\/jobs\/([A-Za-z0-9_-]{1,80})\/(recover|retry|refresh)$/);
      if(req.method==='POST'&&recovery){
        const previous=admission;admission=new Promise(resolve=>{unlock=resolve;});await previous;
        if(active.has(recovery[1])||queue.has(recovery[1]))return send(202,{request_id:recovery[1],status:'running'});
        const job=await read(recovery[1]);if(!job)return send(404,{error:'job_not_found'});
        if(job.generation_complete)return send(200,job);
        if(queue.size>=maxQueue)return send(429,{error:'queue_full',request_submitted:false});
        if(recovery[2]==='retry'&&!job.retry?.allowed)return send(409,{error:'retry_not_allowed',request_submitted:false});
        job.operation=recovery[2];job.status='queued';job.generation_status='queued';delete job.error;
        await save(job);queue.set(job.request_id,job);schedule();return send(202,job);
      }
      if(req.method!=='POST'||url.pathname!=='/jobs')return send(404,{error:'not_found'});
      if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'json_required'});
      let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>65536)return send(413,{error:'body_too_large'});}
      let input;try{input=JSON.parse(text);}catch{return send(400,{error:'invalid_json'});}
      if(!input||!validId(input.request_id)||typeof input.question!=='string'||!input.question.trim()||Buffer.byteLength(input.question)>12000)return send(400,{error:'invalid_request'});
      const sessionId=input.conversation_url?parseRef(input.conversation_url):null;
      if(input.conversation_url&&!sessionId)return send(400,{error:'wrong_provider_conversation_reference'});
      if(input.project_url&&!projectUrl(input.project_url))return send(400,{error:'invalid_project_url'});
      if(input.project_url&&sessionId&&projectForConversation(sessionId)!==projectUrl(input.project_url))return send(400,{error:'project_conversation_mismatch'});
      if(input.queue!==undefined&&typeof input.queue!=='boolean')return send(400,{error:'invalid_queue_option'});
      if((input.project_id!==undefined||input.task_id!==undefined)&&(!validId(input.project_id)||!validId(input.task_id)||typeof input.project_name!=='string'||!input.project_name.trim()||input.project_name.length>80))return send(400,{error:'invalid_project_metadata'});
      const previous=admission;admission=new Promise(resolve=>{unlock=resolve;});await previous;
      const old=active.get(input.request_id)||queue.get(input.request_id)||await read(input.request_id);
      if(old){if(old.question!==input.question||old.requested_session_id!==sessionId||old.project_id!==input.project_id||old.task_id!==input.task_id||(old.project_url||null)!==(projectUrl(input.project_url)||projectForConversation(sessionId)||null))return send(409,{error:'request_id_conflict'});return send(active.has(input.request_id)||queue.has(input.request_id)?202:200,active.has(input.request_id)?{...old,status:'running',generation_complete:false}:old);}
      const busy=sessionId&&(sessionLocks.has(sessionId)||[...queue.values()].some(j=>j.requested_session_id===sessionId));
      if(busy&&!input.queue)return send(409,{error:'session_busy',request_id:sessionLocks.get(sessionId),request_submitted:false});
      if((projectBusy||active.size>=maxConcurrency||queue.size)&&!input.queue)return send(429,{error:'web_capacity',retry_after_ms:1000,request_submitted:false});
      if(queue.size>=maxQueue)return send(429,{error:'queue_full',request_submitted:false});
      const job={request_id:input.request_id,provider,question:input.question,requested_session_id:sessionId,session_id:sessionId,conversation_url:input.conversation_url||null,status:'queued',generation_status:'queued',generation_complete:false,answer:'',events:[],created_at:new Date().toISOString()};
      if(input.project_id)Object.assign(job,{project_id:input.project_id,task_id:input.task_id,project_name:input.project_name.trim()});
      if(input.project_url)job.project_url=projectUrl(input.project_url);
      else if(sessionId&&projectForConversation(sessionId))job.project_url=projectForConversation(sessionId);
      await save(job);queue.set(job.request_id,job);schedule();send(202,{...job});
    }catch{if(!res.headersSent)send(500,{error:'web_service_error'});else res.end();}finally{unlock?.();}
  });
  return server;
}
