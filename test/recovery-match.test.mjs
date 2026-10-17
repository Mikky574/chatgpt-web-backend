import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBridge, COLLAPSE_CONTROL, findUserMessageIndex, userMessageText, isTurnComplete } from '../bridge.mjs';

const URL = 'https://chatgpt.com/c/6acee7d0-3220-83ee-a7a5-3aed9afa7eb3';
const QUESTION = '你是主控手，负责需求决策与验收建议；操作手负责本地实施与实际测试。\n{\n  "task_id": "demo"\n}';

// Minimal duck-typed DOM so the reader can be tested without a browser.
class FakeButton {
  constructor(label, { aria = null } = {}) { this.innerText = label; this.style = { display: '' }; this.attrs = aria ? { 'aria-label': aria } : {}; }
  getAttribute(name) { return this.attrs[name] ?? null; }
}
class FakeBubble {
  constructor(body, controls = []) { this.body = body; this.controls = controls; }
  querySelectorAll() { return this.controls; }
  get innerText() {
    const visible = this.controls.filter(c => c.style.display !== 'none').map(c => c.innerText);
    return visible.length ? `${this.body}\n${visible.join('\n')}` : this.body;
  }
}

test('collapse-control label set matches toggle buttons, not arbitrary prose', () => {
  for (const label of ['收起', '展开', '显示更多', '显示更少', 'Show less', 'Show more']) assert.equal(COLLAPSE_CONTROL.test(label), true, label);
  for (const body of ['请帮我确认', '收起这个词在正文里', 'more', 'less is more', '']) assert.equal(COLLAPSE_CONTROL.test(body), false, body);
});

test('DOM reader hides the toggle button but keeps the author text, even a literal 收起', () => {
  const body = '正文里我自己写了收起这个词，它不是按钮，必须保留。';
  const bubble = new FakeBubble(body, [new FakeButton('收起')]);
  const text = userMessageText(bubble, COLLAPSE_CONTROL);
  assert.equal(text, body);
  assert.equal(text.includes('收起'), true);
  assert.equal(bubble.controls[0].style.display, '', 'control display restored after reading');
});

test('DOM reader leaves a bubble with no toggle control untouched', () => {
  const bubble = new FakeBubble('一段普通用户消息\n收起');
  assert.equal(userMessageText(bubble, COLLAPSE_CONTROL), '一段普通用户消息\n收起');
});

test('aria-hidden SVG without innerText does not crash either live reader or helper',async()=>{
 const svg={textContent:'',style:{display:''},getAttribute:name=>name==='aria-hidden'?'true':null};
 const bubble=new FakeBubble('完整合成回答',[svg]);
 assert.doesNotThrow(()=>userMessageText(bubble,COLLAPSE_CONTROL));
 const node={innerText:'完整合成回答',querySelectorAll:()=>[svg],hasAttribute:()=>false,closest:()=>null};
 const locator={last(){return this},locator(){return this},count:async()=>1,evaluateAll:async(fn,arg)=>fn([node],arg)};
 const bridge=new BrowserBridge({},async()=>{});const result=await bridge.messages({locator:()=>locator});
 assert.equal(result[0].text,'完整合成回答');assert.equal(result[0].role,'assistant');
});

test('anchored reader does not materialize earlier historical answers',async()=>{
 const old={hasAttribute:()=>false, get innerText(){assert.fail('old history text must not be read');}};
 const current={hasAttribute:name=>name==='data-user-message-bubble',closest:()=>({getAttribute:()=> 'current-u'}),cloneNode:()=>({querySelectorAll:()=>[],textContent:'current question'}),querySelectorAll:()=>[],innerText:'current question'};
 const answer={hasAttribute:()=>false,closest:()=>null,querySelectorAll:()=>[],innerText:'current answer'};
 const locator={last(){return this},locator(){return this},count:async()=>3,evaluateAll:async(fn,arg)=>fn([old,current,answer],arg)};
 const b=new BrowserBridge({},async()=>{});const messages=await b.messages({locator:()=>locator},'current-u');assert.equal(messages.length,2);assert.equal(messages[1].text,'current answer');
});

test('strict matching accepts the filtered bubble and rejects shared-prefix prompts', () => {
  const bubble = new FakeBubble(QUESTION, [new FakeButton('收起')]);
  const messages = [
    { role: 'user', text: '上一轮的旧问题', message_id: 'old-u' },
    { role: 'assistant', text: '上一轮的旧回答', message_id: 'old-a' },
    { role: 'user', text: userMessageText(bubble, COLLAPSE_CONTROL), message_id: 'u1' },
  ];
  assert.equal(findUserMessageIndex(messages, QUESTION), 2);
  // Noise between rendering and sending must not be matched loosely.
  assert.equal(findUserMessageIndex([{ role: 'user', text: `${QUESTION}\n收起` }], QUESTION), -1);
  const shared = '请确认本次发布的验收检查项与合并策略是否一致';
  assert.equal(findUserMessageIndex([{ role: 'user', text: `${shared}，另外补充第二点` }], shared), -1);
  assert.equal(findUserMessageIndex(messages, '完全无关的另一条消息'), -1);
});

test('completion needs an explicit turn signal; a quiet stall never completes', () => {
  const base = { answer: '好的', generating: false, conversationUrl: URL, stable: 2 };
  assert.equal(isTurnComplete({ ...base, turnComplete: true }), true);
  assert.equal(isTurnComplete({ ...base, hasLegacyControls: true }), true);
  assert.equal(isTurnComplete(base), false);
  assert.equal(isTurnComplete({ ...base, stable: 9 }), false);
  assert.equal(isTurnComplete({ ...base, turnComplete: true, generating: true }), false);
  assert.equal(isTurnComplete({ ...base, turnComplete: true, answer: '' }), false);
  assert.equal(isTurnComplete({ ...base, turnComplete: true, conversationUrl: null }), false);
});

function stubPage(url) {
  const locator = () => ({ evaluateAll: async () => [], isVisible: async () => false, count: async () => 0, filter() { return this; }, last() { return this; }, locator() { return this; } });
  return { url: () => url, locator };
}

async function recoverWith(messages, record = {}) {
  const bridge = new BrowserBridge({ conversation_url: URL }, async () => {});
  bridge.pin = async () => {};
  bridge.messages = async () => messages;
  bridge.files = async () => [];
  const target = { conversation_url: URL, question: QUESTION, before_count: 0, status: 'waiting', ...record };
  return bridge.wait(stubPage(URL), target, async () => {}, 8000);
}

test('recover reads the existing answer once the toggle label is filtered out', async () => {
  // Regression for request 7560b982: the bubble carried a trailing "收起" label.
  const filtered = userMessageText(new FakeBubble(QUESTION, [new FakeButton('收起')]), COLLAPSE_CONTROL);
  const result = await recoverWith([
    { role: 'user', text: filtered, complete: true, message_id: 'u1' },
    { role: 'assistant', text: '这是主控手已经给出的回答。', complete: true, message_id: 'a1' },
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(result.generation_complete, true);
  assert.equal(result.answer, '这是主控手已经给出的回答。');
  assert.equal(result.user_message_id, 'u1');
});

test('recover never returns a previous turn as this turn answer', async () => {
  const result = await recoverWith([
    { role: 'user', text: '旧问题', complete: true, message_id: 'old-u' },
    { role: 'assistant', text: '旧回答不能当成本轮答案', complete: true, message_id: 'old-a' },
    { role: 'user', text: QUESTION, complete: true, message_id: 'u1' },
    { role: 'assistant', text: '本轮回答', complete: true, message_id: 'a1' },
  ]);
  assert.equal(result.answer, '本轮回答');
  assert.equal(result.user_message_id, 'u1');
});

test('recover stops when a later user message makes the turn ambiguous', async () => {
  await assert.rejects(
    recoverWith([
      { role: 'user', text: QUESTION, complete: true, message_id: 'u1' },
      { role: 'assistant', text: '部分回答', complete: false, message_id: 'a1' },
      { role: 'user', text: '另一个用户消息', complete: false, message_id: 'u2' },
    ]),
    /其他用户消息/
  );
});
