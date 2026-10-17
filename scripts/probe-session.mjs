// Explicit session-health probe. Values stay in the logged-in browser; only booleans leave it.
import {chromium} from 'playwright-core';
let browser;
try{
 browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:5000});
 const contexts=browser.contexts();if(contexts.length!==1)throw Error('Choose one login context before probing');
 const page=contexts[0].pages().find(p=>p.url().startsWith('https://chatgpt.com/'));if(!page)throw Error('No existing ChatGPT tab');
 const result=await page.evaluate(async()=>{
  try{const r=await fetch('/api/auth/session',{credentials:'same-origin'});if(!r.ok)return {http_status:r.status,session_available:false};const s=await r.json();return {http_status:r.status,session_available:!!s.user,access_token_present:typeof s.accessToken==='string'&&s.accessToken.length>0,expiry_present:typeof s.expires==='string',expiry_in_future:typeof s.expires==='string'?Date.parse(s.expires)>Date.now():null};}catch{return {probe_failed:true};}
 });
 console.log(JSON.stringify(result));
}catch{console.error('SESSION_PROBE_UNAVAILABLE: check CDP and the existing login context');process.exitCode=1;}
finally{await browser?.close();}
