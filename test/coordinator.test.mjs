import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCoordinator, parsePlan } from '../coordinator.mjs';
import { DeepSeekClient } from '../deepseek.mjs';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-test-'));
  await writeFile(path.join(directory, 'coordinator.json'), JSON.stringify({ gpt_backend: 'http://127.0.0.1:8787', max_rounds: 4 }));
  const deepseek = { status: async () => ({ configured: true }), complete: async () => ({ answer: '执行侧报告', complete: true, finish_reason: 'stop', usage: {} }), ...overrides.deepseek };
  const server = await createCoordinator({ directory, deepseek, gpt: overrides.gpt });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => { const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, value: await r.json() }; };
  return { post, base };
}

test('GPT delegates to DeepSeek, then receives feedback in same conversation and finishes', async t => {
  const calls = [];
  const f = await fixture(t, { gpt: async (route, body) => { calls.push(body); return { generation_complete: true, conversation_url: 'https://chatgpt.com/c/testing', answer: JSON.stringify(calls.length === 1 ? { action: 'task', content: '设计测试' } : { action: 'finish', content: '完成' }) }; } });
  await f.post('/sessions', { session_id: 'loop', goal: '公开需求' });
  const first = await f.post('/sessions/loop/step', {});
  assert.equal(first.value.status, 'ready'); assert.equal(first.value.round, 1);
  const second = await f.post('/sessions/loop/step', {});
  assert.equal(second.value.status, 'finished');
  assert.equal(calls[0].conversation_mode, 'new');
  assert.equal(calls[1].conversation_mode, 'continue');
  assert.equal(calls[1].conversation_url, 'https://chatgpt.com/c/testing');
  assert.match(calls[1].question, /执行侧报告/);
});

test('user questions stop execution until explicit reply', async t => {
  let executions = 0;
  const f = await fixture(t, { deepseek: { complete: async () => { executions++; } }, gpt: async () => ({ conversation_url: 'https://chatgpt.com/c/testing', answer: '{"action":"ask_user","content":"请选择方案"}' }) });
  await f.post('/sessions', { session_id: 'ask', goal: 'goal' });
  assert.equal((await f.post('/sessions/ask/step', {})).value.status, 'awaiting_user');
  await f.post('/sessions/ask/step', {}); assert.equal(executions, 0);
  assert.equal((await f.post('/sessions/ask/reply', { reply: '方案A' })).value.status, 'ready');
});

test('uncertain DeepSeek requests require explicit retry and never duplicate GPT task', async t => {
  let plans = 0;
  const f = await fixture(t, { gpt: async () => { plans++; return { conversation_url: 'https://chatgpt.com/c/testing', answer: '{"action":"task","content":"分析"}' }; }, deepseek: { complete: async () => { throw new Error('DEEPSEEK_NETWORK_OR_TIMEOUT'); } } });
  await f.post('/sessions', { session_id: 'retry', goal: 'goal' });
  assert.equal((await f.post('/sessions/retry/step', {})).value.status, 'blocked');
  assert.equal((await f.post('/sessions/retry/step', {})).status, 409);
  await f.post('/sessions/retry/step', { retry_deepseek: true });
  assert.equal(plans, 1);
});

test('key missing stops before calling GPT; round limit stops repeated delegation', async t => {
  let calls = 0;
  const missing = await fixture(t, { deepseek: { status: async () => ({ configured: false }) }, gpt: async () => { calls++; } });
  await missing.post('/sessions', { session_id: 'missing', goal: 'goal' });
  assert.equal((await missing.post('/sessions/missing/step', {})).value.status, 'blocked'); assert.equal(calls, 0);
  const limited = await fixture(t, { gpt: async () => ({ conversation_url: 'https://chatgpt.com/c/testing', answer: '{"action":"task","content":"分析"}' }) });
  await limited.post('/sessions', { session_id: 'limited', goal: 'goal', max_rounds: 1 });
  assert.equal((await limited.post('/sessions/limited/step', {})).value.status, 'round_limit');
});

test('native DeepSeek client does not expose credentials or upstream errors', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepseek-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const key = 'test-secret-fixture-only'; await writeFile(path.join(directory, 'key.txt'), key);
  const config = { deepseek_key_file: 'key.txt', deepseek_model: 'test-model', deepseek_max_tokens: 100, deepseek_timeout_ms: 1000 };
  const client = new DeepSeekClient(config, directory, async (url, request) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
    return new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content: `answer ${key}` }, finish_reason: 'stop' }], usage: { total_tokens: 10, unexpected_secret: key } }));
  });
  assert.equal((await client.status()).configured, true);
  const result = await client.complete([{ role: 'user', content: 'hello' }]);
  assert.ok(!JSON.stringify(result).includes(key)); assert.equal(result.complete, true);
  const rejected = new DeepSeekClient(config, directory, async () => new Response(key, { status: 401 }));
  await assert.rejects(rejected.complete([]), error => /HTTP_401/.test(error.message) && !error.message.includes(key));
});

test('GPT control schema rejects arbitrary tool actions and malformed output', () => {
  assert.throws(() => parsePlan('{"action":"shell","content":"command"}'));
  assert.throws(() => parsePlan('non-json'));
  assert.throws(() => parsePlan('{"action":"task","content":"x","upload":"private"}'));
});
