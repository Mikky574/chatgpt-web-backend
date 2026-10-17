import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBridge,isConversationUnavailable} from '../bridge.mjs';
import {runTask} from '../task-controller.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('permission error wins over its login suggestion, but ordinary auth/network failures do not reset',()=>{
 assert.equal(isConversationUnavailable('你无权访问此对话。请确认已登录正确的账户，或请对话所有者向你发送分享链接。'),true);
 for(const text of ['Unable to load conversation','无法获取对应对话','Conversation not found'])assert.equal(isConversationUnavailable(text),true);
 for(const text of ['请登录后重试','cloudflare_challenge','network error, please refresh','Too many requests'])assert.equal(isConversationUnavailable(text),false);
});

test('closed browser tab is reopened at the same conversation URL',async()=>{
 const old='https://chatgpt.com/c/original';let opened;
 const target={url:()=>old,isClosed:()=>false,goto:async url=>{opened=url},locator:()=>({first(){return this},waitFor:async()=>{}})};
 const b=new BrowserBridge({},async()=>{});b.requestPages=new Map([['r',{isClosed:()=>true}]]);
 b.connect=async()=>({contexts:()=>[{pages:()=>[],newPage:async()=>target}]});
 assert.equal(await b.page({request_id:'r',conversation_url:old}),target);assert.equal(opened,old);
});

test('authenticated home redirect counts as an inaccessible conversation, login failure does not',async()=>{
 const b=new BrowserBridge({},async()=>{}),record={conversation_url:'https://chatgpt.com/c/old'};
 let authenticated=true;const page={url:()=> 'https://chatgpt.com/',locator:()=>({evaluateAll:async()=>''}),evaluate:async()=>authenticated};
 assert.equal(await b.conversationUnavailable(page,record),true);authenticated=false;assert.equal(await b.conversationUnavailable(page,record),false);
});

test('inaccessible submitted conversation rebuilds once and only replays current approved question',async()=>{
 const old='https://chatgpt.com/c/old',next='https://chatgpt.com/c/new';let calls=0,saved=0;
 const b=new BrowserBridge({conversation_url:old},async()=>{});b.page=async()=>({});b.conversationUnavailable=async()=>true;
 b.ask=async(r,persist)=>{calls++;assert.equal(r.conversation_url,null);assert.equal(r.user_message_id,undefined);assert.equal(r.context_reset_pending,true);assert.equal(r.question,'approved current question');await b.pin({url:()=>next},r,persist);return r;};
 const record={request_id:'same',conversation_url:old,user_message_id:'u',submission_confirmed:true,question:'approved current question',answer:'old partial answer'};
 await b.recover(record,async()=>{saved++},1000);assert.equal(calls,1);assert.equal(record.conversation_url,next);assert.equal(record.context_reset.from_url,old);assert.equal(record.context_reset.to_url,next);assert.equal(record.context_reset.history_transferred,false);assert.equal(record.context_reset.current_question_replayed,true);assert.equal(b.config.conversation_url,next);assert.ok(saved>=2);
 await assert.rejects(b.resetConversation(record,async()=>{}),/一次/);
});

test('task accepts explicit unavailable-conversation transition and persists its new binding',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'conversation-reset-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const old='https://chatgpt.com/c/old',next='https://chatgpt.com/c/new';const base={directory,operation:'ask',taskId:'task',packet:{task_id:'task',goal:'public'}};
 await runTask({...base,transport:async q=>({request_id:q.requestId,conversation_url:old,status:'completed',generation_complete:true})});
 const result=await runTask({...base,transport:async q=>({request_id:q.requestId,conversation_url:next,status:'completed',generation_complete:true,context_reset:{from_url:old,to_url:next,reason:'conversation_unavailable',history_transferred:false}})});
 assert.equal(result.conversation_url,next);assert.equal(result.conversation_resets.length,1);assert.equal(result.pending_request_id,null);
});
