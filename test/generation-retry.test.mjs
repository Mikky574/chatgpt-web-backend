import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBridge,classifyGenerationFailure} from '../bridge.mjs';
test('verification and rate limits cannot use ordinary retry',()=>{
 assert.equal(classifyGenerationFailure('cloudflare_challenge'),'browser_verification');
 assert.equal(classifyGenerationFailure('Too many requests'),'rate_limited');
});
function fixture(text='Something went wrong') {
 let clicks=0,saves=0;
 const record={question:'public',conversation_url:'https://chatgpt.com/c/test',user_message_id:'user'};
 const button={filter(){return this},count:async()=>1,click:async()=>{assert.equal(saves,1);clicks++}};
 const b=new BrowserBridge({},async()=>{});b.page=async()=>({locator:()=>({evaluateAll:async()=>''})});b.messages=async()=>[{role:'user',message_id:'user',text:'public'}];
 b.turn=async()=>({innerText:async()=>text,getByRole:()=>button});b.wait=async(_,r)=>r;
 return {b,record,persist:async()=>{saves++},clicks:()=>clicks};
}
test('retry persists intent, clicks original turn and refuses cap or challenge',async()=>{
 const f=fixture();await f.b.retry(f.record,f.persist,1000);assert.equal(f.clicks(),1);assert.equal(f.record.generation_retry_count,1);
 f.record.generation_retry_count=2;await assert.rejects(f.b.retry(f.record,f.persist,1000),/上限/);assert.equal(f.clicks(),1);
 const c=fixture('cloudflare_challenge');await assert.rejects(c.b.retry(c.record,c.persist,1000),/验证/);assert.equal(c.clicks(),0);
});
test('verification alert outside the message turn prevents any retry click',async()=>{
 const f=fixture();f.b.page=async()=>({locator:()=>({evaluateAll:async()=>'cloudflare_challenge'})});
 await assert.rejects(f.b.retry(f.record,f.persist,1000),/验证/);assert.equal(f.clicks(),0);
});
test('retry refuses neighbouring question and missing anchor',async()=>{
 const f=fixture();f.b.messages=async()=>[{role:'user',message_id:'user',text:'public'},{role:'user',message_id:'other',text:'other'}];
 await assert.rejects(f.b.retry(f.record,f.persist,1000),/不能安全重试/);assert.equal(f.clicks(),0);
 delete f.record.user_message_id;await assert.rejects(f.b.retry(f.record,f.persist,1000),/锚定/);
});
