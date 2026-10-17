import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BrowserBridge } from './bridge.mjs';
import {conversationUrl,projectUrl,projectForConversation} from './conversation-url.mjs';
import {listProjects,createProject} from './web-projects.mjs';
import {withGuidance} from './error-guidance.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
async function atomicJson(file, value) {
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, file);
}
export async function createService({ directory = root, bridge: injected } = {}) {
  const configFile = path.join(directory, 'conversation.json');
  let config;
  try { config = JSON.parse(await readFile(configFile, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    config = JSON.parse(await readFile(path.join(directory, 'conversation.example.json'), 'utf8'));
    await atomicJson(configFile, config);
  }
  const records = path.join(directory, 'records');
  await mkdir(records, { recursive: true });
  const bridge = injected || new BrowserBridge(config, value => atomicJson(configFile, value));
  let busy = false;
  let active = null;
  const busyState=()=>active?{...active,elapsed_ms:Date.now()-active.started_at_ms}:null;
  const read = async id => {
    try { return JSON.parse(await readFile(path.join(records, id + '.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const persist = async record => {
    record.updated_at = new Date().toISOString();
    if (!record.conversation_url && record.conversation_mode !== 'new'&&!record.context_reset_pending) record.conversation_url = config.conversation_url;
    record.record_path = path.join(records, record.request_id + '.json');
    await atomicJson(record.record_path, record);
    await writeFile(path.join(records, record.request_id + '.md'), `# ${record.request_id}\n\n状态：${record.status}\n\n对话：${record.conversation_url || '尚未建立'}\n\n## 问题\n\n${record.question}\n\n## 回答\n\n${record.answer || ''}\n`, 'utf8');
  };
  return http.createServer(async (req, res) => {
    let ownsLock = false;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(withGuidance(body))); };
    // Reject cross-site browser requests; server only binds loopback.
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Browser cross-origin calls are not accepted' });
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')) return send(403, { error: 'Use 127.0.0.1' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { service: 'chatgpt-web-backend', busy, active:busyState() });
      if (req.method === 'GET' && url.pathname === '/status') return send(200, { ...await bridge.status(), busy, active:busyState() });
      if(req.method==='GET'&&url.pathname==='/projects')return send(200,{projects:await listProjects(bridge)});
      const recordMatch = url.pathname.match(/^\/records\/([a-zA-Z0-9_-]{1,80})$/);
      if (req.method === 'GET' && recordMatch) { const record = await read(recordMatch[1]); return send(record ? 200 : 404, record || { error: 'record_not_found' }); }
      if (req.method !== 'POST' || !['/ask', '/recover', '/download', '/files','/projects'].includes(url.pathname)) return send(404, { error: 'not_found' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use application/json' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) return send(413, { error: 'body_too_large' }); }
      let input;
      try { input = JSON.parse(body); } catch { return send(400, { error: 'invalid_json' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'invalid_body' });
      const id = input.request_id ?? randomUUID();
      if (!validId(id)) return send(400, { error: 'invalid_request_id' });
      if (!['/ask','/projects'].includes(url.pathname) && !input.request_id) return send(400, { error: 'request_id_required' });
      if(input.force_new!==undefined&&typeof input.force_new!=='boolean')return send(400,{error:'force_new must be boolean',request_submitted:false});
      if(input.force_new&&(url.pathname!=='/ask'||input.conversation_url||(input.conversation_mode&&input.conversation_mode!=='new')))return send(400,{error:'force_new requires ask without conversation_url or continue mode',request_submitted:false});
      const mode = input.force_new?'new':input.conversation_mode ?? 'continue';
      if (!['continue', 'new'].includes(mode)) return send(400, { error: 'conversation_mode must be continue or new' });
      if (input.conversation_url && !conversationUrl(input.conversation_url)) return send(400, { error: 'invalid_conversation_url' });
      if(input.project_url&&!projectUrl(input.project_url))return send(400,{error:'invalid_project_url'});
      if(input.conversation_url)input.conversation_url=conversationUrl(input.conversation_url);
      if(input.project_url)input.project_url=projectUrl(input.project_url);
      if(input.project_url&&input.conversation_url&&projectForConversation(input.conversation_url)!==input.project_url)return send(400,{error:'project_conversation_mismatch'});
      if (mode === 'new' && input.conversation_url) return send(400, { error: 'new mode cannot specify conversation_url' });
      const timeout = input.timeout_ms ?? 120000;
      if(input.retry_generation !== undefined && typeof input.retry_generation !== 'boolean') return send(400,{error:'retry_generation must be boolean'});
      if(input.retry_generation && url.pathname!=='/recover') return send(400,{error:'retry_generation is only accepted by recover'});
      if(input.refresh_page!==undefined && typeof input.refresh_page!=='boolean')return send(400,{error:'refresh_page must be boolean'});
      if(input.refresh_page && (url.pathname!=='/recover'||input.retry_generation))return send(400,{error:'refresh_page requires recover without retry_generation'});
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) return send(400, { error: 'timeout_ms must be 1000..600000' });
      const waitForSlot=input.wait_for_slot_ms ?? 0;
      if(!Number.isInteger(waitForSlot)||waitForSlot<0||waitForSlot>15000)return send(400,{error:'wait_for_slot_ms must be 0..15000'});
      const slotDeadline=Date.now()+waitForSlot;
      while(busy && Date.now()<slotDeadline)await new Promise(resolve=>setTimeout(resolve,50));
      if(res.destroyed)return;
      if (busy) return send(409, { error: 'busy', category:'browser_transport_in_use', retry_after_ms:1000, active:busyState(), request_submitted:false });
      busy = true;
      active={request_id:id,operation:url.pathname,started_at_ms:Date.now()};
      ownsLock = true;
      if(url.pathname==='/projects')return send(200,{project:await createProject(bridge,input.name)});
      let record = await read(id);
      if (record && url.pathname === '/ask' && record.question !== input.question) return send(409, { error: 'request_id_conflict' });
      if (record && url.pathname === '/ask' && ((record.conversation_mode || 'continue') !== mode || (input.conversation_url && input.conversation_url !== (record.context_reset?.from_url||record.conversation_url)))) return send(409, { error: 'request_context_conflict' });
      if (url.pathname === '/files') {
        if (!record) return send(404, { error: 'record_not_found' });
        if (!record.generation_complete) return send(409, { error: 'generation_not_complete' });
        try {
          const files = await bridge.files(await bridge.page(record), record);
          record.files = files.map(file => { const old = record.files?.find(f => f.source === file.source && f.label === file.label && f.href === file.href); return old?.local_path ? { ...file, local_path: old.local_path, status: 'downloaded' } : file; });
          await persist(record);
          return send(200, { request_id: id, files: record.files });
        } catch (e) { return send(503, { error: e.message }); }
      }
      if (url.pathname === '/download') {
        if (!record) return send(404, { error: 'record_not_found' });
        if (!record.generation_complete) return send(409, { error: 'generation_not_complete' });
        if (typeof input.file_id !== 'string' || !/^\d+$/.test(input.file_id)) return send(400, { error: 'invalid_file_id' });
        try {
          const file = await bridge.download(record, input.file_id, path.join(records, id, 'downloads'));
          await persist(record);
          return send(200, { request_id: id, file });
        } catch (e) {
          const file = record.files?.find(f => f.file_id === input.file_id);
          if (file) { file.status = 'failed'; file.error = e.message; file.diagnostics = e.diagnostics || null; await persist(record); }
          return send(503, { status: e.status || 'failed', error: e.message, request_id: id, file });
        }
      }
      if (record?.status === 'completed' || (record?.status === 'awaiting_user_input' && record.generation_complete)) return send(200, record);
      if (url.pathname === '/ask' && record) return send(409, { error: 'Use /recover for this request_id', record });
      if (url.pathname === '/recover' && !record) return send(404, { error: 'record_not_found' });
      // An unresolved submission blocks new questions until it is recovered.
      const { readdir } = await import('node:fs/promises');
      if (url.pathname === '/ask') {
        for (const name of await readdir(records)) {
          if (!name.endsWith('.json')) continue;
          const pending = await read(name.slice(0, -5));
          const targetUrl = input.conversation_url || config.conversation_url;
          const sameContext = mode !== 'new' && (pending?.conversation_url?conversationUrl(pending.conversation_url)===conversationUrl(targetUrl):!targetUrl);
          if (sameContext && pending && pending.before_count !== undefined && pending.status !== 'completed' && !pending.generation_complete) return send(409, {
            error:'unresolved_request',request_id:pending.request_id,request_submitted:false,
            pending:{status:pending.status,stage:pending.stage||null,conversation_url:pending.conversation_url||null,submission_confirmed:pending.submission_confirmed===true,answer_chars:pending.answer?.length||0,updated_at:pending.updated_at||null,error:pending.error||null},
            recovery:{method:'POST',path:'/recover',body:{request_id:pending.request_id,timeout_ms:120000}},
            new_conversation:{conversation_mode:'new',requires_new_request_id:true,context_inherited:false},
            message:'本次问题未发送。先恢复旧请求；若要独立新会话，使用新request_id及conversation_mode=new。旧请求保留，不自动重发。'
          });
        }
      }
      if (!record && (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 30000)) return send(400, { error: 'question must be 1..30000 characters' });
      record ||= { request_id: id, conversation_mode: mode, conversation_url: input.conversation_url || (mode === 'continue' ? config.conversation_url : null), context_inherited: mode === 'continue' && !!(input.conversation_url || config.conversation_url), question: input.question, answer: '', status: 'pending', incomplete: true, generation_status: 'not_started', generation_complete: false, user_action: { required: false, kind: 'none', source: 'not_evaluated', certainty: 'unknown' }, files: [], task_complete: null, created_at: new Date().toISOString() };
      if(input.project_url)record.project_url=projectUrl(input.project_url);
      record.project_url||=projectForConversation(record.conversation_url)||undefined;
      if (url.pathname === '/recover' && record.before_count === undefined) return send(409, { error: 'Request was never submitted; use a new request_id' });
      try {
        await persist(record);
        record = url.pathname === '/ask' ? await bridge.ask(record, persist, timeout) : input.retry_generation ? await bridge.retry(record,persist,timeout) : await bridge.recover(record, persist, timeout,{refreshPage:input.refresh_page===true});
      } catch (e) { record.status = e.status || 'failed'; record.error = e.message; record.incomplete = true; }
      finally { await persist(record); }
      return send(['completed', 'awaiting_user_input'].includes(record.status) ? 200 : record.status === 'timeout' ? 504 : 503, record);
    } catch (e) { send(500, { error: e.message }); }
    finally { if (ownsLock) {busy = false;active=null;} }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const service = await createService();
  service.listen(port, '127.0.0.1', () => console.log(`ChatGPT web backend: http://127.0.0.1:${port}`));
}
