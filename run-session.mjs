const goal = process.argv[2];
if (!goal) { console.error('Usage: node run-session.mjs "公开或合成测试目标"'); process.exit(1); }
async function call(route, input) {
  const response = await fetch(`http://127.0.0.1:8788${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}
try {
  let session = await call('/sessions', { goal, max_rounds: 4 });
  console.log(`Session: ${session.session_id}`);
  while (session.status === 'ready') {
    session = await call(`/sessions/${session.session_id}/step`, {});
    console.log(JSON.stringify({ session_id: session.session_id, status: session.status, round: session.round, gpt: session.plan, deepseek: session.deepseek_result?.answer, error: session.error }, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
