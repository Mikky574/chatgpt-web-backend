// Queued facade over the existing browser backend. No CLI inference or token export.
import {conversationUrl} from './conversation-url.mjs';
export function createWebRunner({backend='http://127.0.0.1:8787',timeoutMs=120000,fetchImpl=fetch}={}){
 const url=new URL(backend);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('WEB_BACKEND_MUST_BE_LOOPBACK');
 return async({requestId,question,sessionId,projectUrl,onEvent,operation='ask'})=>{
  const body={request_id:requestId,timeout_ms:timeoutMs,wait_for_slot_ms:15000};
  if(operation==='ask')Object.assign(body,{question,conversation_mode:sessionId?'continue':'new',...(sessionId?{conversation_url:sessionId}:{})});
  if(projectUrl)body.project_url=projectUrl;
  if(operation==='retry')body.retry_generation=true;
  if(operation==='refresh')body.refresh_page=true;
  let response,ticking=false,lastStage;
  const timer=setInterval(async()=>{
   if(ticking)return;ticking=true;
   try{const r=await fetchImpl(new URL('/records/'+requestId,url),{signal:AbortSignal.timeout(4000)});if(r.ok){const record=await r.json();if(record.stage&&record.stage!==lastStage){lastStage=record.stage;onEvent({type:'progress',stage:record.stage});}}}catch{}finally{ticking=false;}
  },1000);
  try{response=await fetchImpl(new URL(operation==='ask'?'/ask':'/recover',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs+30000)});}
  catch{throw new Error('WEB_TRANSPORT_RESULT_UNCERTAIN');}finally{clearInterval(timer);}
  const result=await response.json();
  if(!result.request_id||result.request_id!==requestId){
    // A validation/capacity rejection happened before any browser submission.
    if(result.request_submitted===false||[400,404,409,413,415].includes(response.status))return {request_id:requestId,status:'failed',generation_complete:false,generation_status:'not_started',request_submitted:false,error:result.error||'WEB_BACKEND_REJECTED'};
    const e=new Error('WEB_BACKEND_REJECTED');e.result=result;throw e;
  }
  if(sessionId&&result.conversation_url&&conversationUrl(sessionId)!==conversationUrl(result.conversation_url)&&!(result.context_reset?.reason==='conversation_unavailable'&&result.context_reset.from_url===sessionId&&result.context_reset.to_url===result.conversation_url&&result.context_reset.history_transferred===false))throw new Error('WEB_CONVERSATION_CHANGED');
  if(result.conversation_url)onEvent({type:'session.started',session_id:result.conversation_url});
  if(result.answer)onEvent({type:'answer.available',text:result.answer});
  return {...result,session_id:result.conversation_url};
 };
}
