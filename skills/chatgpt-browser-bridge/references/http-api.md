# HTTP 调用、上下文及文件

基址：http://127.0.0.1:8787，POST 均使用 application/json。

## 对话身份

优先通过8789/jobs队列或task-controller适配器调用。直接8787/ask必须明确conversation_mode，不能依赖默认对话来关联不同工作。8789/jobs首次省略conversation_url，续聊传实际返回URL；不要把8787专用字段混入8789请求。

错误响应可包含guidance：确定性的诊断类别、next操作、禁止盲目重发的说明。unresolved_request中的request_id指阻塞旧轮次，当前问题尚未发送（request_submitted=false）；先GET /records/<旧ID>再POST /recover读取原轮次。确实需要独立上下文才新ID加conversation_mode=new，不传URL。force_new=true仅新版兼容，不应猜测其他force/reset参数；旧版本可能静默忽略，因此标准模式更可靠。8789转发冲突时自身request_id仍是当前作业，旧ID在blocking_request_id或guidance中，二者不能混淆。

继续默认对话：POST /ask `{ "request_id": "unique-id", "question": "...", "conversation_mode": "continue" }`。

新开独立对话：POST /ask `{ "request_id": "unique-id", "question": "...", "conversation_mode": "new" }`。新对话不继承旧上下文，也不覆盖默认对话。新对话的实际地址在响应 conversation_url 中。

继续指定对话：POST /ask `{ "request_id": "another-id", "question": "...", "conversation_mode": "continue", "conversation_url": "https://chatgpt.com/c/..." }`。用上次返回的地址保持同一上下文；不能把 new 与 conversation_url 同时传入。请求 ID 标识一次提问，不标识整个对话，每轮使用新 ID。

话题变更不自动新开对话，是否继承上下文由调用者决定。同一服务串行操作浏览器；未恢复的提交阻止继续同一对话，但可以显式 new 另建对话。只支持单服务进程。

## 回答与状态

POST /ask 同步等待（timeout_ms 默认 120000，范围 1000–600000）。等待期间可 GET /records/{request_id} 轮询已落盘的部分回答与状态；记录不是网页的无限期实时订阅。

响应字段：
- answer：实际网页可见的助手回答纯文本，不包含思考详情；messages 保留本轮助手片段及消息 ID。
- conversation_url、conversation_mode、context_inherited：本次对话身份与是否继承上下文。
- status：pending、submitting、waiting、completed、awaiting_user_input、timeout、blocked、failed。
- generation_status：not_started、thinking_or_waiting、generating、completed、blocked、unknown。无正文时无法可靠区分排队与思考，所以合并为 thinking_or_waiting。
- generation_complete：本轮生成是否有页面完成信号；与用户任务是否完成不同。
- incomplete：回答是否完整。timeout 的片段不能当作完整回答。
- task_complete：目前为 null，无法仅凭页面判断整个任务已完成。
- user_action：required、kind、prompt、source、certainty。页面弹窗为 visible_dialog / observed；正文确认或澄清为 text_heuristic / possible，需要调用者结合语境复核。无命中不证明无需确认。
- files：本轮附件链接与下载状态。

completed：本轮生成结束。awaiting_user_input 可能是完整答案中的确认问题（generation_complete=true），也可能是阻塞页面弹窗（false）。HTTP 200 不代表整个任务完成；务必检查这些字段。不要自动点击确认、自动回复“同意”或代用户补全偏好。

正文需要回复时，取得用户答案后以新 request_id、continue 和原 conversation_url 提问。弹窗需要用户处理时，保留现场，处理后 POST /recover。超时使用 POST /recover `{ "request_id": "original-id", "timeout_ms": 120000 }`，不重发原问题。重复已完成请求返回缓存。

## 文件下载

生成完成后的 files 列表包含 file_id、label、href、download、local_path、status。候选按页面附件链接识别；普通扩展名链接也可能被列为候选，调用者需确认用途。

POST /files `{ "request_id": "original-id" }` 可刷新本轮文件列表。POST /download `{ "request_id": "original-id", "file_id": "0" }`。后端回到记录中的对话，以用户消息 ID 定位对应轮次，点击实际链接或文件卡片的下载按钮并等待浏览器 download 事件。成功后保存到 records/{request_id}/downloads，响应 file.local_path 为本地绝对路径。调用者在同一机器可直接读取这个文件。

下载失败明确返回错误，文件状态为 failed；不会把 HTML 页面或未触发下载的链接冒充成文件。链接过期、HTTP 403、消息未加载、站点文件卡片改版、未触发浏览器下载事件时需重新检查页面。当前支持可定位的 a[href] 链接和带“下载文件”按钮的文件卡片。网站拒绝下载时返回 blocked，不绕过验证。不会自动遍历或下载其他对话文件。

## HTTP 403 排查

2026-10-14 同一附件首次下载 403，之后重试下载成功并校验内容。历史失败正文未保留，不能断言原因。新版本在 file.diagnostics 中只保留状态码、分类及无凭据的响应头，不保存 Cookie、签名 URL 或原始 HTML。

browser_verification：请用户在原浏览器完成站点要求的验证，再重试原 file_id。login_required：原固定配置中重新登录 ChatGPT，不新建配置。expired_or_missing_file：刷新 /files 检查链接，仍失效时在同一对话请求重新生成。unknown_http_rejection：保留现场检查，不把 403 一律归因为 Cloudflare。rate_limited / server_error 可按 retry_after 或短暂等待后有限重试一次；其他分类不得自动连续重试。正常点击失败后用户可再次调用 /download，不会重发 /ask 或重新生成文件。
