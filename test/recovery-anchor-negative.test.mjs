import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBridge, findUserMessageIndex } from '../bridge.mjs';

const URL = 'https://chatgpt.com/c/6acef171-a47c-83ee-a996-7851e2d59324';
// Requests A and B share this exact body prefix; only the tail and the message
// id differ, so any prefix-level match would select the wrong request.
const PREFIX = '请确认本次重试的验收检查项与合并策略是否一致';
const QUESTION_A = `${PREFIX}，另外补充A侧第二点`;
const QUESTION_B = `${PREFIX}，另外补充B侧第二点`;
const ANSWER_A = '这是A请求的回答，不得当作B的恢复结果。';

// Records every locator lookup and any text input so the test can prove the
// recovery path neither reads neighbour text nor resubmits anything.
function spyPage(url, messages) {
  const actions = { selectors: [], typed: 0, submitted: 0 };
  const handle = {
    evaluateAll: async () => [],
    isVisible: async () => false,
    count: async () => 0,
    filter() { return this; },
    last() { return this; },
    first() { return this; },
    locator() { return this; },
    fill: async () => { actions.typed += 1; },
    press: async () => { actions.submitted += 1; },
  };
  const page = { url: () => url, locator(selector) { actions.selectors.push(selector); return handle; } };
  return { page, actions, messages };
}

function runRecovery(page, messages, record) {
  const bridge = new BrowserBridge({ conversation_url: URL }, async () => {});
  bridge.pin = async () => {};
  bridge.messages = async () => messages;
  bridge.files = async () => [];
  return bridge.wait(page, record, async () => {}, 8000);
}

test('shared-prefix recovery blocks when the anchored message is missing instead of reading the neighbour request', async () => {
  // DOM holds only request A (user bubble + its answer); B was saved earlier.
  const dom = [
    { role: 'user', text: QUESTION_A, complete: true, message_id: 'a-user' },
    { role: 'assistant', text: ANSWER_A, complete: true, message_id: 'a-answer' },
  ];
  const { page, actions } = spyPage(URL, dom);
  const record = { conversation_url: URL, question: QUESTION_B, user_message_id: 'b-user', before_count: 0, status: 'waiting' };

  await assert.rejects(runRecovery(page, dom, record), error => {
    assert.match(error.message, /未加载本次用户消息/);
    assert.equal(error.message.includes(ANSWER_A), false, 'blocked result must not carry the neighbour answer');
    assert.equal(error.message.includes(QUESTION_A), false, 'blocked result must not carry the neighbour question');
    return true;
  });

  assert.equal(record.status, 'waiting', 'blocked recovery must not report a completed turn');
  assert.notEqual(record.generation_complete, true);
  assert.equal(record.answer, undefined, 'neighbour answer must never be returned');
  assert.equal(actions.typed, 0, 'recovery must not type');
  assert.equal(actions.submitted, 0, 'recovery must not resubmit');
  assert.equal(actions.selectors.some(selector => /contenteditable|textbox/.test(selector)), false, 'recovery must not touch the input box');
});

test('strict matching rejects the neighbour request despite the shared prefix', () => {
  const dom = [{ role: 'user', text: QUESTION_A, message_id: 'a-user' }];
  assert.equal(findUserMessageIndex(dom, QUESTION_B), -1, 'different tail must not match A');
  assert.equal(findUserMessageIndex(dom, PREFIX), -1, 'a bare shared prefix must not match A');
});

test('positive control: the same path reads B when its anchored message is present', async () => {
  const dom = [
    { role: 'user', text: QUESTION_A, complete: true, message_id: 'a-user' },
    { role: 'assistant', text: ANSWER_A, complete: true, message_id: 'a-answer' },
    { role: 'user', text: QUESTION_B, complete: true, message_id: 'b-user' },
    { role: 'assistant', text: 'B的回答', complete: true, message_id: 'b-answer' },
  ];
  const { page } = spyPage(URL, dom);
  const record = { conversation_url: URL, question: QUESTION_B, user_message_id: 'b-user', before_count: 0, status: 'waiting' };

  const result = await runRecovery(page, dom, record);
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'B的回答');
  assert.notEqual(result.answer, ANSWER_A);
  assert.equal(result.user_message_id, 'b-user');
});
