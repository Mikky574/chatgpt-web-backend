// Observe only requests belonging to this public/approved prompt. Never store headers or raw bodies.
export function monitorWebTurn(page,record){
 const requests=new Map(),started=Date.now();
 record.network={transport:'browser_frontend',requests:[],stream_finished:false};
 const request=req=>{
  let url;try{url=new URL(req.url());}catch{return;}
  if(url.origin!=='https://chatgpt.com'||req.method()!=='POST'||!/^\/backend-api\/(?:f\/)?conversation(?:\/prepare)?$/.test(url.pathname))return;
  const body=req.postData()||'',escaped=JSON.stringify(record.question.trim()).slice(1,-1);
  if(!body.includes(escaped))return;
  const item={path:url.pathname,method:'POST',started_ms:Date.now()-started};requests.set(req,item);record.network.requests.push(item);
 };
 const response=async res=>{const item=requests.get(res.request());if(!item)return;item.http_status=res.status();item.content_type=await res.headerValue('content-type').catch(()=>null);};
 const finished=req=>{const item=requests.get(req);if(!item)return;item.finished=true;item.elapsed_ms=Date.now()-started-item.started_ms;if(item.path.endsWith('/conversation'))record.network.stream_finished=true;};
 const failed=req=>{const item=requests.get(req);if(item){item.ended=true;if(/ERR_ABORTED/.test(req.failure()?.errorText||''))item.aborted=true;else item.failed=true;}};
 page.on('request',request);page.on('response',response);page.on('requestfinished',finished);page.on('requestfailed',failed);
 return ()=>{page.off('request',request);page.off('response',response);page.off('requestfinished',finished);page.off('requestfailed',failed);};
}
