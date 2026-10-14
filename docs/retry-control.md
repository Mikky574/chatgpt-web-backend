# 网页生成失败与重试

- 超时、断线：先 `node task-controller.mjs recover <task_id>`，读取原请求，不重新发问。
- 本轮出现唯一重试按钮且返回retry.allowed=true：运行 `node task-controller.mjs retry <task_id>`，只点击原消息轮次，每个请求最多两次。命令沿用原任务、请求与对话，不创建新问题。
- 网页验证（例如cloudflare_challenge）或限流：返回明确的awaiting_user_input及阻塞类别。用户处理或等待后再recover；不自动点击或绕过验证。
- 无法锚定原消息、后续出现其他用户问题、次数达到上限：停止，人工核对。

HTTP入口仍为POST /recover，额外传retry_generation=true才进行生成重试；默认recover不点击按钮。重试次数在点击前落盘，网络结果不确定不能盲点。适配器需支持retry操作；当前网页适配器已实现。

重试生成可能产生新的回答版本，操作手重新核对内容和验收；这不是相同字节响应的恢复。当前未做自动定时退避或持续重试，避免无限调用。
