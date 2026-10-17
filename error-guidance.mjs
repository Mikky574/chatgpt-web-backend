// Local, deterministic help. This is API guidance, never model-authored instructions.
export function withGuidance(body,{port=8787}={}){
 if(!body?.error||body.guidance)return body;
 const id=body.request_id;
 let guidance;
 if(body.request_submitted===false&&body.stage==='filling_composer')guidance={code:'COMPOSER_NOT_SUBMITTED',action:'本轮未执行发送，不是登录失效证据。任务适配器可解除pending；修正输入格式后新请求提交。不要恢复到默认对话。',request_id:id};
 else if(body.error==='unresolved_request')guidance={code:'RECOVER_PREVIOUS_TURN',current_question_submitted:false,blocking_request_id:id,
   next:[{method:'GET',url:`http://127.0.0.1:8787/records/${id}`},{method:'POST',url:'http://127.0.0.1:8787/recover',body:{request_id:id,timeout_ms:120000}}],
   alternative:'仅确实需要独立上下文时，新request_id加conversation_mode=new，不传conversation_url。',
   do_not:['不要重复提交本次问题来解锁','不要自动清空旧记录','不要把旧请求ID用作新问题ID']};
 else if(['busy','session_busy','native_capacity','web_capacity','queue_full','browser_busy'].includes(body.error))guidance={code:'WAIT_FOR_CAPACITY',next:[{method:'GET',url:`http://127.0.0.1:${port}/health`}],action:body.request_submitted===false?'本次未受理；等待容量恢复后可重新提交相同内容和ID。':'受理状态不明确；先查询原请求，不换ID重发。',do_not:['不要通过换对话或不断开标签页规避busy']};
 else if(['request_id_conflict','request_context_conflict'].includes(body.error))guidance={code:'CHECK_REQUEST_IDENTITY',action:'同一request_id必须对应同一问题和上下文。恢复原工作沿用原ID；新的问题才使用新ID。',do_not:['不要修改旧记录覆盖冲突']};
 else if(body.error==='record_not_found'||body.error==='job_not_found')guidance={code:'CHECK_SERVICE_AND_ID',action:'确认服务端口、部署目录和原请求ID；404不是原问题从未送达的充分证明，不自动重发。'};
 else if(['timeout','blocked','failed','interrupted','awaiting_user_input'].includes(body.status))guidance={code:'INSPECT_ORIGINAL_TURN',request_id:id||null,action:'先检查stage、submission_confirmed、generation_complete、user_action、retry和refresh。保持原请求身份恢复读取；只在明确allowed时执行重试或刷新。',do_not:['不要把部分回答标记为完整','不要自动同意网页确认或绕过登录验证']};
 return guidance?{...body,guidance}:body;
}
