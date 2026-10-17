import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {monitorWebTurn} from './web-network.mjs';
import {conversationUrl,projectUrl} from './conversation-url.mjs';

export function classifyReply(answer) {
  const prompt = answer.split('\n').filter(line => /(?:请|是否|要不要|需要|确认|选择|提供|补充|would you|please|confirm|which|shall i)/i.test(line) && /(?:确认|是否|要不要|请选择|请提供|请补充|请告诉|需要你|would you|please (?:confirm|provide|choose)|shall i)/i.test(line)).join('\n');
  return { required: !!prompt, kind: prompt ? (/确认|是否|confirm|shall i/i.test(prompt) ? 'confirmation' : 'clarification') : 'none', prompt: prompt || null, source: 'text_heuristic', certainty: prompt ? 'possible' : 'unknown' };
}

// Labels of explicit expand/collapse controls the page renders inside a bubble.
export const COLLAPSE_CONTROL = /^(收起|展开|显示更多|显示更少|show (?:less|more))$/i;
// Contenteditable paragraphs may introduce extra blank lines; never remove words or compare prefixes.
export function normalizedComposerText(value){return (value||'').replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').replace(/\n(?:[ \t]*\n)+/g,'\n').trim();}
export function editablePlainText(root){
 const walk=node=>{
  if(node.nodeType===3)return node.nodeValue||'';
  if(node.nodeType!==1)return '';
  if(node.getAttribute('aria-hidden')==='true'||node.tagName==='SVG')return '';
  if(node.tagName==='BR')return '\n';
  const value=[...node.childNodes].map(walk).join('');
  return /^(P|DIV|LI|PRE|BLOCKQUOTE|H[1-6])$/.test(node.tagName)?value+'\n':value;
 };
 return [...root.childNodes].map(walk).join('');
}
export function browserSubmissionText(value){
 // Keep destinations and labels, avoid editor auto-link serializing Markdown twice.
 return value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g,(_,label,url)=>label===url?url:`${label} — ${url}`);
}
export function classifyGenerationFailure(text) {
  if (/cloudflare_challenge|cf-chl-|verify you are human|验证您是真人|人机验证/i.test(text)) return 'browser_verification';
  if (/too many requests|rate limit|达到.*限额|请求过多/i.test(text)) return 'rate_limited';
  return 'generation_failed';
}

export function classifyPageIssue(text) {
  const failure=classifyGenerationFailure(text);
  if(failure!=='generation_failed')return failure;
  if(/(?:please\s+(?:try\s+)?(?:refresh|reload)|(?:refresh|reload)(?:ing)?\s+(?:this|the|your)\s+page|刷新.{0,8}(?:页面|重试)|重新加载(?:页面)?)/i.test(text)||/^(?:刷新|刷新页面|重新加载|Refresh|Reload)(?: page)?$/im.test(text))return 'refresh_required';
  return null;
}

export function isConversationUnavailable(text){
  if(typeof text!=='string')return false;
  // This explicit permission error also mentions login; it must win over login hints.
  if(/(?:你无权访问此对话|无权访问(?:此|该)?(?:对话|会话)|you (?:do not|don't) have (?:permission|access) to (?:this|the) conversation)/i.test(text))return true;
  if(/cloudflare_challenge|too many requests|rate limit|sign in|log in|登录|人机验证/i.test(text))return false;
  return /(?:unable to (?:load|retrieve) conversation|conversation (?:not found|not available|unavailable)|(?:无法|不能)(?:加载|获取|访问)(?:此|该|这个|对应)?(?:对话|会话)|(?:对话|会话)(?:不存在|不可用))/i.test(text);
}

// A submission is matched to the rendered user bubble by exact text. The page
// injects an expand/collapse button whose label ("收起"/"Show less") would
// otherwise be read as body text, so that button is hidden before reading.
export function findUserMessageIndex(messages, question, startIndex = 0) {
  const sent = normalizedComposerText(question);
  if (!sent) return -1;
  for (let index = Math.max(0, startIndex); index < messages.length; index++) {
    if (messages[index].role === 'user' && normalizedComposerText(messages[index].text) === sent) return index;
  }
  return -1;
}

// Mirrors the in-page reader used by messages(). Only explicit collapse/expand
// controls are hidden; the author's own prose (including a literal "收起") stays.
export function userMessageText(node, togglePattern) {
  const controls = [...node.querySelectorAll('button, [role="button"], [aria-hidden="true"]')].filter(control => togglePattern.test((((control.getAttribute && control.getAttribute('aria-label')) || control.innerText) || '').trim()) || (control.getAttribute?.('aria-hidden') === 'true' && (control.innerText ?? control.textContent ?? '').trim() === '…'));
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
    const url = record.context_reset_pending?null:record.conversation_url || (record.conversation_mode === 'new' ? null : this.config.conversation_url);
    const entry=record.project_url?projectUrl(record.project_url):this.config.entry_url||'https://chatgpt.com/';
    if(!entry)throw new BridgeError('无效的官网项目地址');
    const fresh=record.context_reset_pending||record.conversation_mode==='new'||!url;
    if (url && !conversationUrl(url)) throw new BridgeError('conversation_url 必须是 ChatGPT 对话地址');
    const browser = await this.connect();
    const contexts = browser.contexts();
    if (!contexts.length) throw new BridgeError('没有可用的浏览器上下文');
    this.requestPages ||= new Map();
    this.conversationPages ||= new Map();
    let page = (record.request_id ? this.requestPages.get(record.request_id) : null)||(url?this.conversationPages.get(conversationUrl(url)):null);
    if(page?.isClosed())page=null;
    if(page && url && conversationUrl(page.url().split('?')[0])!==conversationUrl(url)&&!await this.conversationUnavailable(page,record))throw new BridgeError('已绑定的请求标签页离开原对话，停止操作');
    if(!page && !(fresh && !url)) {
      const matches=contexts.flatMap(c=>c.pages()).filter(p=>url?conversationUrl(p.url().split('?')[0])===conversationUrl(url):p.url().split('?')[0]===entry);
      const matchingContexts=contexts.filter(c=>c.pages().some(p=>matches.includes(p)));
      if(matches.length>1&&matchingContexts.length>1&&!Number.isInteger(this.config.browser_context_index))throw new BridgeError('相同对话出现在多个登录上下文，请指定browser_context_index；不要求关闭其他标签页');
      const scoped=Number.isInteger(this.config.browser_context_index)?matches.filter(p=>contexts[this.config.browser_context_index]?.pages().includes(p)):matches;
      // Duplicate tabs in one account are valid. Create a dedicated background tab,
      // rather than overwrite a user's draft or choose whichever tab happens to be first.
      page=scoped.length===1?scoped[0]:null;
    }
    if (!page) {
      const context = Number.isInteger(this.config.browser_context_index) ? contexts[this.config.browser_context_index] : contexts.length===1 ? contexts[0] : null;
      if(!context)throw new BridgeError('存在多个登录上下文，不能猜测账号；请在本机配置browser_context_index');
      // A new conversation may reuse an empty home tab, never an existing chat or draft.
      if(fresh&&!url){
        for(const candidate of context.pages()){
          if(record.project_url?projectUrl(candidate.url())!==entry:!/^https:\/\/chatgpt\.com\/?(?:\?|$)/.test(candidate.url()))continue;
          const safe=await candidate.locator('main').evaluateAll(nodes=>nodes.length===1&&!nodes[0].querySelector('[data-user-message-bubble], [data-message-author-role]')&&![...nodes[0].querySelectorAll('[contenteditable="true"]')].some(n=>(n.innerText ?? n.textContent ?? '').trim()));
          if(safe&&!await this.conversationUnavailable(candidate)){page=candidate;break;}
        }
      }
      if(!page){
        const destination=url||entry;
        if(contexts.length===1&&typeof browser.newBrowserCDPSession==='function'){
          const session=await browser.newBrowserCDPSession();
          const created=context.waitForEvent('page',{timeout:30000});void created.catch(()=>{});
          try{
            const {targetId}=await session.send('Target.createTarget',{url:destination,background:true});page=await created;
            const check=await context.newCDPSession(page);
            try{const info=await check.send('Target.getTargetInfo');if(info.targetInfo.targetId!==targetId)throw new BridgeError('新建标签页身份不匹配，停止操作');}finally{await check.detach();}
            await page.waitForLoadState('domcontentloaded',{timeout:30000});
          }
          finally{await session.detach();}
        }else{page = await context.newPage();await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30000 });}
      }
    }
    if(record.request_id)this.requestPages.set(record.request_id,page);
    if(url)this.conversationPages.set(conversationUrl(url),page);
    if (url && conversationUrl(page.url().split('?')[0]) !== conversationUrl(url)&&!await this.conversationUnavailable(page,record)) throw new BridgeError('固定对话地址不可访问，未创建替代对话');
    await page.locator('[role="textbox"][contenteditable="true"]:visible').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if(url&&conversationUrl(page.url().split('?')[0])!==conversationUrl(url)&&!await this.conversationUnavailable(page,record))throw new BridgeError('页面加载后离开原对话，停止输入以免误发');
    if(record.project_url&&!url&&projectUrl(page.url())!==entry)throw new BridgeError('官网项目不可访问；请重新选择或创建项目，不自动把任务移到普通对话');
    return page;
  }
  async status() {
    try {
      const browser = await this.connect();
      return { connected: true, conversation_url: this.config.conversation_url, pages: browser.contexts().flatMap(c => c.pages()).filter(p => p.url().startsWith('https://chatgpt.com/')).map(p => ({ url: p.url() })) };
    } catch (e) { return { connected: false, error: e.message, conversation_url: this.config.conversation_url }; }
  }
  async messages(page,anchorId=null) {
    const current = page.locator('main:visible').last().locator('[data-user-message-bubble], [data-markdown-text-style="assistant-message"]');
    if (await current.count()) {
      return current.evaluateAll((nodes, {pattern,anchorId}) => {
        if(anchorId){const index=nodes.findIndex(n=>n.hasAttribute('data-user-message-bubble')&&(n.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')||'').split(' ').includes(anchorId));if(index<0)return [];nodes=nodes.slice(index);}
        const toggle = new RegExp(pattern, 'i');
        const text = node => {
          if(node.hasAttribute('data-user-message-bubble')){
            const copy=node.cloneNode(true);
            for(const control of copy.querySelectorAll('button,[role="button"],[aria-hidden="true"],svg')){
              if(control.getAttribute('aria-hidden')==='true'||control.tagName.toLowerCase()==='svg'||toggle.test((control.getAttribute('aria-label')||control.textContent||'').trim()))control.remove();
            }
            for(const br of copy.querySelectorAll('br'))br.replaceWith('\n');
            for(const block of copy.querySelectorAll('p,div,li,pre,blockquote,h1,h2,h3,h4,h5,h6'))block.append('\n');
            return copy.textContent||'';
          }
          const controls = [...node.querySelectorAll('button, [role="button"], [aria-hidden="true"]')].filter(control => toggle.test(((control.getAttribute('aria-label') || control.innerText) || '').trim()) || (control.getAttribute('aria-hidden') === 'true' && (control.innerText ?? control.textContent ?? '').trim() === '…'));
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
      }, {pattern:COLLAPSE_CONTROL.source,anchorId});
    }
    return page.locator('[data-message-author-role]').evaluateAll(nodes => nodes.map(n => ({ role: n.getAttribute('data-message-author-role'), text: n.innerText, complete: false })));
  }
  async pin(page, record, persist) {
    const url = conversationUrl(page.url().split('?')[0]);
    if (url && url !== record.conversation_url) {
      if (record.conversation_url) throw new BridgeError('网页切换到了其他对话');
      record.conversation_url = url;
      this.conversationPages ||=new Map();this.conversationPages.set(url,page);
      if(record.context_reset_pending){
        record.context_reset.to_url=url;record.context_reset_pending=false;
        if(this.config.conversation_url===record.context_reset.from_url){this.config.conversation_url=url;await this.saveConfig(this.config);}
      }
      if (!this.config.conversation_url && record.conversation_mode !== 'new') {
        this.config.conversation_url = url;
        await this.saveConfig(this.config);
      }
      await persist(record);
    }
  }
  async ask(record, persist, timeoutMs) {
    record.submission_text??=browserSubmissionText(record.question);
    if(record.submission_text!==record.question)record.input_transform={kind:'markdown_links_to_plain_text',original_preserved:true};
    record.stage='locating_conversation';await persist(record);
    let page = await this.page(record);
    if(await this.conversationUnavailable(page,record)){
      await this.resetConversation(record,persist);page=await this.page(record);
      if(await this.conversationUnavailable(page,record))throw new BridgeError('新对话仍不可用，请检查登录或网络，不再循环新建');
    }
    const stopMonitoring=monitorWebTurn(page,record);
    try {
    const input = page.locator('[role="textbox"][contenteditable="true"]:visible').first();
    if (!await input.isVisible()) throw new BridgeError('未找到输入框：请检查登录、验证页面或页面结构变化');
    if(record.conversation_url&&!(await this.messages(page)).some(m=>m.role==='user')){
      const deadline=Date.now()+8000;let loaded=false;
      while(Date.now()<deadline){
        if(await this.conversationUnavailable(page,record)){await this.resetConversation(record,persist);return this.ask(record,persist,timeoutMs);}
        if(conversationUrl(page.url().split('?')[0])!==conversationUrl(record.conversation_url))throw new BridgeError('加载原对话时发生跳转，停止发送；请检查当前账号与对话权限');
        if((await this.messages(page)).some(m=>m.role==='user')){loaded=true;break;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!loaded)throw new BridgeError('原对话历史尚未加载，停止发送；请恢复原请求后再试');
    }
    if (await page.locator('[data-talvt-turn-state]:not([data-talvt-turn-state="complete"])').count() || await page.locator('button[data-testid="stop-button"]').isVisible()) throw new BridgeError('当前对话正在生成，请稍后重试');
    record.before_count = (await this.messages(page)).length;
    // Persist intent before any submit action; uncertain submissions are never resent.
    record.status = 'submitting';
    await persist(record);
    record.stage='filling_composer';await persist(record);
    await input.fill(record.submission_text);
    let actual='';const fillDeadline=Date.now()+2000;
    do{actual=await input.evaluate(editablePlainText);if(normalizedComposerText(actual)===normalizedComposerText(record.submission_text))break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<fillDeadline);
    if(normalizedComposerText(actual)!==normalizedComposerText(record.submission_text)){
      const expectedNormalized=normalizedComposerText(record.submission_text),actualNormalized=normalizedComposerText(actual);let mismatch=0;while(mismatch<Math.min(expectedNormalized.length,actualNormalized.length)&&expectedNormalized[mismatch]===actualNormalized[mismatch])mismatch++;
      record.request_submitted=false;record.submission_confirmed=false;record.composer_diagnostics={expected_chars:record.question.length,actual_chars:actual.length,expected_normalized_chars:expectedNormalized.length,actual_normalized_chars:actualNormalized.length,first_mismatch_index:mismatch,expected_at_end:mismatch===expectedNormalized.length,actual_at_end:mismatch===actualNormalized.length,normalization:'semantic_blocks_without_hidden_inline_icons'};
      throw new BridgeError('输入框文本未与本次问题一致，停止提交');
    }
    record.stage='submitting';await persist(record);
    record.submit_attempted=true;delete record.request_submitted;await persist(record);
    await this.submit(page,input,record,persist);
    record.status = 'waiting';
    record.stage='waiting_answer';
    record.generation_status = 'generating';
    record.generation_complete = false;
    await persist(record);
    return await this.wait(page, record, persist, timeoutMs);
    }finally{stopMonitoring();}
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
      const index=findUserMessageIndex(messages,record.submission_text||record.question,record.before_count);
      if(index>=0) {
        record.user_message_id=messages[index].message_id;
        record.submission_confirmed=true;
        record.stage='submission_confirmed';
        await persist(record);return;
      }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    record.submission_confirmed=false;
    record.generation_status='submission_unconfirmed';
    throw new BridgeError('未观察到本次用户消息：发送尚未确认。请检查网页输入框及提示；保留原请求ID，勿自动重发');
  }
  async recover(record, persist, timeoutMs, {refreshPage=false} = {}) {
    if(record.request_submitted===false||(record.stage==='filling_composer'&&!record.submit_attempted&&!record.submission_confirmed&&!record.user_message_id)){
      record.request_submitted=false;record.status='blocked';record.error='本轮在输入校验阶段停止，未执行发送；修正输入后用新请求提交，勿恢复到默认对话';await persist(record);return record;
    }
    if(!record.conversation_url&&record.conversation_mode==='new')throw new BridgeError('新会话未保存实际对话地址，停止恢复；不回退到默认对话');
    record.conversation_url ||= this.config.conversation_url;
    if (!record.conversation_url) throw new BridgeError('未保存对话地址，无法安全恢复；请在浏览器确认提问是否提交');
    const page = await this.page(record);
    if(await this.conversationUnavailable(page,record)){
      await this.resetConversation(record,persist);
      return this.ask(record,persist,timeoutMs);
    }
    if(refreshPage) {
      if(!record.user_message_id)throw new BridgeError('刷新恢复需要已确认的用户消息ID；提交不确定时不能自动刷新或重发');
      if((record.refresh_count||0)>=2)throw new BridgeError('已达到原请求的两次刷新上限，请人工检查网页');
      const issue=record.network?.rate_limit_until>Date.now()?'rate_limited':await this.pageIssue(page);
      if(issue==='browser_verification'||issue==='rate_limited')throw new BridgeError('网页验证或限流需要人工处理，不通过刷新循环重试');
      const draft=await page.locator('[contenteditable="true"]:visible').evaluateAll(nodes=>nodes.some(n=>(n.innerText ?? n.textContent ?? '').trim()));
      if(draft)throw new BridgeError('页面输入框有未提交内容，停止刷新以免丢失草稿');
      if(await page.locator('button[data-testid="stop-button"]:visible').count())throw new BridgeError('页面仍在生成，不刷新活动请求');
      const messages=await this.messages(page);
      const anchor=messages.findIndex(m=>m.role==='user'&&m.message_id===record.user_message_id);
      if(anchor>=0&&messages.slice(anchor+1).some(m=>m.role==='user'))throw new BridgeError('原问题后已有新消息，停止刷新以免影响后续对话');
      record.refresh_count=(record.refresh_count||0)+1;
      record.stage='refreshing_page';record.refresh={allowed:false,category:'refresh_in_progress',attempts:record.refresh_count,max_attempts:2};
      record.refresh_attempted_at=new Date().toISOString();
      await persist(record);
      await page.reload({waitUntil:'domcontentloaded',timeout:15000});
      if(conversationUrl(page.url().split('?')[0])!==conversationUrl(record.conversation_url))throw new BridgeError('刷新后离开原对话，请检查登录状态，不新建替代对话');
    }
    return this.wait(page, record, persist, timeoutMs);
  }
  async conversationUnavailable(page,record){
    // Only explicit site error UI, never an assistant statement about another chat.
    const text=await page.locator('[role="alert"]:visible,[role="dialog"]:visible,main:visible').evaluateAll(nodes=>nodes.map(node=>{
      // A healthy chat's history can be huge; inspect error UI, not a clone of every turn.
      if(node.tagName==='MAIN'&&node.querySelector('[data-user-message-bubble],[data-message-author-role]'))return '';
      const copy=node.cloneNode(true);for(const n of copy.querySelectorAll('[data-message-author-role],[data-markdown-text-style],[data-user-message-bubble],nav,aside'))n.remove();
      return copy.textContent||'';
    }).join('\n'));
    if(isConversationUnavailable(text))return true;
    // The SPA can discard an inaccessible /c/ route and return to its home without an alert.
    // Confirm the current browser is authenticated before treating that redirect as context loss.
    if(record?.conversation_url&&/^https:\/\/chatgpt\.com\/?(?:\?|$)/.test(page.url())&&typeof page.evaluate==='function'){
      this.authChecks ||= new WeakMap();
      let check=this.authChecks.get(page);
      if(!check||Date.now()-check.at>=60000){
        check={at:Date.now(),result:page.evaluate(async()=>{try{const r=await fetch('/api/auth/session',{credentials:'same-origin',signal:AbortSignal.timeout(5000)});if(!r.ok)return false;const s=await r.json();return !!s.user;}catch{return false;}}).catch(()=>false)};
        this.authChecks.set(page,check);
      }
      return await check.result===true;
    }
    return false;
  }
  async resetConversation(record,persist){
    if(record.context_reset)throw new BridgeError('此请求已重建一次对话，停止重复新建');
    if(!record.conversation_url)throw new BridgeError('缺少原对话身份，不能确认失效对话');
    record.context_reset={reason:'conversation_unavailable',from_url:record.conversation_url,to_url:null,previous_user_message_id:record.user_message_id||null,current_question_replayed:!!record.submission_confirmed,history_transferred:false,at:new Date().toISOString()};
    record.conversation_url=null;record.context_reset_pending=true;record.context_inherited=false;
    delete record.user_message_id;delete record.before_count;delete record.retry;delete record.refresh;
    record.submission_confirmed=false;record.answer='';record.generation_complete=false;record.stage='rebuilding_conversation';
    this.requestPages?.delete(record.request_id);await persist(record);
  }
  async pageIssue(page){
    // Read site alerts only: assistant prose mentioning refresh is not a UI failure.
    const text=await page.locator('[role="alert"]:visible,[role="alertdialog"]:visible,[role="dialog"]:visible,main:visible').evaluateAll(nodes=>nodes.map(n=>n.tagName==='MAIN'?[...n.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.closest('[data-message-author-role],[data-markdown-text-style],[data-user-message-bubble]')&&/^(?:刷新(?:页面)?|重新加载(?:页面)?|Refresh(?: page)?|Reload(?: page)?)$/i.test((b.getAttribute('aria-label')||b.innerText||b.textContent||'').trim())).map(b=>b.getAttribute('aria-label')||b.innerText).join('\n'):n.innerText).join('\n'));
    return typeof text==='string'?classifyPageIssue(text):null;
  }
  async retry(record, persist, timeoutMs) {
    if (record.generation_complete) return record;
    if (!record.conversation_url || !record.user_message_id) throw new BridgeError('重试必须先通过 recover 锚定原问题，不能重发');
    if ((record.generation_retry_count || 0) >= 2) throw new BridgeError('已达到原问题的两次生成重试上限');
    const page = await this.page(record);
    const messages = await this.messages(page);
    const index = messages.findIndex(m=>m.role==='user' && m.message_id===record.user_message_id && normalizedComposerText(m.text)===normalizedComposerText(record.submission_text||record.question));
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
    let previous = '', stable = 0,lastSaved='',lastSaveAt=0;
    while (Date.now() < deadline) {
      if(page.isClosed?.())page=await this.page(record);
      if(await this.conversationUnavailable(page,record)){await this.resetConversation(record,persist);return this.ask(record,persist,Math.max(1000,deadline-Date.now()));}
      await this.pin(page, record, persist);
      if (record.conversation_url && conversationUrl(page.url().split('?')[0]) !== conversationUrl(record.conversation_url)) throw new BridgeError('当前页面离开固定对话，停止读取');
      const issue=record.network?.rate_limit_until>Date.now()?'rate_limited':await this.pageIssue(page);
      if(issue){
        record.status='awaiting_user_input';record.generation_complete=false;record.generation_status='blocked';record.incomplete=true;record.stage=issue;
        record.user_action={required:true,kind:issue,source:'visible_site_alert',certainty:'observed'};
        record.retry={allowed:false,category:issue};
        record.refresh={allowed:issue==='refresh_required'&&!!record.user_message_id&&!!record.conversation_url&&(record.refresh_count||0)<2,category:issue,attempts:record.refresh_count||0,max_attempts:2};
        record.error=issue==='refresh_required'?'网页提示需要刷新；可刷新原对话并恢复读取，不重新发送问题':issue==='browser_verification'?'网页要求人工验证，处理后恢复原请求':'网页请求受限，请等待后恢复原请求';
        await persist(record);return record;
      }
      const dialogs = await page.locator('[role="dialog"]:visible,[role="alertdialog"]:visible').evaluateAll(nodes => nodes.map(n => ({ text: n.innerText, actions: [...n.querySelectorAll('button')].map(b => b.innerText || b.getAttribute('aria-label')).filter(Boolean) })));
      if (dialogs.length) {
        record.status = 'awaiting_user_input';
        record.generation_status = 'blocked'; record.generation_complete = false;
        record.user_action = { required: true, kind: 'ui_confirmation', prompt: dialogs.map(d => d.text).join('\n'), dialogs, source: 'visible_dialog', certainty: 'observed' };
        return record;
      }
      const messages = await this.messages(page,record.user_message_id);
      const anchoredIndex = record.user_message_id ? messages.findIndex(m => m.role === 'user' && m.message_id === record.user_message_id) : -1;
      if (record.user_message_id && anchoredIndex < 0) throw new BridgeError('当前页面未加载本次用户消息，无法可靠恢复');
      const appended = messages.slice(anchoredIndex >= 0 ? anchoredIndex : record.before_count);
      const userIndex = findUserMessageIndex(appended, record.submission_text||record.question);
      if (userIndex >= 0) {
        record.user_message_id ||= appended[userIndex].message_id;
        const failureUI = await page.locator('main:visible').last().evaluateAll((nodes,id)=>{
          const turns=nodes.flatMap(n=>[...n.querySelectorAll('[data-talvt-turn-state]')]);
          const turn=turns.find(n=>[...n.querySelectorAll('[data-chatgpt-search-message-ids]')].some(e=>(e.getAttribute('data-chatgpt-search-message-ids')||'').split(' ').includes(id)));
          if(!turn)return {text:'',retry:false};
          return {text:turn.innerText,retry:[...turn.querySelectorAll('button')].some(b=>b.getClientRects().length && /^(重试|Retry|Try again)$/i.test((b.getAttribute('aria-label')||b.innerText||b.textContent||'').trim()))};
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
        record.stage=answer?'reading_answer':'waiting_answer';
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
          record.stage='completed';
          delete record.refresh;delete record.retry;
          record.files = await this.files(page, record);
          delete record.error;
          return record;
        }
      }
      const snapshot=JSON.stringify([record.answer,record.stage,record.generation_status,record.user_message_id]);
      if(snapshot!==lastSaved||Date.now()-lastSaveAt>=5000){await persist(record);lastSaved=snapshot;lastSaveAt=Date.now();}
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
