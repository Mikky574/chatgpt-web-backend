import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBridge} from '../bridge.mjs';
function page(url){return {url:()=>url,isClosed:()=>false,locator:()=>({first(){return this},waitFor:async()=>{},evaluateAll:async()=>''})};}
test('find the exact conversation across contexts, bind request and reject tab navigation',async()=>{
 const expected='https://chatgpt.com/c/right';let current=expected;const target=page(expected);target.url=()=>current;
 const b=new BrowserBridge({},async()=>{});b.connect=async()=>({contexts:()=>[{pages:()=>[page('https://chatgpt.com/c/wrong')]},{pages:()=>[target]}]});
 const r={request_id:'r',conversation_url:expected};assert.equal(await b.page(r),target);
 current='https://chatgpt.com/c/other';await assert.rejects(b.page(r),/离开原对话/);
});
test('duplicate tabs in one account use a dedicated page, but multiple accounts are not guessed',async()=>{
 const url='https://chatgpt.com/c/right';const b=new BrowserBridge({},async()=>{});
 const dedicated=page(url);let created=0;dedicated.goto=async()=>{created++};
 b.connect=async()=>({contexts:()=>[{pages:()=>[page(url),page(url)],newPage:async()=>dedicated}]});assert.equal(await b.page({conversation_url:url}),dedicated);assert.equal(created,1);assert.equal(await b.page({request_id:'next',conversation_url:url}),dedicated);assert.equal(created,1);
 b.connect=async()=>({contexts:()=>[{pages:()=>[]},{pages:()=>[]}]});await assert.rejects(b.page({conversation_mode:'new'}),/多个登录上下文/);
});

test('no default conversation with multiple home tabs reuses only a safe blank home',async()=>{
 const b=new BrowserBridge({conversation_url:null},async()=>{});const safe=page('https://chatgpt.com/');safe.locator=()=>({first(){return this},waitFor:async()=>{},evaluateAll:async()=>true});
 b.conversationUnavailable=async()=>false;b.connect=async()=>({contexts:()=>[{pages:()=>[safe,page('https://chatgpt.com/'),page('https://chatgpt.com/c/unrelated')]}]});
 assert.equal(await b.page({request_id:'first',conversation_mode:'continue'}),safe);
});
test('refresh restores the same submitted request without asking again and protects drafts',async()=>{
 let refreshed=0,waits=0,saves=0;
 const b=new BrowserBridge({},async()=>{});let draft=false;
 b.messages=async()=>[];
 b.page=async()=>({url:()=> 'https://chatgpt.com/c/one',locator:s=>({evaluateAll:async()=>draft,count:async()=>0}),reload:async()=>{assert.equal(saves,1);refreshed++;}});
 b.wait=async(_,r)=>{waits++;return r;};
 const r={conversation_url:'https://chatgpt.com/c/one',user_message_id:'u'};
 await b.recover(r,async()=>{saves++},1000,{refreshPage:true});assert.equal(refreshed,1);assert.equal(waits,1);
 draft=true;await assert.rejects(b.recover(r,async()=>{},1000,{refreshPage:true}),/草稿/);assert.equal(refreshed,1);
 await assert.rejects(b.recover({conversation_url:r.conversation_url},async()=>{},1000,{refreshPage:true}),/用户消息ID/);
});
