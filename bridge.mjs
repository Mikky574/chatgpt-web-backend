import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export function classifyReply(answer) {
  const prompt = answer.split('\n').filter(line => /(?:请|是否|要不要|需要|确认|选择|提供|补充|would you|please|confirm|which|shall i)/i.test(line) && /(?:确认|是否|要不要|请选择|请提供|请补充|请告诉|需要你|would you|please (?:confirm|provide|choose)|shall i)/i.test(line)).join('\n');
  return { required: !!prompt, kind: prompt ? (/确认|是否|confirm|shall i/i.test(prompt) ? 'confirmation' : 'clarification') : 'none', prompt: prompt || null, source: 'text_heuristic', certainty: prompt ? 'possible' : 'unknown' };
}

// Labels of explicit expand/collapse controls the page renders inside a bubble.
export const COLLAPSE_CONTROL = /^(收起|展开|显示更多|显示更少|show (?:less|more))$/i;
export function classifyGenerationFailure(text) {
  if (/cloudflare_challenge|cf-chl-|verify you are human|验证您是真人|人机验证/i.test(text)) return 'browser_verification';
  if (/too many requests|rate limit|达到.*限额|请求过多/i.test(text)) return 'rate_limited';
  return 'generation_failed';
}

// A submission is matched to the rendered user bubble by exact text. The page
// injects an expand/collapse button whose label ("收起"/"Show less") would
// otherwise be read as body text, so that button is hidden before reading.
export function findUserMessageIndex(messages, question, startIndex = 0) {
  const sent = (question || '').trim();
  if (!sent) return -1;
  for (let index = Math.max(0, startIndex); index < messages.length; index++) {
    if (messages[index].role === 'user' && (messages[index].text || '').trim() === sent) return index;
  }
  return -1;
}

// Mirrors the in-page reader used by messages(). Only explicit collapse/expand
// controls are hidden; the author's own prose (including a literal "收起") stays.
export function userMessageText(node, togglePattern) {
  const controls = [...node.querySelectorAll('button, [role="button"], [aria-hidden="true"]')].filter(control => togglePattern.test((((control.getAttribute && control.getAttribute('aria-label')) || control.innerText) || '').trim()) || (control.getAttribute?.('aria-hidden') === 'true' && control.innerText.trim() === '…'));
  if (!controls.length) return node.innerText;
  const saved = controls.map(control => control.style.display);
  controls.forEach(control => { control.style.display = 'none'; });
  const text = node.innerText;
  controls.forEach((control, index) => { control.style.display = saved[index]; });
  return text;
}

// A completed turn needs an explicit signal: the turn-state attribute or the
// same-turn completion control. A quiet stall is never treated as completion.
export function isTurnComplete({ answer, generating, turnComplete = false, hasLegacyControls = false, stable = 0, conversationUrl = null }) {
  return !!(answer && !generating && conversationUrl && stable >= 2 && (turnComplete || hasLegacyControls));
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
      return current.evaluateAll((nodes, pattern) => {
        const toggle = new RegExp(pattern, 'i');
        const text = node => {
          const controls = [...node.querySelectorAll('button, [role="button"], [aria-hidden="true"]')].filter(control => toggle.test(((control.getAttribute('aria-label') || control.innerText) || '').trim()) || (control.getAttribute('aria-hidden') === 'true' && control.innerText.trim() === '…'));
          if (!controls.length) return node.innerText;
          const saved = controls.map(control => control.style.display);
          controls.forEach(control => { control.style.display = 'none'; });
          const value = node.innerText;
          controls.forEach((control, index) => { control.style.display = saved[index]; });
          return value;
        };
        return nodes.map(n => ({
          role: n.hasAttribute('data-user-message-bubble') ? 'user' : 'assistant',
          text: text(n),
          complete: n.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') === 'complete',
          message_id: n.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0] || null
        }));
      }, COLLAPSE_CONTROL.source);
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
    // Persist intent before any submit action; uncertain submissions are never resent.
    record.status = 'submitting';
    await persist(record);
    await input.fill(record.question);
    await this.submit(page,input,record,persist);
    record.status = 'waiting';
    record.generation_status = 'generating';
    record.generation_complete = false;
    await persist(record);
    return this.wait(page, record, persist, timeoutMs);
  }
  async submit(page,input,record,persist) {
    const send=page.locator('button[data-testid="send-button"]:visible, button[aria-label="发送"]:visible, button[aria-label="Send prompt"]:visible, button[aria-label="Send message"]:visible');
    // Prefer the explicit control; Enter can insert a newline depending on composer settings.
    if(await send.count()===1) {
      try { await send.waitFor({state:'visible',timeout:5000});await send.click({timeout:10000}); }
      catch { throw new BridgeError('发送按钮未能确认点击；请检查原请求，勿自动重发'); }
    }else if(await send.count()>1) throw new BridgeError('找到多个发送按钮，无法安全提交');
    else await input.press('Enter');
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      await this.pin(page,record,persist);
      const messages=await this.messages(page);
      const index=findUserMessageIndex(messages,record.question,record.before_count);
      if(index>=0) {
        record.user_message_id=messages[index].message_id;
        record.submission_confirmed=true;
        await persist(record);return;
      }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    record.submission_confirmed=false;
    record.generation_status='submission_unconfirmed';
    throw new BridgeError('未观察到本次用户消息：发送尚未确认。请检查网页输入框及提示；保留原请求ID，勿自动重发');
  }
  async recover(record, persist, timeoutMs) {
    record.conversation_url ||= this.config.conversation_url;
    if (!record.conversation_url) throw new BridgeError('未保存对话地址，无法安全恢复；请在浏览器确认提问是否提交');
    const page = await this.page(record);
    return this.wait(page, record, persist, timeoutMs);
  }
  async retry(record, persist, timeoutMs) {
    if (record.generation_complete) return record;
    if (!record.conversation_url || !record.user_message_id) throw new BridgeError('重试必须先通过 recover 锚定原问题，不能重发');
    if ((record.generation_retry_count || 0) >= 2) throw new BridgeError('已达到原问题的两次生成重试上限');
    const page = await this.page(record);
    const messages = await this.messages(page);
    const index = messages.findIndex(m=>m.role==='user' && m.message_id===record.user_message_id && m.text.trim()===record.question.trim());
    if(index<0 || messages.slice(index+1).some(m=>m.role==='user')) throw new BridgeError('原问题未加载或后续已有新问题，不能安全重试');
    const alerts=await page.locator('[role="alert"]:visible').evaluateAll(nodes=>nodes.map(n=>n.innerText).join('\n'));
    const alertKind=classifyGenerationFailure(alerts);
    if(alertKind!=='generation_failed') throw new BridgeError('需要人工处理网页验证或等待限流，不自动重试','awaiting_user_input',{category:alertKind});
    const turn = await this.turn(page, record);
    const kind = classifyGenerationFailure(await turn.innerText());
    if(kind!=='generation_failed') throw new BridgeError('需要人工处理网页验证或等待限流，不自动重试', 'awaiting_user_input', {category:kind});
    const button = turn.getByRole('button',{name:/^(重试|Retry|Try again)$/i}).filter({visible:true});
    if(await button.count()!==1) throw new BridgeError('未找到唯一的本轮重试按钮');
    record.generation_retry_count = (record.generation_retry_count || 0)+1;
    record.retry_attempted_at = new Date().toISOString();
    await persist(record); // Persist before clicking: uncertain clicks must not retry automatically.
    await button.click({timeout:5000});
    record.answer='';record.status='waiting';record.generation_complete=false;
    return this.wait(page,record,persist,timeoutMs);
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
      const userIndex = findUserMessageIndex(appended, record.question);
      if (userIndex >= 0) {
        record.user_message_id ||= appended[userIndex].message_id;
        const failureUI = await page.locator('main:visible').last().evaluateAll((nodes,id)=>{
          const turns=nodes.flatMap(n=>[...n.querySelectorAll('[data-talvt-turn-state]')]);
          const turn=turns.find(n=>[...n.querySelectorAll('[data-chatgpt-search-message-ids]')].some(e=>(e.getAttribute('data-chatgpt-search-message-ids')||'').split(' ').includes(id)));
          if(!turn)return {text:'',retry:false};
          return {text:turn.innerText,retry:[...turn.querySelectorAll('button')].some(b=>b.getClientRects().length && /^(重试|Retry|Try again)$/i.test((b.getAttribute('aria-label')||b.innerText).trim()))};
        },record.user_message_id);
        const alerts=await page.locator('[role="alert"]:visible').evaluateAll(nodes=>nodes.map(n=>n.innerText).join('\n'));
        const failure = classifyGenerationFailure((failureUI.text || '')+'\n'+alerts);
        if (failure === 'browser_verification' || failure === 'rate_limited') {
          record.status = 'awaiting_user_input';record.generation_complete=false;record.generation_status='blocked';record.incomplete=true;
          record.user_action={required:true,kind:failure,source:'page_error_hint',certainty:'possible'};
          record.retry={allowed:false,category:failure,requires_user:true};
          record.error=failure==='browser_verification'?'网页要求验证，请人工处理后恢复读取':'网页请求受限，请等待限制恢复后再读取';
          await persist(record);return record;
        }
        if(failureUI.retry) {
          record.status='blocked';record.generation_complete=false;record.generation_status='failed';record.incomplete=true;
          record.retry={allowed:(record.generation_retry_count||0)<2,category:'generation_failed',attempts:record.generation_retry_count||0,max_attempts:2};
          record.error='本轮生成失败；可对原任务显式 retry，勿重新提交问题';
          await persist(record);return record;
        }
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
        const hasLegacyControls = await legacyControls.count() > 0;
        stable = answer && answer === previous ? stable + 1 : 0;
        previous = answer;
        if (isTurnComplete({ answer, generating, turnComplete: completedTurn, hasLegacyControls, stable, conversationUrl: record.conversation_url })) {
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
