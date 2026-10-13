import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DeepSeekClient } from './deepseek.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const workerInstruction = '你是执行侧模型。本版本只有文本推理，没有文件、终端或测试工具。按任务分析并交付文本结果，明确无法执行的操作，不声称运行了测试或修改了代码。不索取密钥，不要求上传私有源码。';
export function parsePlan(answer) {
  const text = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('GPT_PLAN_INVALID_JSON: 请人工检查回复'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['task', 'ask_user', 'finish'].includes(value.action) || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 20000 || Object.keys(value).some(k => !['action', 'content'].includes(k))) throw new Error('GPT_PLAN_INVALID_SCHEMA');
  return value;
}
async function save(file, value) {
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2), 'utf8');
  await rename(file + '.tmp', file);
}
export async function createCoordinator({ directory = root, deepseek: injected, gpt: injectedGpt } = {}) {
  const configFile = path.join(directory, 'coordinator.json');
  let config;
  try { config = JSON.parse(await readFile(configFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; config = JSON.parse(await readFile(path.join(directory, 'coordinator.example.json'), 'utf8')); await save(configFile, config); }
  const backend = new URL(config.gpt_backend);
  if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1') throw new Error('GPT_BACKEND_MUST_BE_LOOPBACK');
  const sessionsDir = path.join(directory, 'records', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const deepseek = injected || new DeepSeekClient(config, directory);
  const locks = new Set();
  const read = async id => { try { return JSON.parse(await readFile(path.join(sessionsDir, id + '.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const persist = async session => { session.updated_at = new Date().toISOString(); await save(path.join(sessionsDir, session.session_id + '.json'), session); };
  const gpt = injectedGpt || (async (route, body) => {
    let response;
    try { response = await fetch(new URL(route, backend), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(config.gpt_timeout_ms + 20000) }); }
    catch { throw new Error('GPT_BACKEND_NETWORK_OR_TIMEOUT: 保留请求 ID，稍后恢复'); }
    const result = await response.json();
    if (!result.generation_complete) throw new Error(`GPT_NOT_COMPLETE_${result.status || response.status}`);
    return result;
  });
  async function step(session) {
    if (['finished', 'awaiting_user'].includes(session.status)) return session;
    if (session.round >= session.max_rounds && session.phase !== 'execute') { session.status = 'round_limit'; await persist(session); return session; }
    session.status = 'running'; delete session.error;
    try {
      if (!(await deepseek.status()).configured) throw new Error('DEEPSEEK_KEY_MISSING: 请先填写本地密钥文件');
      if (session.phase === 'plan') {
        const newRequest = !session.gpt_request_id;
        session.gpt_request_id ||= `${session.session_id}-r${session.round}`;
        const feedback = session.history.filter(h => h.role === 'deepseek' || h.role === 'user').slice(-1)[0]?.content || null;
        const question = `你是规划主控，DeepSeek 是文本执行侧。本版本无代码/终端/文件工具，不能声称运行测试。仅处理用户提供的公开或合成内容。请严格只输出一个 JSON 对象：{"action":"task|ask_user|finish","content":"任务或用户问题或最终结论"}。一次只给一个文本任务；需要用户选择则 ask_user；目标满足则 finish。不要要求密钥、文件上传或私人源码。\n${JSON.stringify({ goal: session.goal, round: session.round, max_rounds: session.max_rounds, feedback })}`;
        await persist(session);
        const result = await gpt(newRequest ? '/ask' : '/recover', newRequest ? { request_id: session.gpt_request_id, question, conversation_mode: session.conversation_url ? 'continue' : 'new', ...(session.conversation_url ? { conversation_url: session.conversation_url } : {}), timeout_ms: config.gpt_timeout_ms } : { request_id: session.gpt_request_id, timeout_ms: config.gpt_timeout_ms });
        session.conversation_url = result.conversation_url;
        session.history.push({ role: 'gpt', content: result.answer, request_id: session.gpt_request_id });
        session.plan = parsePlan(result.answer);
        if (session.plan.action === 'finish') session.status = 'finished';
        else if (session.plan.action === 'ask_user') session.status = 'awaiting_user';
        else session.phase = 'execute';
        await persist(session);
      }
      if (session.phase === 'execute' && session.status === 'running') {
        session.deepseek_call_started = true;
        await persist(session);
        const result = await deepseek.complete([{ role: 'system', content: workerInstruction }, { role: 'user', content: `本会话目标：${session.goal}` }, ...session.deepseek_messages, { role: 'user', content: session.plan.content }]);
        session.deepseek_result = result;
        if (!result.complete) throw new Error(`DEEPSEEK_INCOMPLETE_${result.finish_reason}`);
        session.deepseek_messages.push({ role: 'user', content: session.plan.content }, { role: 'assistant', content: result.answer });
        session.history.push({ role: 'deepseek', content: result.answer, usage: result.usage });
        session.round++; session.phase = 'plan'; session.gpt_request_id = null; session.deepseek_call_started = false;
        session.status = session.round >= session.max_rounds ? 'round_limit' : 'ready';
      }
    } catch (e) { session.status = 'blocked'; session.error = e.message; }
    await persist(session);
    return session;
  }
  return http.createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site' || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'loopback_program_calls_only' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { service: 'gpt-deepseek-coordinator' });
      if (req.method === 'GET' && url.pathname === '/deepseek/status') return send(200, await deepseek.status());
      const match = url.pathname.match(/^\/sessions\/([a-zA-Z0-9_-]{1,80})(?:\/(step|reply))?$/);
      if (req.method === 'GET' && match && !match[2]) { const s = await read(match[1]); return send(s ? 200 : 404, s || { error: 'session_not_found' }); }
      if (req.method !== 'POST' || !(url.pathname === '/sessions' || url.pathname === '/deepseek/ask' || match?.[2])) return send(404, { error: 'not_found' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use application/json' });
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) return send(413, { error: 'body_too_large' }); }
      let input; try { input = JSON.parse(body); } catch { return send(400, { error: 'invalid_json' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'invalid_body' });
      if (url.pathname === '/deepseek/ask') {
        if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 20000) return send(400, { error: 'invalid_question' });
        try { return send(200, await deepseek.complete([{ role: 'user', content: input.question }])); }
        catch (e) { return send(503, { error: e.message }); }
      }
      if (url.pathname === '/sessions') {
        const id = input.session_id ?? randomUUID();
        if (!validId(id) || id.length > 64 || typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 15000) return send(400, { error: 'invalid_session_or_goal' });
        const maxRounds = input.max_rounds ?? config.max_rounds;
        if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) return send(400, { error: 'max_rounds must be 1..10' });
        if (locks.has(id)) return send(409, { error: 'busy' });
        locks.add(id);
        try {
          if (await read(id)) return send(409, { error: 'session_exists' });
          const s = { session_id: id, goal: input.goal, max_rounds: maxRounds, round: 0, phase: 'plan', status: 'ready', conversation_url: null, deepseek_messages: [], history: [], created_at: new Date().toISOString() };
          await persist(s); return send(201, s);
        } finally { locks.delete(id); }
      }
      const id = match[1];
      if (locks.has(id)) return send(409, { error: 'busy' });
      locks.add(id);
      try {
        const session = await read(id); if (!session) return send(404, { error: 'session_not_found' });
        if (match[2] === 'reply') {
          if (session.status !== 'awaiting_user' || typeof input.reply !== 'string' || !input.reply.trim() || input.reply.length > 15000) return send(409, { error: 'not_awaiting_user_or_invalid_reply' });
          session.history.push({ role: 'user', content: input.reply }); session.status = 'ready'; session.gpt_request_id = null; await persist(session); return send(200, session);
        }
        if (session.deepseek_call_started) {
          if (input.retry_deepseek !== true) return send(409, { error: 'deepseek_previous_call_uncertain', retry_requires_explicit_flag: true });
          session.deepseek_call_started = false;
        }
        if (session.status === 'running') session.status = 'blocked';
        return send(200, await step(session));
      } finally { locks.delete(id); }
    } catch { send(500, { error: 'coordinator_internal_error' }); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createCoordinator();
  server.listen(Number(process.env.COORDINATOR_PORT || 8788), '127.0.0.1', () => console.log('Coordinator: http://127.0.0.1:8788'));
}
