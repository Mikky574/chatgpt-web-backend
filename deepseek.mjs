import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class DeepSeekClient {
  constructor(config, directory, fetcher = fetch) { this.config = config; this.directory = directory; this.fetcher = fetcher; }
  async key() {
    let value = process.env.DEEPSEEK_API_KEY;
    if (!value) {
      try { value = await readFile(path.resolve(this.directory, this.config.deepseek_key_file), 'utf8'); }
      catch { throw new Error('DEEPSEEK_KEY_MISSING: 请在本地密钥文件填入密钥'); }
    }
    value = value.trim();
    if (!value || /[\r\n]/.test(value)) throw new Error('DEEPSEEK_KEY_MISSING_OR_INVALID');
    return value;
  }
  async status() {
    try { await this.key(); return { configured: true, model: this.config.deepseek_model, authenticated: null }; }
    catch { return { configured: false, model: this.config.deepseek_model, authenticated: null }; }
  }
  async complete(messages) {
    const key = await this.key();
    let response;
    try {
      response = await this.fetcher('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: this.config.deepseek_model, messages, stream: false, thinking: { type: this.config.deepseek_thinking ? 'enabled' : 'disabled' }, max_tokens: this.config.deepseek_max_tokens }),
        signal: AbortSignal.timeout(this.config.deepseek_timeout_ms)
      });
    } catch { throw new Error('DEEPSEEK_NETWORK_OR_TIMEOUT: 响应未知，未自动重试'); }
    if (!response.ok) throw new Error(`DEEPSEEK_HTTP_${response.status}: 请求失败（不输出上游错误正文）`);
    let data;
    try { data = await response.json(); } catch { throw new Error('DEEPSEEK_INVALID_RESPONSE'); }
    const choice = data.choices?.[0];
    if (typeof choice?.message?.content !== 'string') throw new Error('DEEPSEEK_EMPTY_RESPONSE');
    const answer = choice.message.content.split(key).join('[REDACTED]');
    const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'].filter(k => Number.isFinite(data.usage?.[k])).map(k => [k, data.usage[k]]));
    return { answer, finish_reason: choice.finish_reason, complete: choice.finish_reason === 'stop', usage, model: typeof data.model === 'string' ? data.model.split(key).join('[REDACTED]') : this.config.deepseek_model };
  }
}
