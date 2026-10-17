import {readFile} from 'node:fs/promises';
import {conversationUrl,projectUrl} from './conversation-url.mjs';
const [operation,id,summaryFile,reference]=process.argv.slice(2);
try{
 if(!['new','continue','recover','retry','refresh'].includes(operation)||!/^[A-Za-z0-9_-]{1,80}$/.test(id||''))throw Error('invalid_arguments');
 const backend=new URL(process.env.GPT_BACKEND||'http://127.0.0.1:8789');
 if(backend.protocol!=='http:'||backend.hostname!=='127.0.0.1')throw Error('loopback_required');
 let result;
 if(['new','continue'].includes(operation)){
  if(operation==='continue'&&!conversationUrl(reference))throw Error('web_conversation_required');
  const project=process.env.CONTROLLER_PROJECT_URL;if(project&&!projectUrl(project))throw Error('invalid_project_url');
  const task=process.env.CONTROLLER_TASK_ID;if(task&&!/^[A-Za-z0-9_-]{1,64}$/.test(task))throw Error('invalid_task_id');
  const question=await readFile(summaryFile,'utf8');if(!question.trim()||Buffer.byteLength(question)>12000)throw Error('summary_size');
  const r=await fetch(new URL('/jobs',backend),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:id,question,queue:true,...(task?{task_id:task,project_id:project?projectUrl(project).split('/')[4]:'default',project_name:project?'官网项目':'不使用官网项目（普通对话）'}:{}),...(project?{project_url:projectUrl(project)}:{}),...(operation==='continue'?{conversation_url:conversationUrl(reference)}:{})}),signal:AbortSignal.timeout(10000)});
  result=await r.json();if(!r.ok){console.log(JSON.stringify(result));process.exit(2);}
 }else{
  const r=await fetch(new URL('/jobs/'+id+'/'+operation,backend),{method:'POST',signal:AbortSignal.timeout(10000)});result=await r.json();if(!r.ok){console.log(JSON.stringify(result));process.exit(2);}
 }
 const deadline=Date.now()+145000;
 do{const r=await fetch(new URL('/jobs/'+id,backend),{signal:AbortSignal.timeout(10000)});result=await r.json();if(!r.ok)break;if(!['queued','running'].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,700));}while(Date.now()<deadline);
 console.log(JSON.stringify(result,null,2));if(!result.generation_complete||result.status!=='completed')process.exitCode=2;
}catch{console.error('WEB_CALL_UNAVAILABLE: keep the original request ID; recover without resubmitting the question');process.exitCode=1;}
