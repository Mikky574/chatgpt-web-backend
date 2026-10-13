import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export function classifyReply(answer) {
  const prompt = answer.split('\n').filter(line => /(?:请|是否|要不要|需要|确认|选择|提供|补充|would you|please|confirm|which|shall i)/i.test(line) && /(?:确认|是否|要不要|请选择|请提供|请补充|请告诉|需要你|would you|please (?:confirm|provide|choose)|shall i)/i.test(line)).join('\n');
  return { required: !!prompt, kind: prompt ? (/确认|是否|confirm|shall i/i.test(prompt) ? 'confirmation' : 'clarification') : 'none', prompt: prompt || null, source: 'text_heuristic', certainty: prompt ? 'possible' : 'unknown' };
}

export class BridgeError extends Error {
  constructor(message, status = 'blocked', diagnostics = null) { super(message); this.status = status; this.diagnostics = diagnostics; }
}

export function diagnoseDownload(status, headers = {}, body = '') {
  let category = 'unknown_http_rejection';
  if (headers['cf-mitigated'] === 'challenge' || /just a moment|cf-chl-|checking your browser/i.test(body)) category = 'browser_verification';
  else if (status === 401 || /unauthorized|authentication required|session expired/i.test(body)) category = 'login_required';
  else if (/expired|file not found|not_found/i.test(body)) category = 'expired_or_missing_file';
  else if (status === 429) category = 'rate_limited';
  else if (status >= 500) category = 'server_error';
  return { http_status: status, category, retryable: category === 'server_error' || category === 'rate_limited', server: headers.server || null, content_type: headers['content-type'] || null, cf_mitigated: headers['cf-mitigated'] || null, retry_after: headers['retry-after'] || null };
}

export class BrowserBridge {
  constructor(config, saveConfig) { this.config = config; this.saveConfig = saveConfig; }
  async connect() {
    if (!this.browser?.isConnected()) {
      const endpoint = this.config.cdp_endpoint || 'http://127.0.0.1:9222';
      const parsed = new URL(endpoint);
      if (!['http:', 'ws:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new BridgeError('CDP endpoint 必须是本机 http 或 ws 地址');
      try {
        this.browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      } catch { throw new BridgeError('CDP 未连接：请先开启浏览器远程调试。'); }
    }
    return this.browser;
  }
  async page(record = {}) {
    const url = record.conversation_url || (record.conversation_mode === 'new' ? null : this.config.conversation_url);
    if (url && !/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(url)) throw new BridgeError('conversation_url 必须是 ChatGPT /c/ 对话地址');
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new BridgeError('没有可用的浏览器上下文');
    const pages = context.pages();
    let page = record.conversation_mode === 'new' && !url ? null : pages.find(p => url ? p.url().split('?')[0] === url : /^https:\/\/chatgpt\.com\/?(?:\?|$)/.test(p.url()));
    if (!page) {
      page = await context.newPage();
      await page.goto(url || this.config.entry_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    if (url && page.url().split('?')[0] !== url) throw new BridgeError('固定对话地址不可访问，未创建替代对话');
    await page.locator('[role="textbox"][contenteditable="true"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    return page;
  }
  async status() {
    try {
      const browser = await this.connect();
      return { connected: true, conversation_url: this.config.conversation_url, pages: browser.contexts().flatMap(c => c.pages()).filter(p => p.url().startsWith('https://chatgpt.com/')).map(p => ({ url: p.url() })) };
    } catch (e) { return { connected: false, error: e.message, conversation_url: this.config.conversation_url }; }
  }
  async messages(page) {
    const current = page.locator('main:visible').last().locator('[data-user-message-bubble], [data-markdown-text-style="assistant-message"]');
    if (await current.count()) {
      return current.evaluateAll(nodes => nodes.map(n => ({
        role: n.hasAttribute('data-user-message-bubble') ? 'user' : 'assistant',
        text: n.innerText,
        complete: n.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') === 'complete',
        message_id: n.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0] || null
      })));
    }
    return page.locator('[data-message-author-role]').evaluateAll(nodes => nodes.map(n => ({ role: n.getAttribute('data-message-author-role'), text: n.innerText, complete: false })));
  }
  async pin(page, record, persist) {
    const url = page.url().split('?')[0];
    if (/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(url) && url !== record.conversation_url) {
      if (record.conversation_url) throw new BridgeError('网页切换到了其他对话');
      record.conversation_url = url;
      if (!this.config.conversation_url && record.conversation_mode !== 'new') {
        this.config.conversation_url = url;
        await this.saveConfig(this.config);
      }
      await persist(record);
    }
  }
  async ask(record, persist, timeoutMs) {
    const page = await this.page(record);
    const input = page.locator('[role="textbox"][contenteditable="true"]:visible').first();
    if (!await input.isVisible()) throw new BridgeError('未找到输入框：请检查登录、验证页面或页面结构变化');
    if (await page.locator('[data-talvt-turn-state]:not([data-talvt-turn-state="complete"])').count() || await page.locator('button[data-testid="stop-button"]').isVisible()) throw new BridgeError('当前对话正在生成，请稍后重试');
    record.before_count = (await this.messages(page)).length;
    // Persist submission intent before pressing Enter; recovery never blindly resends.
    record.status = 'submitting';
    await persist(record);
    await input.fill(record.question);
    await input.press('Enter');
    record.status = 'waiting';
    record.generation_status = 'generating';
    record.generation_complete = false;
    await persist(record);
    return this.wait(page, record, persist, timeoutMs);
  }
  async recover(record, persist, timeoutMs) {
    record.conversation_url ||= this.config.conversation_url;
    if (!record.conversation_url) throw new BridgeError('未保存对话地址，无法安全恢复；请在浏览器确认提问是否提交');
    const page = await this.page(record);
    return this.wait(page, record, persist, timeoutMs);
  }
  async wait(page, record, persist, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let previous = '', stable = 0;
    while (Date.now() < deadline) {
      await this.pin(page, record, persist);
      if (record.conversation_url && page.url().split('?')[0] !== record.conversation_url) throw new BridgeError('当前页面离开固定对话，停止读取');
      const dialogs = await page.locator('[role="dialog"]:visible,[role="alertdialog"]:visible').evaluateAll(nodes => nodes.map(n => ({ text: n.innerText, actions: [...n.querySelectorAll('button')].map(b => b.innerText || b.getAttribute('aria-label')).filter(Boolean) })));
      if (dialogs.length) {
        record.status = 'awaiting_user_input';
        record.generation_status = 'blocked'; record.generation_complete = false;
        record.user_action = { required: true, kind: 'ui_confirmation', prompt: dialogs.map(d => d.text).join('\n'), dialogs, source: 'visible_dialog', certainty: 'observed' };
        return record;
      }
      const messages = await this.messages(page);
      const anchoredIndex = record.user_message_id ? messages.findIndex(m => m.role === 'user' && m.message_id === record.user_message_id) : -1;
      if (record.user_message_id && anchoredIndex < 0) throw new BridgeError('当前页面未加载本次用户消息，无法可靠恢复');
      const appended = messages.slice(anchoredIndex >= 0 ? anchoredIndex : record.before_count);
      const userIndex = appended.findIndex(m => m.role === 'user' && m.text.trim() === record.question.trim());
      if (userIndex >= 0) {
        record.user_message_id ||= appended[userIndex].message_id;
        const afterQuestion = appended.slice(userIndex + 1);
        const nextUser = afterQuestion.findIndex(m => m.role === 'user');
        if (nextUser >= 0) throw new BridgeError('本次问题后出现其他用户消息，停止读取以避免混淆');
        const assistantMessages = afterQuestion.filter(m => m.role === 'assistant');
        const answer = assistantMessages.map(m => m.text).join('\n\n');
        record.answer = answer;
        record.messages = assistantMessages;
        record.generation_status = answer ? 'generating' : 'thinking_or_waiting';
        const generating = await page.locator('button[data-testid="stop-button"]').isVisible();
        const completedTurn = assistantMessages.length > 0 && assistantMessages.every(m => m.complete);
        const legacyControls = page.locator('article').filter({ has: page.locator('[data-message-author-role="assistant"]') }).last().locator('button[data-testid="copy-turn-action-button"]');
        const hasControls = completedTurn || await legacyControls.count() > 0;
        stable = answer && answer === previous ? stable + 1 : 0;
        previous = answer;
        if (answer && !generating && hasControls && stable >= 2 && record.conversation_url) {
          record.user_action = classifyReply(answer);
          record.status = record.user_action.required ? 'awaiting_user_input' : 'completed'; record.incomplete = false;
          record.generation_complete = true; record.generation_status = 'completed';
          record.files = await this.files(page, record);
          delete record.error;
          return record;
        }
      }
      await persist(record);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    record.status = 'timeout'; record.incomplete = true;
    record.generation_status = 'unknown'; record.generation_complete = false;
    record.error = '等待回答超时；使用 recover 恢复读取，勿重新提交';
    return record;
  }
  async turn(page, record) {
    const turns = page.locator('main:visible').last().locator('[data-talvt-turn-state]');
    const index = await turns.evaluateAll((nodes, id) => nodes.findIndex(n => [...n.querySelectorAll('[data-chatgpt-search-message-ids]')].some(e => e.getAttribute('data-chatgpt-search-message-ids').split(' ').includes(id))), record.user_message_id);
    if (index < 0) throw new BridgeError('页面没有加载对应消息轮次，无法可靠定位文件');
    return turns.nth(index);
  }
  async files(page, record) {
    let scope;
    if (record.user_message_id) scope = await this.turn(page, record);
    else scope = page.locator('article').last();
    const links = await scope.locator('a[href]').evaluateAll(nodes => nodes.map(n => ({ label: n.innerText, href: n.getAttribute('href'), download: n.getAttribute('download') })));
    const candidates = links.filter(l => l.download !== null || /sandbox:|\/backend-api\/.*(?:file|download)|\/mnt\/data\/|\.(?:pdf|docx|xlsx|pptx|csv|zip|txt|md|png|jpg)(?:[?#]|$)/i.test(l.href)).map(l => ({ ...l, source: 'link' }));
    const cards = await scope.locator('button[aria-label="下载文件"],button[aria-label="Download file"]').evaluateAll(buttons => buttons.map(button => {
      let row = button.parentElement;
      while (row && !row.classList.contains('group/resource-row')) row = row.parentElement;
      return { label: row?.querySelector('[title]')?.getAttribute('title'), href: null, source: 'card' };
    }).filter(card => card.label));
    return [...candidates, ...cards].map((l, i) => ({ file_id: String(i), ...l, local_path: null, status: 'available' }));
  }
  async download(record, fileId, directory) {
    const file = record.files?.find(f => f.file_id === fileId);
    if (!file) throw new BridgeError('找不到指定文件');
    if (file.local_path) return file;
    const page = await this.page(record);
    const turn = await this.turn(page, record);
    const matching = [];
    if (file.source === 'card') {
      for (const button of await turn.locator('button[aria-label="下载文件"],button[aria-label="Download file"]').all()) {
        const label = await button.evaluate(button => { let row = button.parentElement; while (row && !row.classList.contains('group/resource-row')) row = row.parentElement; return row?.querySelector('[title]')?.getAttribute('title'); });
        if (label === file.label) matching.push(button);
      }
    } else {
      const link = turn.locator('a[href]').filter({ hasText: file.label }).filter({ visible: true });
      for (const candidate of await link.all()) if (await candidate.getAttribute('href') === file.href) matching.push(candidate);
    }
    if (matching.length !== 1) throw new BridgeError('下载链接不可唯一定位或已过期');
    const downloadEvent = page.waitForEvent('download', { timeout: 30000 });
    const rejectedResponse = page.waitForResponse(response => /\/(?:interpreter\/download|files\/.*download)/i.test(response.url()) && response.status() >= 400, { timeout: 30000 }).then(async response => {
      const body = await response.text().catch(() => '');
      const diagnostics = diagnoseDownload(response.status(), response.headers(), body.slice(0, 65536));
      throw new BridgeError(`文件下载被网站拒绝：HTTP ${response.status()} (${diagnostics.category})。请在浏览器检查下载；后端不会绕过验证。`, 'blocked', diagnostics);
    });
    // Handle rejection even if click itself fails.
    downloadEvent.catch(() => {});
    rejectedResponse.catch(() => {});
    if (file.source === 'card') await matching[0].locator('xpath=ancestor::span[contains(@class,"group/resource-row")][1]').hover();
    await matching[0].click();
    const download = await Promise.race([downloadEvent, rejectedResponse]);
    const filename = path.basename(download.suggestedFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download.bin';
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, `${fileId}-${filename}`);
    await download.saveAs(destination);
    file.local_path = destination; file.status = 'downloaded';
    delete file.error; delete file.diagnostics;
    return file;
  }
}
