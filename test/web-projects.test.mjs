import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationUrl,projectUrl,projectForConversation} from '../conversation-url.mjs';
import {listProjects,createProject} from '../web-projects.mjs';
const id='g-p-0123456789abcdef0123456789abcdef',project=`https://chatgpt.com/g/${id}/project`;
test('canonical project chat URLs retain project identity, ignore slugs, reject temporary IDs',()=>{
 assert.equal(conversationUrl(`https://chatgpt.com/g/${id}-demo/c/test`),`https://chatgpt.com/g/${id}/c/test`);
 assert.equal(projectUrl(`https://chatgpt.com/g/${id}-demo/project`),project);assert.equal(projectForConversation(`https://chatgpt.com/g/${id}/c/test`),project);
 assert.equal(conversationUrl(`https://chatgpt.com/g/${id}/c/local-chatgpt%3Atemporary`),null);assert.equal(conversationUrl('https://evil.example/c/test'),null);
});
test('official sidebar project discovery deduplicates desktop/mobile rows and reuses exact project name',async()=>{
 const rows=[{id,name:'Public demo'},{id,name:'Public demo'}],page={url:()=> 'https://chatgpt.com/',locator:()=>({evaluateAll:async()=>rows})};
 const bridge={connect:async()=>({contexts:()=>[{pages:()=>[page]}]}),page:async()=>assert.fail('reuse does not open a create dialog')};
 assert.deepEqual(await listProjects(bridge),[{id,name:'Public demo',url:project}]);assert.equal((await createProject(bridge,'Public demo')).reused,true);
});
