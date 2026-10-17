// Explicit manual probe, excluded from Node's automatic test discovery. No tokens returned to Node.
import {chromium} from 'playwright-core';
import {mkdir,writeFile} from 'node:fs/promises';
let browser;
let result;
try {
 browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:5000});
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('https://chatgpt.com/'));
 if(!page)throw new Error('No logged-in site tab; no page was created');
 result=await page.evaluate(async()=>{
   const sessionResponse=await fetch('/api/auth/session',{credentials:'include',signal:AbortSignal.timeout(10000)});
   if(!sessionResponse.ok)return {stage:'session',status:sessionResponse.status};
   const session=await sessionResponse.json();
   if(typeof session.accessToken!=='string')return {stage:'session',tokenAvailable:false};
   const payload={action:'next',messages:[{id:crypto.randomUUID(),author:{role:'user'},content:{content_type:'text',parts:['公开API连通性测试，请只回复 api-stream-ok。']}}],parent_message_id:crypto.randomUUID(),model:'auto',timezone_offset_min:new Date().getTimezoneOffset(),supported_encodings:['v1']};
   // No Sentinel/Cloudflare proofs are read, fabricated, or replayed.
   const response=await fetch('/backend-api/f/conversation',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.accessToken},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
   const report={stage:'generation',status:response.status,contentType:response.headers.get('content-type'),tokenStayedInBrowser:true};
   if(!response.ok){const text=await response.text();report.verification=/cloudflare|captcha|sentinel|challenge|verification/i.test(text);report.errorBodyOmitted=true;
     report.hints={requestFormat:/missing|invalid.*(?:field|request|parameter)|required|schema/i.test(text),modelAccess:/model|feature|not.*allowed|permission|access.denied/i.test(text),sessionExpiry:/expired|unauthorized|authentication/i.test(text),clientVersion:/client.version|unsupported.client|user.agent/i.test(text)};
     try{const body=JSON.parse(text);report.errorShape=Object.fromEntries(Object.entries(body).map(([k,v])=>[k,v===null?'null':typeof v]));const code=body.error?.code||body.code;if(typeof code==='string'&&/^[a-z_]{1,60}$/i.test(code))report.errorCode=code;
       report.detailHints={forbidden:/forbidden/i.test(body.detail||''),token:/token|jwt|auth/i.test(body.detail||''),origin:/origin|csrf|cross.site|ssrf|host/i.test(body.detail||''),policy:/policy|disallow|denied|blocked/i.test(body.detail||'')};
       for(const label of ['Forbidden','Unauthorized','Not Found','Bad Request','Access denied'])if(body.detail?.toLowerCase()===label.toLowerCase())report.errorLabel=label;
     }catch{}
     return report;}
   if(!/event-stream/.test(report.contentType||'')){report.stream=false;return report;}
   const reader=response.body.getReader(),decoder=new TextDecoder();let text='',chunks=0;
   try{while(chunks<1000){const {value,done}=await reader.read();if(done)break;chunks++;text+=decoder.decode(value,{stream:true});if(text.length>1000000||text.includes('[DONE]'))break;}}finally{await reader.cancel().catch(()=>{});}
   return {...report,stream:true,chunks,expectedAnswerObserved:text.includes('api-stream-ok'),doneMarker:text.includes('[DONE]')};
 });
}catch(e){result={stage:'experiment',failed:true,errorType:e.name,detail:'connection, session, or stream attempt failed; raw exception omitted'};process.exitCode=1;}
finally{await browser?.close();await mkdir('records/stream-exploration',{recursive:true});await writeFile('records/stream-exploration/direct-api-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
