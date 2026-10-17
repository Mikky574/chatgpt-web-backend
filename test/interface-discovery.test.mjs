import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {safePath,observe} from '../skills/web-interface-discovery/scripts/observe-network.mjs';
test('observation hides query values and common opaque path identifiers',()=>{
 assert.equal(safePath('https://internal.example/jobs/12345?token=private'),'/jobs/:id');
 assert.equal(safePath('https://internal.example/u/person%40example.com/export'),'/u/:id/export');
});
test('passive observer selects exact page, excludes foreign requests and stores metadata only',async()=>{
 const page=new EventEmitter();page.url=()=> 'https://internal.example/work';let closed=0;
 const browser={contexts:()=>[{pages:()=>[page]}],close:async()=>{closed++}};
 const chromium={connectOverCDP:async()=>browser};
 const promise=observe({chromium,cdp:'http://127.0.0.1:9222',pageUrl:page.url(),durationMs:100});
 await new Promise(r=>setImmediate(r));
 const req={url:()=> 'https://internal.example/jobs/123?key=secret-value',method:()=> 'POST',resourceType:()=> 'fetch',postData:()=>assert.fail('body must not be read')};
 page.emit('request',req);page.emit('response',{request:()=>req,status:()=>202,headers:()=>({'content-type':'application/json','set-cookie':'private-cookie'})});page.emit('requestfinished',req);
 page.emit('request',{url:()=> 'https://foreign.example/telemetry'});
 const report=await promise;assert.equal(report.requests.length,1);assert.equal(report.requests[0].http_status,202);assert.equal(closed,1);assert.equal(page.listenerCount('request'),0);assert.ok(!JSON.stringify(report).includes('secret-value'));assert.ok(!JSON.stringify(report).includes('private-cookie'));
});
