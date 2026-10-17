import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createJobService} from '../job-server.mjs';
async function fixture(t,runner,directory){
 directory ||= await mkdtemp(path.join(os.tmpdir(),'web-service-'));
 const server=await createJobService({directory,runner:async input=>({generation_complete:true,...await runner(input)}),maxConcurrency:2});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
 const post=body=>fetch(base+'/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const get=id=>fetch(base+'/jobs/'+id).then(r=>r.json());
 const wait=async id=>{for(let i=0;i<100;i++){const job=await get(id);if(!['running','queued'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}throw new Error('test job timeout');};
 return {base,post,get,wait,directory};
}
test('web jobs are idempotent, persist their browser conversation and continue',async t=>{
 let calls=0;const seen=[];const session='https://chatgpt.com/c/11111111-1111-1111-1111-111111111111';
 const f=await fixture(t,async input=>{calls++;seen.push(input.sessionId);input.onEvent({type:'session.started',session_id:session});input.onEvent({type:'answer.available',text:'answer'});return {session_id:session,answer:'answer'};});
 assert.equal((await f.post({request_id:'one',question:'first'})).status,202);
 const first=await f.wait('one');assert.equal(first.generation_complete,true);assert.equal(first.conversation_url,session);
 assert.equal((await f.post({request_id:'one',question:'first'})).status,200);assert.equal(calls,1);
 assert.equal((await f.post({request_id:'one',question:'different'})).status,409);
 await f.post({request_id:'two',question:'next',conversation_url:first.conversation_url});await f.wait('two');assert.deepEqual(seen,[null,session]);
 const stream=await(await fetch(f.base+'/jobs/two/events')).text();assert.ok(stream.includes('session.started'));assert.ok(stream.includes('completed'));
 const saved=JSON.parse(await readFile(path.join(f.directory,'records/web-jobs/two.json')));assert.equal(saved.status,'completed');
 assert.equal((await f.post({request_id:'bad',question:'x',conversation_url:'https://other.example/c/no'})).status,400);
});

test('opt-in queue serializes a session, runs other sessions, and deduplicates simultaneous posts',async t=>{
 const releases=[],started=[];const session='https://chatgpt.com/c/33333333-3333-3333-3333-333333333333';
 const f=await fixture(t,input=>new Promise(resolve=>{started.push(input.question);const id=input.sessionId||'https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';input.onEvent({type:'session.started',session_id:id});releases.push(()=>resolve({session_id:id,answer:input.question}));}));
 const ref=session;
 await f.post({request_id:'q1',question:'first',conversation_url:ref,queue:true});
 const body={request_id:'q2',question:'second',conversation_url:ref,queue:true};
 const responses=await Promise.all([f.post(body),f.post(body)]);assert.ok(responses.every(r=>r.status===202));
 assert.equal((await f.get('q2')).status,'queued');
 await f.post({request_id:'q3',question:'independent',queue:true});assert.deepEqual(started,['first','independent']);
 releases[0]();await f.wait('q1');
 for(let i=0;i<50&&!started.includes('second');i++)await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(started,['first','independent','second']);releases[1]();releases[2]();
 assert.equal((await f.wait('q2')).answer,'second');await f.wait('q3');
});

test('chat page permits its own origin and rejects foreign browser origins',async t=>{
 const f=await fixture(t,async()=>({session_id:'https://chatgpt.com/c/55555555-5555-5555-5555-555555555555',answer:'ok'}));
 assert.equal((await fetch(f.base+'/')).status,200);
 assert.equal((await fetch(f.base+'/app.js')).status,200);
 assert.equal((await fetch(f.base+'/health',{headers:{Origin:f.base}})).status,200);
 assert.equal((await fetch(f.base+'/health',{headers:{Origin:'https://evil.example'}})).status,403);
});
test('independent sessions run concurrently while the same session is locked',async t=>{
 const releases=[];const f=await fixture(t,input=>new Promise(resolve=>{const id=input.sessionId||'https://chatgpt.com/c/22222222-2222-2222-2222-222222222222';input.onEvent({type:'session.started',session_id:id});releases.push(()=>resolve({session_id:id,answer:'ok'}));}));
 const ref='https://chatgpt.com/c/11111111-1111-1111-1111-111111111111';
 await f.post({request_id:'a',question:'one',conversation_url:ref});
 assert.equal((await f.post({request_id:'same',question:'two',conversation_url:ref})).status,409);
 assert.equal((await f.post({request_id:'b',question:'independent'})).status,202);
 assert.equal((await f.post({request_id:'full',question:'overflow'})).status,429);
 for(const release of releases)release();await f.wait('a');await f.wait('b');
});
test('restart marks unfinished work uncertain and never automatically runs it again',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'web-restart-'));await mkdir(path.join(directory,'records/web-jobs'),{recursive:true});
 await writeFile(path.join(directory,'records/web-jobs/old.json'),JSON.stringify({request_id:'old',status:'running',question:'original',requested_session_id:null}));
 let calls=0;const f=await fixture(t,async()=>{calls++;},directory);assert.equal((await f.get('old')).status,'interrupted');
 await f.post({request_id:'old',question:'original'});assert.equal(calls,0);
});

test('web recovery uses the same job and preserves incomplete generation and user action',async t=>{
 const seen=[],session='https://chatgpt.com/c/recovery-session';
 const f=await fixture(t,async input=>{seen.push({id:input.requestId,operation:input.operation});return {session_id:session,status:input.operation==='ask'?'awaiting_user_input':'completed',generation_complete:input.operation!=='ask',generation_status:input.operation==='ask'?'blocked':'completed',answer:input.operation==='ask'?'':'recovered',user_action:{required:input.operation==='ask'}};});
 await f.post({request_id:'recover-one',question:'public',queue:true});const blocked=await f.wait('recover-one');assert.equal(blocked.generation_complete,false);assert.equal(blocked.user_action.required,true);
 const r=await fetch(f.base+'/jobs/recover-one/recover',{method:'POST'});assert.equal(r.status,202);assert.equal((await f.wait('recover-one')).answer,'recovered');
 assert.deepEqual(seen,[{id:'recover-one',operation:'ask'},{id:'recover-one',operation:'recover'}]);
});

test('project metadata stays local, official project URL reaches runner and history is recoverable',async t=>{
 let seen;const project='https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project';
 const f=await fixture(t,async input=>{seen=input;return {session_id:'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/test',answer:'ok',status:'completed',generation_complete:true};});
 const body={request_id:'project-job',question:'approved question',project_id:'project-one',task_id:'task-one',project_name:'Public project',project_url:project,queue:true};
 await f.post(body);await f.wait('project-job');assert.equal(seen.projectUrl,project);assert.equal(seen.question,'approved question');assert.equal(seen.project_name,undefined);
 const history=await(await fetch(f.base+'/history')).json();assert.equal(history.jobs.length,1);assert.equal(history.jobs[0].task_id,'task-one');
 assert.equal((await f.post({...body,project_id:'changed'})).status,409);
 assert.equal((await f.post({...body,request_id:'mismatch',conversation_url:'https://chatgpt.com/c/ordinary'})).status,400);
});

test('history skips a damaged record and does not rescan files on every request',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'history-index-'));const store=path.join(directory,'records/web-jobs');await mkdir(store,{recursive:true});
 await writeFile(path.join(store,'bad.json'),'{broken');await writeFile(path.join(store,'good.json'),JSON.stringify({request_id:'good',status:'completed',project_id:'p',task_id:'t',question:'public',answer:'ok',created_at:'2026-01-01',events:[{text:'large event duplicate'}]}));
 const f=await fixture(t,async()=>{},directory);const first=await(await fetch(f.base+'/history')).json();assert.equal(first.jobs.length,1);assert.equal(first.skipped_records,1);assert.equal(first.jobs[0].events,undefined);
 await writeFile(path.join(store,'good.json'),'{broken after startup');const second=await(await fetch(f.base+'/history')).json();assert.equal(second.jobs[0].answer,'ok');
});
