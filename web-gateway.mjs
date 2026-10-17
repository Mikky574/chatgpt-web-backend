import {createJobService} from './job-server.mjs';
import {createWebRunner} from './web-runner.mjs';
const projects=async name=>{const r=await fetch('http://127.0.0.1:8787/projects',name?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name}),signal:AbortSignal.timeout(60000)}:{signal:AbortSignal.timeout(10000)});const data=await r.json();if(!r.ok)throw Error(data.error||'PROJECT_SERVICE_UNAVAILABLE');return data;};
const server=await createJobService({runner:createWebRunner(),maxConcurrency:1,projects});
server.listen(Number(process.env.CHAT_UI_PORT||8789),'127.0.0.1',()=>console.log('ChatGPT web chat: http://127.0.0.1:8789/ (browser-backed, no CLI inference)'));
