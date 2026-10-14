import {readFile,writeFile,mkdir,rename,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validatePacket} from './consult-controller.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function runTask({directory=root,operation,taskId,packet,transport}) {
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(taskId||''))throw new Error('Use a stable task ID with letters, digits, hyphen or underscore');
  if(!['ask','recover','retry','show'].includes(operation))throw new Error('Invalid operation');
  const dir=path.join(directory,'records','role-tasks',taskId);await mkdir(dir,{recursive:true});
  const file=path.join(dir,'state.json');
  const read=async()=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {task_id:taskId,conversation_url:null,requests:[]};throw e;}};
  if(operation==='show')return read();
  const lock=path.join(dir,'.lock');
  try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw new Error('Task is locked; check the existing process before removing the lock directory');throw e;}
  try {
    const state=await read();
    const save=async()=>{state.updated_at=new Date().toISOString();await writeFile(file+'.tmp',JSON.stringify(state,null,2));await rename(file+'.tmp',file);};
    let mode;
    if(['recover','retry'].includes(operation)) {
      if(!state.pending_request_id)throw new Error('No pending request');mode=operation;
    }else {
      validatePacket(packet);
      if(packet.task_id!==taskId)throw new Error('Packet task_id must match the stored task identity');
      if(state.pending_request_id)throw new Error('Previous request unresolved; recover this task before asking again');
      state.pending_request_id=randomUUID();mode=state.conversation_url?'continue':'new';
      await writeFile(path.join(dir,'packet.json'),JSON.stringify(packet,null,2));await save();
    }
    const result=await transport({mode,requestId:state.pending_request_id,packetFile:path.join(dir,'packet.json'),conversationUrl:state.conversation_url});
    if(result.request_id!==state.pending_request_id)throw new Error('Adapter returned a different request identity');
    if(state.conversation_url && result.conversation_url && state.conversation_url!==result.conversation_url)throw new Error('Conversation identity changed; manual review required');
    if(result.conversation_url)state.conversation_url=result.conversation_url;
    state.last_result=result;
    if(result.generation_complete && ['completed','awaiting_user_input'].includes(result.status)){
      state.requests.push({request_id:state.pending_request_id,status:result.status});state.pending_request_id=null;
    }
    await save();return state;
  }finally{await rmdir(lock);}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    const [operation,taskId,packetFile]=process.argv.slice(2);
    if(operation==='list') {
      const {readdir}=await import('node:fs/promises');let ids=[];try{ids=await readdir(path.join(root,'records','role-tasks'));}catch(e){if(e.code!=='ENOENT')throw e;}
      console.log(JSON.stringify(ids,null,2));
    }else {
      const packet=operation==='ask'?JSON.parse(await readFile(packetFile,'utf8')):undefined;
      const state=await runTask({operation,taskId,packet,transport:async({mode,requestId,packetFile,conversationUrl})=>{
        const args=[path.join(root,'consult-controller.mjs'),mode,requestId,...(['recover','retry'].includes(mode)?[]:[packetFile,...(conversationUrl?[conversationUrl]:[])])];
        const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:155000,maxBuffer:1024*1024});
        if(r.error)throw r.error;
        try{return JSON.parse(r.stdout);}catch{throw new Error('Adapter did not return a valid result; retain task ID and recover, do not resubmit');}
      }});
      console.log(JSON.stringify(state,null,2));if(state.pending_request_id)process.exitCode=2;
    }
  }catch(e){console.error(e.message);process.exitCode=1;}
}
