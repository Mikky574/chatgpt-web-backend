import test from 'node:test';
import assert from 'node:assert/strict';
import {withGuidance} from '../error-guidance.mjs';
import {createWebRunner} from '../web-runner.mjs';
test('unresolved guidance distinguishes blocking old ID from unsubmitted current question',async()=>{
 const error=withGuidance({error:'unresolved_request',request_id:'old-turn',request_submitted:false,pending:{status:'timeout'}});
 assert.equal(error.guidance.blocking_request_id,'old-turn');assert.equal(error.guidance.next[1].body.request_id,'old-turn');
 const runner=createWebRunner({fetchImpl:async()=>({status:409,json:async()=>error})});
 const result=await runner({requestId:'current-turn',question:'approved',onEvent:()=>{}});
 assert.equal(result.request_id,'current-turn');assert.equal(result.blocking_request_id,'old-turn');assert.equal(result.request_submitted,false);assert.equal(result.guidance.next[1].body.request_id,'old-turn');
});
test('capacity and unknown record guidance do not authorize blind resend',()=>{
 assert.equal(withGuidance({error:'queue_full',request_submitted:false},{port:8789}).guidance.next[0].url,'http://127.0.0.1:8789/health');
 assert.ok(withGuidance({error:'record_not_found'}).guidance.action.includes('不自动重发'));
});
