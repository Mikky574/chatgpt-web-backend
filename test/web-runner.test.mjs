import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWebRunner} from '../web-runner.mjs';
import {monitorWebTurn} from '../web-network.mjs';

test('web runner sends new/continue and recovers the original request without sending its question',async()=>{
 const calls=[],ref='https://chatgpt.com/c/test-session',events=[];
 const runner=createWebRunner({fetchImpl:async(url,options)=>{calls.push({path:url.pathname,body:JSON.parse(options.body)});return {json:async()=>({request_id:'one',conversation_url:ref,status:'completed',generation_complete:true,answer:'web answer'})};}});
 const input={requestId:'one',question:'approved',onEvent:e=>events.push(e)};
 await runner(input);await runner({...input,sessionId:ref});await runner({...input,sessionId:ref,operation:'recover'});
 assert.equal(calls[0].body.conversation_mode,'new');assert.equal(calls[1].body.conversation_url,ref);
 assert.equal(calls[2].path,'/recover');assert.equal(calls[2].body.question,undefined);assert.equal(calls[2].body.request_id,'one');
 assert.ok(events.some(e=>e.type==='answer.available'&&e.text==='web answer'));
});

test('web runner refuses changed conversation and transport uncertainty',async()=>{
 const input={requestId:'one',question:'approved',sessionId:'https://chatgpt.com/c/right',onEvent:()=>{}};
 const wrong=createWebRunner({fetchImpl:async()=>({json:async()=>({request_id:'one',conversation_url:'https://chatgpt.com/c/wrong'})})});
 await assert.rejects(wrong(input),/CONVERSATION_CHANGED/);
 await assert.rejects(createWebRunner({fetchImpl:async()=>{throw Error('connection lost');}})(input),/RESULT_UNCERTAIN/);
});

test('pre-submission busy is explicit and does not strand clients in pending',async()=>{
 const runner=createWebRunner({fetchImpl:async()=>({status:409,json:async()=>({error:'busy',request_submitted:false})})});
 const result=await runner({requestId:'busy-job',question:'public',onEvent:()=>{}});
 assert.equal(result.request_submitted,false);assert.equal(result.request_id,'busy-job');assert.equal(result.generation_complete,false);assert.equal(result.error,'busy');
});

test('web runner allows only a documented unavailable-conversation reset',async()=>{
 const old='https://chatgpt.com/c/old',next='https://chatgpt.com/c/new';
 const runner=createWebRunner({fetchImpl:async()=>({json:async()=>({request_id:'reset',conversation_url:next,status:'completed',generation_complete:true,context_reset:{reason:'conversation_unavailable',from_url:old,to_url:next,history_transferred:false}})})});
 const result=await runner({requestId:'reset',question:'approved',sessionId:old,onEvent:()=>{}});assert.equal(result.session_id,next);
});

test('network observer correlates only this turn and never saves bodies or credentials',async()=>{
 const page=new EventEmitter(),record={question:'approved test\n'};const stop=monitorWebTurn(page,record);
 const request=(question)=>({url:()=> 'https://chatgpt.com/backend-api/f/conversation',method:()=> 'POST',postData:()=>JSON.stringify({question,secret:'synthetic-secret-not-to-save'})});
 page.emit('request',request('other question'));const own=request(record.question.trim());page.emit('request',own);
 page.emit('response',{request:()=>own,status:()=>200,headerValue:async()=> 'text/event-stream'});await new Promise(r=>setImmediate(r));page.emit('requestfinished',own);
 assert.equal(record.network.requests.length,1);assert.equal(record.network.requests[0].http_status,200);assert.equal(record.network.stream_finished,true);
 assert.ok(!JSON.stringify(record.network).includes('synthetic-secret'));assert.ok(!JSON.stringify(record.network).includes('approved test'));
 stop();assert.equal(page.listenerCount('request'),0);
});
