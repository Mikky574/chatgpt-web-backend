import { readFile } from 'node:fs/promises';
import {conversationUrl as normalizeConversationUrl} from './conversation-url.mjs';
const [operation, id, summaryFile, conversationUrl] = process.argv.slice(2);
if (!['new', 'continue', 'recover', 'retry','refresh'].includes(operation) || !/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) {
  console.error('Usage: node consult-gpt.mjs new|continue REQUEST_ID SUMMARY_FILE [CONVERSATION_URL]\n       node consult-gpt.mjs recover REQUEST_ID');
  process.exit(1);
}
try {
  const input = { request_id: id, timeout_ms: 120000, wait_for_slot_ms:10000 };
  if(operation==='retry') input.retry_generation=true;
  if(operation==='refresh') input.refresh_page=true;
  if (!['recover','retry','refresh'].includes(operation)) {
    if (operation === 'continue' && !normalizeConversationUrl(conversationUrl)) throw new Error('continue requires an explicit conversation URL');
    const summary = await readFile(summaryFile);
    if (summary.length > 12000) throw new Error('Summary exceeds 12000 bytes; shorten it before sending');
    input.question = summary.toString('utf8');
    if (!input.question.trim()) throw new Error('Summary is empty');
    input.conversation_mode = operation;
    if (operation === 'continue') input.conversation_url = normalizeConversationUrl(conversationUrl);
  }
  const backend = new URL(process.env.GPT_BACKEND || 'http://127.0.0.1:8787');
  if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1') throw new Error('Backend must be local loopback HTTP');
  const response = await fetch(new URL(`/${['recover','retry','refresh'].includes(operation) ? 'recover' : 'ask'}`, backend), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(145000)
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || !result.generation_complete || result.status !== 'completed') process.exitCode = 2;
} catch (error) {
  console.error(`${error.message}\nIf submission may have occurred, recover using the SAME request ID; do not resend with a new ID.`);
  process.exitCode = 1;
}
