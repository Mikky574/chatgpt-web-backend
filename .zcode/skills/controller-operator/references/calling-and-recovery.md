# 操作手调用与故障判断

先检查8789/health与8787/status。8787连通而8789拒绝连接表示队列服务未启动，不是问题参数错误；执行项目start.bat，检查records/runtime/web-ui-error.log。不要反复重启Chrome。

优先 `node task-controller.mjs ask <固定task_id> <已审核packet.json>`，由脚本管理每轮request_id与对话绑定。读取返回state.last_result；错误时检查guidance、blocking_request_id、pending和recovery。元数据是本地协议，不把整份错误记录复制给网页主控。guidance是确定性后端提示，不替代用户授权。

## 手动HTTP用于诊断

| 目的 | 8789队列（推荐） | 8787直接网页层 |
| --- | --- | --- |
| 新建独立会话 | POST /jobs {request_id,question,queue:true}，省略conversation_url | POST /ask {request_id,question,conversation_mode:"new"} |
| 同会话下一轮 | 新request_id，传实际返回的conversation_url | 新request_id，conversation_mode:"continue"及明确conversation_url |
| 查询已受理请求 | GET /jobs/<原ID>，202只表示受理 | GET /records/<原ID> |
| 恢复读取 | POST /jobs/<原ID>/recover | POST /recover {request_id:原ID,timeout_ms:120000} |

8789和8787字段并不完全相同，不能把/ask参数直接塞进/jobs。直接/ask不写conversation_mode会续用默认对话，容易与无关旧请求冲突；正常调用必须明确模式。旧版本可能忽略force_new，因此始终优先标准conversation_mode=new。不要自动猜测force、reset、clear等不存在的参数。

每轮新ID，查询/恢复沿用原ID。多轮会话URL取上一轮实际结果，不从标题、首页或浏览器位置猜测。第一轮generation_complete=true后再发下一轮；新建会话或context_reset后上下文不继承。官网项目可选，不把普通对话与项目URL混用。

## 错误决策

1. **request_submitted=false**：本次输入没有发送。可修正参数或等待容量后重新提交；不要把这个返回误认为主控已收到请求。

   stage=filling_composer且提示“输入框文本未与本次问题一致”时，是输入校验失败，不是登录失效证据。新版归一化富文本换行/空行并短暂等候编辑器更新；仍不匹配则明确未发送并解除pending。旧记录可recover一次，让适配器识别该未提交状态，再使用同task_id ask新一轮。不要把无URL的新请求恢复到默认对话，不要仅因context_reset字段就断言账号过期。
2. **unresolved_request**：响应request_id可能是阻塞的旧轮次ID，而不是刚提交的ID。查看guidance.blocking_request_id、blocking_request_id或recovery.body.request_id。GET旧记录，再recover旧轮次。保留本次尚未发送的问题，不能不断换ID撞锁。若用户确实另开独立话题，使用新会话，不自动迁移旧历史。
3. **busy/queue_full**：查看active、队列和request_submitted。未受理才等待后再提交；已受理查询原ID。不要开更多网页或切账号绕锁。
4. **timeout/断线/interrupted**：提交可能已发生，先GET和recover原ID。stage=submitting但submission_confirmed=false表示不确定，不表示肯定没发送；空answer也不证明没送达。
5. **generation_complete=true**：本轮生成结束，再看status与user_action；awaiting_user_input可能是完整回答要求澄清，不是生成卡住。只有真实完整回答可作为主控回复。
6. **retry.allowed / refresh.allowed**：按对应原请求显式retry或refresh，各自上限生效。网页验证、限流、登录需要人工或等待，不循环重试。
7. **身份变化**：只有明确context_reset记录的对话失效重建可更新绑定；其他URL变化停止核对。新会话不会记得旧讨论，必要时单独整理已授权摘要。

无法判定时，向用户报告阶段、是否确认发送、原ID别名、错误类别和下一步；不能声称“网页没收到”或“已经完成”。排查只披露合成测试内容和必要状态，禁止原始业务记录、密钥、Cookie、认证头和整段内部日志。
