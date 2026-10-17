import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBridge,normalizedComposerText,findUserMessageIndex,editablePlainText,browserSubmissionText} from '../bridge.mjs';
test('Markdown address adaptation preserves destinations and custom labels without weakening exact match',()=>{
 const url='http://127.0.0.1:9380/v1/api/status';
 assert.equal(browserSubmissionText(`[${url}](${url})`),url);
 assert.equal(browserSubmissionText('[示例](https://example.test/a?x=1&y=2)'),'示例 — https://example.test/a?x=1&y=2');
 assert.equal(browserSubmissionText('C:/Users/demo/test.txt'), 'C:/Users/demo/test.txt');
 assert.equal(findUserMessageIndex([{role:'user',text:url+' changed'}],url),-1);
});
test('semantic composer reader retains inline URL text and paragraphs without icon layout breaks',()=>{
 const text=value=>({nodeType:3,nodeValue:value});
 const element=(tag,children=[],hidden=false)=>({nodeType:1,tagName:tag,childNodes:children,getAttribute:key=>key==='aria-hidden'&&hidden?'true':null});
 const root=element('DIV',[element('P',[text('公开测试')]),element('P',[element('BR')]),element('P',[text('- curl '),element('SPAN',[element('SPAN',[element('SVG')],true),text('http://example.test/status')]),text(': HTTP 000')])]);
 assert.equal(normalizedComposerText(editablePlainText(root)),normalizedComposerText('公开测试\n\n- curl http://example.test/status: HTTP 000'));
});
test('rich text blank lines match whole content but changed words and shared prefixes do not',()=>{
 const question='公开测试\r\n\r\n## 现象\r\n- 第一项\r\n- 第二项\n';
 const rendered='公开测试\n\n\n## 现象\n\n- 第一项\n\n- 第二项\n';
 assert.equal(normalizedComposerText(question),normalizedComposerText(rendered));
 assert.equal(findUserMessageIndex([{role:'user',text:rendered}],question),0);
 assert.equal(findUserMessageIndex([{role:'user',text:rendered+'另一项'}],question),-1);
 assert.notEqual(normalizedComposerText(rendered.replace('第二项','第三项')),normalizedComposerText(question));
});
test('legacy composer mismatch releases known unsent request without opening default conversation',async()=>{
 const bridge=new BrowserBridge({conversation_url:'https://chatgpt.com/c/unrelated'},async()=>{});bridge.page=async()=>assert.fail('must not navigate');
 const record={request_id:'one',conversation_mode:'new',stage:'filling_composer',before_count:0,question:'public'};
 const result=await bridge.recover(record,async()=>{},1000);assert.equal(result.request_submitted,false);assert.equal(result.conversation_url,undefined);
});
test('uncertain new request without URL cannot fall back to default conversation',async()=>{
 const bridge=new BrowserBridge({conversation_url:'https://chatgpt.com/c/unrelated'},async()=>{});bridge.page=async()=>assert.fail('must not navigate');
 await assert.rejects(bridge.recover({conversation_mode:'new',stage:'submitting',submit_attempted:true},async()=>{},1000),/不回退/);
});
