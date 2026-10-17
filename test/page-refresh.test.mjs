import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBridge,classifyPageIssue} from '../bridge.mjs';

test('site refresh hints distinguish verification and rate limits',()=>{
 for(const text of ['Something went wrong. Please refresh the page.','请刷新页面后重试','Reload'])assert.equal(classifyPageIssue(text),'refresh_required');
 assert.equal(classifyPageIssue('cloudflare_challenge Please refresh the page'),'browser_verification');
 assert.equal(classifyPageIssue('Too many requests, refresh the page'),'rate_limited');
 assert.equal(classifyPageIssue('normal answer'),null);
});

test('refresh hint is reported before a missing user bubble and never sends a question',async()=>{
 const b=new BrowserBridge({},async()=>{});b.pin=async()=>{};
 const page={url:()=> 'https://chatgpt.com/c/example',locator:()=>({evaluateAll:async()=> 'Please refresh the page'})};
 b.messages=async()=>assert.fail('error screen need not contain message bubbles');
 const record={conversation_url:page.url(),user_message_id:'u',question:'public'};
 const result=await b.wait(page,record,async()=>{},1000);
 assert.equal(result.stage,'refresh_required');assert.equal(result.refresh.allowed,true);assert.equal(result.generation_complete,false);
});

test('refresh preserves original identity, records intent, caps retries and rejects unsafe pages',async()=>{
 const b=new BrowserBridge({},async()=>{});let reloads=0,saved=false,draft=false,active=false,url='https://chatgpt.com/c/example';
 b.pageIssue=async()=>null;b.messages=async()=>[{role:'user',message_id:'u',text:'public'}];
 const page={url:()=>url,locator:()=>({evaluateAll:async()=>draft,count:async()=>active?1:0}),reload:async()=>{assert.ok(saved);reloads++;}};
 b.page=async()=>page;b.wait=async(_,r)=>r;
 const record={conversation_url:url,user_message_id:'u',question:'public',request_id:'same'};
 await b.recover(record,async()=>{saved=true},1000,{refreshPage:true});assert.equal(reloads,1);assert.equal(record.request_id,'same');
 draft=true;await assert.rejects(b.recover(record,async()=>{},1000,{refreshPage:true}),/草稿/);draft=false;
 active=true;await assert.rejects(b.recover(record,async()=>{},1000,{refreshPage:true}),/仍在生成/);active=false;
 b.messages=async()=>[{role:'user',message_id:'u'},{role:'user',message_id:'later'}];await assert.rejects(b.recover(record,async()=>{},1000,{refreshPage:true}),/新消息/);
 record.refresh_count=2;await assert.rejects(b.recover(record,async()=>{},1000,{refreshPage:true}),/上限/);assert.equal(reloads,1);
});
