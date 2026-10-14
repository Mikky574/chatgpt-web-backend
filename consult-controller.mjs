import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const [operation, id, packetFile, conversationUrl] = process.argv.slice(2);
export function validatePacket(packet) {
  const allowed = ['task_id', 'goal', 'constraints', 'observations', 'questions', 'project_structure', 'file_roles'];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || Object.keys(packet).some(k=>!allowed.includes(k))) throw new Error('Only approved summary fields are allowed');
  if (!['task_id','goal'].every(k=>typeof packet[k]==='string' && packet[k].trim())) throw new Error('task_id and goal required');
  for (const k of allowed.filter(k=>!['task_id','goal'].includes(k))) if (packet[k] !== undefined && (!Array.isArray(packet[k]) || packet[k].some(v=>typeof v!=='string'))) throw new Error(`${k} must be a string array`);
  const text = JSON.stringify(packet);
  if (Buffer.byteLength(text)>12000) throw new Error('Summary too long');
  // Reject common credential formats. This does not establish semantic disclosure safety.
  if (/(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,}|AKIA[A-Z0-9]{16}|-----BEGIN [^-]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?[A-Za-z0-9._~+/-]{8,})/i.test(text)) throw new Error('Potential credential detected; do not send');
  for (const item of packet.project_structure || []) {
    if (/^[A-Za-z]:|^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)|https?:\/\//.test(item)) throw new Error('Project structure must use sanitized relative paths');
  }
  return packet;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if (!['new','continue','recover'].includes(operation)) throw new Error('Usage: node consult-controller.mjs new|continue|recover ID PACKET.json [URL]');
    let config;
    try { config=JSON.parse(await readFile(path.join(root,'role-collaboration.json'),'utf8')); }
    catch(e) { if(e.code!=='ENOENT') throw e;config=JSON.parse(await readFile(path.join(root,'role-collaboration.example.json'),'utf8')); }
    let summaryFile;
    if(operation!=='recover') {
      const packet=validatePacket(JSON.parse(await readFile(packetFile,'utf8')));
      const {mkdir,writeFile}=await import('node:fs/promises');
      if(!/^[A-Za-z0-9_-]{1,80}$/.test(id||''))throw new Error('Invalid request ID');
      const dir=path.join(root,'records','role-exchange');await mkdir(dir,{recursive:true});
      summaryFile=path.join(dir,id+'.md');
      await writeFile(summaryFile,'你是主控手，负责需求决策与验收建议；操作手负责本地实施与实际测试。不要索取敏感值、源码或原始日志，不扩大权限。以下为经本地整理的任务摘要：\n'+JSON.stringify(packet,null,2));
    }
    const c=config.controller;
    const args=[path.resolve(root,c.script),operation,id,...(operation==='recover'?[]:[summaryFile,...(conversationUrl?[conversationUrl]:[])])];
    const result=spawnSync(c.command,args,{cwd:root,env:{...process.env,GPT_BACKEND:c.backend},stdio:'inherit',shell:false});
    if(result.error)throw result.error;process.exitCode=result.status ?? 1;
  } catch(e) { console.error(e.message);process.exitCode=1; }
}
