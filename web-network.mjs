// Observe only requests belonging to this public/approved prompt. Never store headers or raw bodies.
export function monitorWebTurn(page,record){
 const requests=new Map(),started=Date.now();
 record.network={transport:'browser_frontend',requests:[],stream_finished:false};
 const request=req=>{
  let url;try{url=new URL(req.url());}catch{return;}
  if(url.origin!=='https://chatgpt.com'||req.method()!=='POST'||!/^\/backend-api\/(?:f\/)?conversation(?:\/prepare)?$/.test(url.pathname))return;
  const body=req.postData()||'',escaped=JSON.stringify((record.submission_text||record.question).trim()).slice(1,-1);
  if(!body.includes(escaped))return;
  const item={path:url.pathname,method:'POST',started_ms:Date.now()-started};requests.set(req,item);record.network.requests.push(item);
 };
 const response=async res=>{
  const req=res.request();
  // Passive observation only; never fetch history or probe authentication here.
  if(res.status()===429){
   let url;try{url=new URL(req.url());}catch{}
   if(url?.origin==='https://chatgpt.com'&&/^\/(?:backend-api\/|api\/auth\/)/.test(url.pathname)){
    record.network.rate_limited=true;
    record.network.rate_limit_until=Date.now()+60000;
    const value=await res.headerValue('retry-after').catch(()=>null);
    const seconds=Number(value),date=Date.parse(value);
    record.network.retry_after_ms=value==null?null:Number.isFinite(seconds)&&seconds>=0?seconds*1000:Number.isFinite(date)?Math.max(0,date-Date.now()):null;
    record.network.rate_limit_until=Date.now()+Math.max(60000,record.network.retry_after_ms||0);
   }
  }
  const item=requests.get(req);if(!item)return;item.http_status=res.status();item.content_type=await res.headerValue('content-type').catch(()=>null);
 };
 const finished=req=>{const item=requests.get(req);if(!item)return;item.finished=true;item.elapsed_ms=Date.now()-started-item.started_ms;if(item.path.endsWith('/conversation'))record.network.stream_finished=true;};
 const failed=req=>{const item=requests.get(req);if(item){item.ended=true;if(/ERR_ABORTED/.test(req.failure()?.errorText||''))item.aborted=true;else item.failed=true;}};
 page.on('request',request);page.on('response',response);page.on('requestfinished',finished);page.on('requestfailed',failed);
 return ()=>{page.off('request',request);page.off('response',response);page.off('requestfinished',finished);page.off('requestfailed',failed);};
}
