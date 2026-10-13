import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { BrowserBridge } from '../bridge.mjs';

test('CDP file card download saves actual bytes', { skip: !process.env.CDP_TEST }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-download-test-'));
  const fixture = http.createServer((req, res) => {
    if (req.url === '/file') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="bridge-test.txt"' });
      return res.end('bridge-download-ok');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<main><div data-talvt-turn-state="complete"><div data-chatgpt-search-message-ids="test-user"><div data-user-message-bubble>file</div></div><div data-markdown-text-style="assistant-message">ready</div><span class="group/resource-row"><span title="bridge-test.txt">bridge-test.txt</span><button aria-label="下载文件" onclick="location.href='/file'">download</button></span></div></main>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = await browser.contexts()[0].newPage();
  t.after(async () => { await page.close(); await browser.close(); await new Promise(resolve => fixture.close(resolve)); await rm(directory, { recursive: true }); });
  await page.goto(`http://127.0.0.1:${fixture.address().port}`);
  const bridge = new BrowserBridge({}, async () => {});
  bridge.page = async () => page;
  const record = { user_message_id: 'test-user', question: 'file' };
  record.files = await bridge.files(page, record);
  assert.equal(record.files.length, 1);
  assert.equal(record.files[0].source, 'card');
  const file = await bridge.download(record, '0', directory);
  assert.equal(file.status, 'downloaded');
  assert.equal(await readFile(file.local_path, 'utf8'), 'bridge-download-ok');
});
