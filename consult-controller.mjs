import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function loadRoleConfig(directory=root) {
  const configured=process.env.ROLE_CONFIG;
  try{return JSON.parse(await readFile(configured?path.resolve(directory,configured):path.join(directory,'role-collaboration.json'),'utf8'));}
  catch(e){if(e.code!=='ENOENT'||configured)throw e;return JSON.parse(await readFile(path.join(directory,'role-collaboration.example.json'),'utf8'));}
}
const [operation, id, packetFile, conversationUrl] = process.argv.slice(2);
export function validatePacket(packet) {
  const allowed = ['task_id', 'goal', 'constraints', 'observations', 'questions', 'project_structure', 'file_roles', 'symptoms', 'expected_behavior', 'evidence', 'hypotheses', 'options', 'unknowns'];
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

export function renderControllerMessage(packet) {
  validatePacket(packet);
  // task_id identifies local state only; it is not part of the model message.
  const parts = [packet.goal.trim()];
  for (const [field, title] of [['symptoms','现象'],['expected_behavior','预期行为'],['constraints','约束'],['observations','当前事实'],['evidence','已验证证据'],['hypotheses','待验证假设'],['options','候选方案与取舍'],['unknowns','尚不清楚'],['project_structure','相关项目结构'],['file_roles','文件用途'],['questions','请判断']]) {
    const items = (packet[field] || []).map(value=>value.trim()).filter(Boolean);
    if (items.length) parts.push(`## ${title}\n\n${items.map(value=>`- ${value}`).join('\n')}`);
  }
  const message = parts.join('\n\n') + '\n';
  if (Buffer.byteLength(message)>12000) throw new Error('Rendered summary too long');
  return message;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if (!['new','continue','recover','retry','refresh'].includes(operation)) throw new Error('Usage: node consult-controller.mjs new|continue|recover|retry|refresh ID PACKET.json [URL]');
    const config=await loadRoleConfig();
    let summaryFile;
    if(!['recover','retry','refresh'].includes(operation)) {
      const packet=validatePacket(JSON.parse(await readFile(packetFile,'utf8')));
      const {mkdir,writeFile}=await import('node:fs/promises');
      if(!/^[A-Za-z0-9_-]{1,80}$/.test(id||''))throw new Error('Invalid request ID');
      const dir=path.join(root,'records','role-exchange');await mkdir(dir,{recursive:true});
      summaryFile=path.join(dir,id+'.md');
      await writeFile(summaryFile,renderControllerMessage(packet));
    }
    const c=config.controller;
    const args=[path.resolve(root,c.script),operation,id,...(['recover','retry','refresh'].includes(operation)?[]:[summaryFile,...(conversationUrl?[conversationUrl]:[])])];
    const result=spawnSync(c.command,args,{cwd:root,env:{...process.env,GPT_BACKEND:c.backend},stdio:'inherit',shell:false});
    if(result.error)throw result.error;process.exitCode=result.status ?? 1;
  } catch(e) { console.error(e.message);process.exitCode=1; }
}
