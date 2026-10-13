import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server.mjs';
import { classifyReply, diagnoseDownload } from '../bridge.mjs';

async function fixture(t, bridge) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gpt-bridge-test-'));
  await writeFile(path.join(directory, 'conversation.json'), JSON.stringify({ conversation_url: null }));
  const server = await createService({ directory, bridge });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  const post = async (route, data) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { directory, base, post };
}

test('completed request is persisted and idempotent, conflicting payload rejected', async t => {
  let calls = 0;
  const bridge = { ask: async r => { calls++; return { ...r, status: 'completed', answer: '网页回答', incomplete: false }; } };
  const { post, directory } = await fixture(t, bridge);
  const input = { request_id: 'same-id', question: '测试' };
  assert.equal((await post('/ask', input)).status, 200);
  assert.equal((await post('/ask', input)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await post('/ask', { ...input, question: '其他问题' })).status, 409);
  const saved = JSON.parse(await readFile(path.join(directory, 'records/same-id.json'), 'utf8'));
  assert.equal(saved.answer, '网页回答');
});

test('timeout blocks new submission, recover reads without submitting again', async t => {
  let submitted = 0;
  const bridge = {
    ask: async (r, persist) => { submitted++; r.before_count = 0; r.status = 'waiting'; await persist(r); return { ...r, status: 'timeout', incomplete: true }; },
    recover: async r => ({ ...r, status: 'completed', answer: '恢复回答', incomplete: false })
  };
  const { post } = await fixture(t, bridge);
  assert.equal((await post('/ask', { request_id: 'first', question: '问题' })).status, 504);
  assert.equal((await post('/ask', { request_id: 'next', question: '新问题' })).status, 409);
  const recovered = await post('/recover', { request_id: 'first' });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).answer, '恢复回答');
  assert.equal(submitted, 1);
});

test('concurrent requests never reach browser together', async t => {
  let release, started;
  const start = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const bridge = { ask: async r => { started(); await wait; return { ...r, status: 'completed', answer: 'ok' }; } };
  const { post } = await fixture(t, bridge);
  const first = post('/ask', { request_id: 'first', question: '问题' });
  await start;
  assert.equal((await post('/ask', { request_id: 'second', question: '另一问题' })).status, 409);
  release();
  assert.equal((await first).status, 200);
});

test('invalid IDs, browser cross-origin calls, and disconnected CDP fail clearly', async t => {
  const bridge = { ask: async () => { const e = new Error('CDP 未连接'); e.status = 'blocked'; throw e; } };
  const { post, base } = await fixture(t, bridge);
  assert.equal((await post('/ask', { request_id: '../escape', question: 'q' })).status, 400);
  assert.equal((await fetch(base + '/health', { headers: { Origin: 'https://example.com' } })).status, 403);
  const blocked = await post('/ask', { request_id: 'blocked', question: 'q' });
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).status, 'blocked');
});

test('new contexts keep their own URLs; continuing them does not use the default', async t => {
  const seen = [];
  const bridge = { ask: async r => { seen.push({ ...r }); return { ...r, conversation_url: r.conversation_url || 'https://chatgpt.com/c/new-context', status: 'completed', generation_complete: true, answer: 'ok' }; } };
  const { post } = await fixture(t, bridge);
  const fresh = await (await post('/ask', { request_id: 'new-one', conversation_mode: 'new', question: 'new' })).json();
  assert.equal(fresh.conversation_url, 'https://chatgpt.com/c/new-context');
  assert.equal(fresh.context_inherited, false);
  const continued = await (await post('/ask', { request_id: 'next-one', conversation_url: fresh.conversation_url, question: 'continue' })).json();
  assert.equal(continued.context_inherited, true);
  assert.equal(seen[1].conversation_url, fresh.conversation_url);
  assert.equal((await post('/ask', { request_id: 'bad', conversation_mode: 'new', conversation_url: fresh.conversation_url, question: 'bad' })).status, 400);
  assert.equal((await post('/ask', { request_id: 'new-one', question: 'new' })).status, 409);
});

test('completed generation awaiting a reply can expose files and accept a follow-up', async t => {
  const bridge = {
    ask: async r => ({ ...r, before_count: 0, status: 'awaiting_user_input', generation_complete: true, incomplete: false, answer: '是否继续？', files: [{ file_id: '0', status: 'available' }] }),
    download: async (r, id, dir) => { const file = r.files.find(f => f.file_id === id); file.local_path = path.join(dir, 'test.txt'); file.status = 'downloaded'; return file; }
  };
  const { post } = await fixture(t, bridge);
  const result = await (await post('/ask', { request_id: 'confirm', question: 'file' })).json();
  assert.equal(result.generation_complete, true);
  assert.equal(result.status, 'awaiting_user_input');
  const download = await post('/download', { request_id: 'confirm', file_id: '0' });
  assert.equal(download.status, 200);
  assert.equal((await download.json()).file.status, 'downloaded');
  assert.equal((await post('/ask', { request_id: 'follow-up', question: 'continue' })).status, 200);
});

test('polling exposes partial output while ask remains active', async t => {
  let release, ready;
  const started = new Promise(r => { ready = r; });
  const waited = new Promise(r => { release = r; });
  const { post, base } = await fixture(t, { ask: async (r, persist) => { r.status = 'waiting'; r.answer = 'partial'; await persist(r); ready(); await waited; return { ...r, status: 'completed', answer: 'complete' }; } });
  const pending = post('/ask', { request_id: 'poll', question: 'q' });
  await started;
  const snapshot = await (await fetch(base + '/records/poll')).json();
  assert.equal(snapshot.answer, 'partial');
  assert.equal(snapshot.status, 'waiting');
  release(); await pending;
});

test('reply action classification retains uncertainty and original prompt', () => {
  const confirmation = classifyReply('文件已经生成。\n是否需要继续生成第二个文件？');
  assert.equal(confirmation.required, true);
  assert.equal(confirmation.kind, 'confirmation');
  assert.equal(confirmation.certainty, 'possible');
  assert.equal(classifyReply('连接成功。').required, false);
  assert.equal(classifyReply('请提供文件名称。').kind, 'clarification');
});

test('403 diagnosis distinguishes challenges, login expiry, and unknown causes', () => {
  assert.equal(diagnoseDownload(403, { 'cf-mitigated': 'challenge' }).category, 'browser_verification');
  assert.equal(diagnoseDownload(403, {}, 'session expired').category, 'login_required');
  assert.equal(diagnoseDownload(403).category, 'unknown_http_rejection');
  assert.equal(diagnoseDownload(403).retryable, false);
  assert.equal(diagnoseDownload(503).retryable, true);
});
