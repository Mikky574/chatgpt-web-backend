import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runTask} from '../task-controller.mjs';
test('persist conversation across independent calls and keep tasks isolated',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'role-identity-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const calls=[];const transport=async q=>{calls.push(q);return {request_id:q.requestId,conversation_url:q.conversationUrl||'https://chatgpt.com/c/'+q.requestId,status:'completed',generation_complete:true};};
 const invoke=id=>runTask({directory,operation:'ask',taskId:id,packet:{task_id:id,goal:'public'},transport});
 const first=await invoke('one');await invoke('two');const resumed=await invoke('one');
 assert.equal(calls[0].mode,'new');assert.equal(calls[1].mode,'new');assert.equal(calls[2].mode,'continue');assert.equal(resumed.conversation_url,first.conversation_url);assert.notEqual(calls[0].requestId,calls[2].requestId);
});
test('uncertain request blocks new asks and recovery reuses original request identity',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'role-recover-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const base={directory,taskId:'one',packet:{task_id:'one',goal:'public'}};let pending;
 await assert.rejects(runTask({...base,operation:'ask',transport:async q=>{pending=q.requestId;throw new Error('lost response');}}));
 await assert.rejects(runTask({...base,operation:'ask',transport:async()=>assert.fail()}),/unresolved/);
 const result=await runTask({...base,operation:'recover',transport:async q=>{assert.equal(q.mode,'recover');assert.equal(q.requestId,pending);return {request_id:q.requestId,conversation_url:'https://chatgpt.com/c/one',status:'completed',generation_complete:true};}});
 assert.equal(result.pending_request_id,null);
});
test('known capacity rejection does not leave an imaginary pending submission',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'role-not-sent-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const result=await runTask({directory,operation:'ask',taskId:'one',provider:'other-provider',packet:{task_id:'one',goal:'public'},transport:async()=>({error:'queue_full',request_submitted:false})});
 assert.equal(result.pending_request_id,null);assert.equal(result.last_result.error,'queue_full');
 await assert.rejects(runTask({directory,operation:'ask',taskId:'one',provider:'chatgpt-web',packet:{task_id:'one',goal:'public'},transport:async()=>assert.fail()}),/PROVIDER_MISMATCH/);
});
