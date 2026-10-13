# 本地桥接接口约定

目标链路：本地 Agent → 工具调用 → 浏览器页面 → 固定 ChatGPT 对话 → 本地记录。

Skill 提供流程，CDP 客户端或浏览器工具提供实际执行能力。若本地模型客户端支持 MCP，可将桥接封装成 MCP 工具；否则可使用可执行 CLI。单纯把 SKILL.md 放进 Ollama 模型目录不会增加浏览器操作能力。

建议工具：
- status()：检查 CDP 连接、ChatGPT 页面和登录状态，不读取或导出登录凭据。
- ask(question, request_id)：在固定对话提交问题并读取新增回答。
- recover(request_id)：断线后检查页面与本地记录，恢复读取，不重新发送。

返回结构：request_id、status、conversation_url、answer、incomplete、record_path、error。status 为 completed、timeout、blocked 或 failed。

CDP 接入只使用本机端点。先确认现有浏览器是否已启用调试；普通启动的浏览器不能凭一个网址变成 CDP 会话。不要为了调试强制关闭用户浏览器或复制其 Cookie。若需要独立调试配置目录，需由用户在该浏览器完成登录；它不会自动继承当前浏览器的登录态。是否能复用原配置需按实际浏览器版本验证。

页面定位从当次可见 DOM 推导，不依赖永久不变的输入框、发送按钮或停止按钮选择器。完成条件结合本次新增助手消息及生成状态；连续一段时间文本不变只作为辅助证据。验证、重新登录或额度限制出现时返回 blocked，保留现场。

本地持久化先落请求状态，再提交页面，再落回答。request_id 重复且已完成时返回已有记录；状态不确定时先 recover。固定对话串行执行，锁被占用时返回 busy，不能把多个请求混入同一生成过程。
