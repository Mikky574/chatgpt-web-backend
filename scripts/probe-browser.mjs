// Passive inspection only: no navigation, clicks, request replay, headers or bodies.
import {chromium} from 'playwright-core';
const duration=Number(process.argv[2]||0);
if(!Number.isInteger(duration)||duration<0||duration>60000)throw new Error('Observe duration must be 0..60000 ms');
let browser;
try {
  browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:5000});
  const listeners=[];
  for(const [contextIndex,context] of browser.contexts().entries()) {
    for(const [pageIndex,page] of context.pages().entries()) {
      if(!page.url().startsWith('https://chatgpt.com/'))continue;
      console.log(JSON.stringify({type:'page',contextIndex,pageIndex,conversationPage:/\/c\//.test(page.url()),controls:await page.locator('main').evaluateAll(nodes=>({mainCount:nodes.length,composerCount:nodes.reduce((n,e)=>n+e.querySelectorAll('[contenteditable="true"]').length,0),userBubbles:nodes.reduce((n,e)=>n+e.querySelectorAll('[data-user-message-bubble]').length,0),assistantMessages:nodes.reduce((n,e)=>n+e.querySelectorAll('[data-markdown-text-style="assistant-message"]').length,0)}))}));
      const listener=response=>{
        const url=new URL(response.url());if(url.origin!=='https://chatgpt.com')return;
        const request=response.request();if(!['xhr','fetch','eventsource'].includes(request.resourceType()))return;
        const pathname=url.pathname.split('/').map(s=>s.length>24?'<id>':s).join('/');
        console.log(JSON.stringify({type:'network_metadata',contextIndex,pageIndex,method:request.method(),path:pathname,status:response.status()}));
      };
      if(duration){page.on('response',listener);listeners.push([page,listener]);}
    }
  }
  if(duration)await new Promise(resolve=>setTimeout(resolve,duration));
  for(const [page,listener] of listeners)page.off('response',listener);
}catch{console.error('Browser probe unavailable. Start your local CDP browser; no login credentials were read.');process.exitCode=1;}
finally{await browser?.close();}
