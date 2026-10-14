import { DeepSeekClient } from './deepseek.mjs';

// Planner transport and worker inference are interchangeable; no workspace tools here.
export function createPlannerAdapter(config, fetcher = fetch) {
  const backend = new URL(config.gpt_backend);
  if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1') throw new Error('GPT_BACKEND_MUST_BE_LOOPBACK');
  if ((config.planner_provider || 'chatgpt-web') !== 'chatgpt-web') throw new Error('UNSUPPORTED_PLANNER_PROVIDER');
  return {
    provider: 'chatgpt-web',
    async request(route, body) {
      let response;
      try { response = await fetcher(new URL(route, backend), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(config.gpt_timeout_ms + 20000) }); }
      catch { throw new Error('GPT_BACKEND_NETWORK_OR_TIMEOUT: 保留请求 ID，稍后恢复'); }
      const result = await response.json();
      if (!result.generation_complete) throw new Error(`GPT_NOT_COMPLETE_${result.status || response.status}`);
      return result;
    }
  };
}
export function createWorkerAdapter(config, directory, fetcher = fetch) {
  if ((config.worker_provider || 'deepseek-api') !== 'deepseek-api') throw new Error('UNSUPPORTED_WORKER_PROVIDER');
  return new DeepSeekClient(config, directory, fetcher);
}
