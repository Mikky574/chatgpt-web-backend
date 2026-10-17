import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';

export function safePath(value){
 const u=new URL(value);
 return u.pathname.split('/').map(s=>{
  let decoded;try{decoded=decodeURIComponent(s);}catch{return ':opaque';}
  return decoded.length>32||/^[0-9]+$/.test(decoded)||/@|[=;]/.test(decoded)||/^[a-f0-9-]{16,}$/i.test(decoded)||/^(?:sk-|gh[pousr]_|eyJ)/.test(decoded)?':id':s;
 }).join('/');
}
export async function observe({chromium,cdp,pageUrl,durationMs=20000}){
 const endpoint=new URL(cdp),target=new URL(pageUrl);
 if(!['http:','ws:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error('loopback_cdp_required');
 if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw Error('invalid_page_url');
 if(!Number.isInteger(durationMs)||durationMs<100||durationMs>60000)throw Error('duration_must_be_100_to_60000');
 let browser,page;const bindings=[];
 try{
  browser=await chromium.connectOverCDP(cdp,{timeout:5000});
  const matches=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url()===pageUrl);
  if(matches.length!==1)throw Error('exact_page_must_match_once');page=matches[0];
  const report={mode:'passive_metadata_only',duration_ms:durationMs,requests:[],truncated:false},tracked=new Map(),started=Date.now();
  const same=value=>{try{return new URL(value).origin===target.origin;}catch{return false;}};
  const append=item=>{if(report.requests.length>=300){report.truncated=true;return false;}report.requests.push(item);return true;};
  const bind=(event,fn)=>{page.on(event,fn);bindings.push([event,fn]);};
  bind('request',req=>{if(!same(req.url()))return;const item={path:safePath(req.url()),method:req.method(),resource_type:req.resourceType(),started_ms:Date.now()-started};if(append(item))tracked.set(req,item);});
  bind('response',res=>{const item=tracked.get(res.request());if(!item)return;item.http_status=res.status();item.content_type=(res.headers()['content-type']||'').split(';')[0].slice(0,80);});
  bind('requestfinished',req=>{const item=tracked.get(req);if(item){item.finished=true;item.elapsed_ms=Date.now()-started-item.started_ms;tracked.delete(req);}});
  bind('requestfailed',req=>{const item=tracked.get(req);if(item){item.failed=true;tracked.delete(req);}});
  bind('websocket',socket=>{const u=new URL(socket.url()),equivalent=u.protocol==='wss:'?'https:':u.protocol==='ws:'?'http:':u.protocol;if(equivalent+'//'+u.host!==target.origin)return;append({path:safePath(socket.url()),resource_type:'websocket',started_ms:Date.now()-started,frames_observed:false});});
  await new Promise(resolve=>setTimeout(resolve,durationMs));return report;
 }finally{for(const [event,fn]of bindings)page?.off(event,fn);await browser?.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const options={};const args=process.argv.slice(2);if(args.length%2)throw Error('options_require_values');
  for(let i=0;i<args.length;i+=2){if(!['--cdp','--page-url','--duration-ms','--output'].includes(args[i])||options[args[i]])throw Error('invalid_option');options[args[i]]=args[i+1];}
  if(!options['--cdp']||!options['--page-url']||!options['--output'])throw Error('required_options_missing');
  const require=createRequire(path.join(process.cwd(),'package.json'));const {chromium}=require('playwright-core');
  const output=path.resolve(options['--output']);await mkdir(path.dirname(output),{recursive:true});
  // Reserve the report first so an existing evidence file is never overwritten.
  await writeFile(output,'', {flag:'wx'});
  const report=await observe({chromium,cdp:options['--cdp'],pageUrl:options['--page-url'],durationMs:Number(options['--duration-ms']||20000)});
  await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({saved:true,requests:report.requests.length,truncated:report.truncated}));
 }catch(e){console.error(/^[a-z_0-9]+$/.test(e.message)?e.message:'observation_failed_no_raw_error_exported');process.exitCode=1;}
}
