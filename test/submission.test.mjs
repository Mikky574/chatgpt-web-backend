import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBridge} from '../bridge.mjs';
test('explicit send button is preferred to Enter and submission is anchored',async()=>{
 const b=new BrowserBridge({},async()=>{});let clicked=0,pressed=0;
 const button={count:async()=>1,waitFor:async()=>{},click:async()=>{clicked++}};
 const page={locator:()=>button};b.pin=async()=>{};b.messages=async()=>[{role:'user',text:'old',message_id:'old'},{role:'user',text:'question',message_id:'new'}];
 const record={question:'question',before_count:1};
 await b.submit(page,{press:async()=>{pressed++}},record,async()=>{});
 assert.equal(clicked,1);assert.equal(pressed,0);assert.equal(record.submission_confirmed,true);assert.equal(record.user_message_id,'new');
});
test('unknown composer uses Enter once and rejects ambiguous buttons without submitting',async()=>{
 const b=new BrowserBridge({},async()=>{});b.pin=async()=>{};b.messages=async()=>[{role:'user',text:'q',message_id:'id'}];let presses=0;
 await b.submit({locator:()=>({count:async()=>0})},{press:async()=>{presses++}},{question:'q',before_count:0},async()=>{});
 assert.equal(presses,1);
 await assert.rejects(b.submit({locator:()=>({count:async()=>2})},{press:async()=>{presses++}},{question:'q'},async()=>{}),/多个发送按钮/);
 assert.equal(presses,1);
});
test('uncertain button click never falls back to Enter',async()=>{
 const b=new BrowserBridge({},async()=>{});let presses=0;
 await assert.rejects(b.submit({locator:()=>({count:async()=>1,waitFor:async()=>{},click:async()=>{throw new Error('lost acknowledgement')}})},{press:async()=>{presses++}},{question:'q'},async()=>{}),/勿自动重发/);
 assert.equal(presses,0);
});
