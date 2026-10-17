// An opt-in synthetic live experiment. Does not export/replay browser credentials.
import {chromium} from 'playwright-core';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const marker='stream-probe-'+randomUUID();
const report={experiment:marker,question:'公开流式连通性测试，请只回复：stream-ok。',requests:[],streams:[],warnings:[]};
let browser,session;
const tracked=new Map();
function shape(value,depth=0){
 if(value===null)return 'null';if(Array.isArray(value))return {type:'array',sample:value.length?shape(value[0],depth+1):null};
 if(typeof value==='object')return depth>=3?'object':Object.fromEntries(Object.entries(value).slice(0,60).map(([k,v])=>[k,shape(v,depth+1)]));
 return typeof value;
}
function consume(item,text){
 item.buffer+=text;
 if(item.buffer.length>1000000){item.buffer='';report.warnings.push('stream_buffer_limit');return;}
 let i;
 while((i=item.buffer.indexOf('\n'))>=0){
  const line=item.buffer.slice(0,i).trim();item.buffer=item.buffer.slice(i+1);
  if(line.startsWith('event:')){const event=line.slice(6).trim();if(!item.summary.eventNames.includes(event))item.summary.eventNames.push(event);}
  if(!line.startsWith('data:'))continue;
  const data=line.slice(5).trim();item.summary.dataEvents++;
  if(data==='[DONE]'){item.summary.doneMarker=true;continue;}
  try{const value=JSON.parse(data);if(item.summary.samples.length<8)item.summary.samples.push(shape(value));
   if(value&&typeof value==='object')for(const k of Object.keys(value))if(!item.summary.topLevelKeys.includes(k))item.summary.topLevelKeys.push(k);
   for(const k of ['type','status','o','p'])if(typeof value[k]==='string'&&value[k].length<150&&!item.summary.signalValues.includes(k+':'+value[k]))item.summary.signalValues.push(k+':'+value[k]);
   // Input-message events echo the question; they must not count as assistant output.
   const message=value?.message||value?.v?.message;
   if(message?.author?.role==='assistant'&&message.channel!=='analysis'&&message.channel!=='commentary'&&message.content?.parts?.some(p=>typeof p==='string'&&p.includes('stream-ok')))item.summary.expectedAnswerObserved=true;
   if(message?.status==='finished_successfully'||value.type==='response.completed'||value.type==='message_stream_complete')item.summary.explicitCompletionObserved=true;
  }catch{item.summary.nonJsonEvents++;}
 }
}
try{
 browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:5000});
 const candidates=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()==='https://chatgpt.com/'||p.url()==='https://chatgpt.com');
 if(candidates.length!==1)throw new Error('Use one blank ChatGPT home tab for the synthetic test; no existing conversation is selected automatically');
 const page=candidates[0];
 const input=page.locator('[role="textbox"][contenteditable="true"]:visible');
 await input.first().waitFor({state:'visible',timeout:15000});
 if(await input.count()!==1||await input.innerText().then(t=>t.trim().length))throw new Error('Composer missing, ambiguous, or has a draft');
 session=await page.context().newCDPSession(page);await session.send('Network.enable');
 session.on('Network.requestWillBeSent',e=>{
  const req=e.request;if(req.method!=='POST'||!req.url.startsWith('https://chatgpt.com/')||!req.postData?.includes(marker))return;
  const body=JSON.parse(req.postData);const names=Object.keys(req.headers).map(k=>k.toLowerCase());
  const info={path:new URL(req.url).pathname,method:req.method,bodyShape:shape(body),authorizationHeaderPresent:names.includes('authorization')};
  report.requests.push(info);tracked.set(e.requestId,{buffer:'',decoder:new TextDecoder(),summary:null});
 });
 session.on('Network.responseReceived',e=>{
  const item=tracked.get(e.requestId);if(!item)return;
  const type=Object.entries(e.response.headers).find(([k])=>k.toLowerCase()==='content-type')?.[1]||e.response.mimeType;
  item.summary={path:new URL(e.response.url).pathname,status:e.response.status,contentType:type,eventNames:[],topLevelKeys:[],signalValues:[],dataEvents:0,nonJsonEvents:0,samples:[],doneMarker:false,expectedAnswerObserved:false,explicitCompletionObserved:false,networkFinished:false};
  report.streams.push(item.summary);
  if(/event-stream/.test(type))session.send('Network.streamResourceContent',{requestId:e.requestId}).then(r=>{if(r.bufferedData)consume(item,item.decoder.decode(Buffer.from(r.bufferedData,'base64'),{stream:true}));}).catch(()=>{report.warnings.push('streamResourceContent_unavailable');});
 });
 session.on('Network.dataReceived',e=>{const item=tracked.get(e.requestId);if(item?.summary&&e.data)consume(item,item.decoder.decode(Buffer.from(e.data,'base64'),{stream:true}));});
 session.on('Network.loadingFinished',e=>{const item=tracked.get(e.requestId);if(item?.summary)item.summary.networkFinished=true;});
 await input.fill(`${report.question}\n测试标识：${marker}`);
 await input.press('Enter');
 const deadline=Date.now()+90000;
 while(Date.now()<deadline){if(report.streams.some(s=>/event-stream/.test(s.contentType)&&(s.doneMarker||s.explicitCompletionObserved||s.networkFinished)))break;await new Promise(r=>setTimeout(r,500));}
 report.pageHasSyntheticUserMessage=await page.locator('[data-user-message-bubble]').evaluateAll((es,m)=>es.some(e=>e.innerText.includes(m)),marker);
 report.visibleErrorHints=await page.locator('[role="alert"]:visible').evaluateAll(es=>es.map(e=>({verification:/cloudflare_challenge|verify|验证/i.test(e.innerText),retryButton:!!e.querySelector('button')})));
}catch(e){report.failure=e.message;process.exitCode=1;}
finally{
 await session?.detach().catch(()=>{});await browser?.close();
 await mkdir('records/stream-exploration',{recursive:true});
 const file=`records/stream-exploration/${marker}.json`;await writeFile(file,JSON.stringify(report,null,2));
 console.log(JSON.stringify({report:file,...report},null,2));
}
