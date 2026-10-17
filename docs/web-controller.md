# ChatGPT 网页触发、监控与认证机制

更新：2026-10-17。当前模型调用只走已登录的ChatGPT网页，已移除项目中的CLI模型通道。体验页http://127.0.0.1:8789/不是ChatGPT官网，而是本机控制台；实际问题在Chrome的ChatGPT网页发送，回答绑定官网/c/对话。

默认单浏览器上下文中新建/重开页面使用CDP Target.createTarget(background=true)，校验target身份，不调用bringToFront。后台正常运行不弹出Chrome或切换前台；登录、验证需要用户操作时只提示。多登录上下文仍需要显式指定，不猜测账号。

## 调用拓扑

```text
操作手 task-controller → Markdown摘要 → consult-web
                                 ↓
体验页 ───────────────→ 8789：持久作业、排队、状态查询
                                 ↓
                       8787：网页后端、原轮次记录
                                 ↓
                       CDP 9222：固定登录浏览器
                                 ↓
                       ChatGPT前端 → 网站流式请求
```

start.bat检查并复用固定浏览器配置，再启动8787和8789；stop.bat停止登记进程及可验证归属当前项目的后端，并检查8787/8789端口释放，保留浏览器登录和历史。内部网络的外部网关必须允许浏览器实际访问网站；本机代理不应写进项目。所有服务只监听127.0.0.1，跨机器部署的TLS、身份鉴权及组织出站审查需另建，不能直接改为公网监听。

## 页面操作如何触发

| 阶段 stage | 做什么 | 放行证据 |
| --- | --- | --- |
| locating_conversation | 已有任务找完整/c/ URL；新会话优先复用没有历史和草稿的首页 | URL严格一致；多账号或重复目标页不猜测 |
| filling_composer | 唯一可见输入框填入本轮文本 | 回读文本与问题严格一致 |
| submitting | 优先点击明确发送按钮；没有匹配按钮才使用一次Enter | 不将点击成功当作发送成功 |
| submission_confirmed | 从提交前消息位置后寻找本次用户气泡 | 文本精确匹配并保存user_message_id与/c/ URL |
| waiting_answer / reading_answer | 只读取锚定用户消息之后的assistant内容 | 后续若出现另一用户轮次，停止读取以免串答 |
| completed | 页面明确标记本轮完成、无停止生成按钮、回答连续稳定 | 非空回答+明确完成信号；网络200或安静停顿均不足以单独判定 |

新会话只复用空首页，不覆盖已有聊天或草稿。找不到空首页才创建一个页面；关闭原标签后按同一URL重新打开。若站点明确显示“你无权访问此对话。请确认已登录正确的账户，或请对话所有者向你发送分享链接。”或无法加载/不存在对话，按用户授权新建对话，每个请求最多重建一次；仅发送当前已批准问题，不自动搬运旧历史。返回context_reset记录旧/新URL、原因和history_transferred=false，操作手更新任务绑定，体验页显示上下文重建提示。原轮次已提交时，会明确记录本轮问题在新对话重新发送，不能声称延续了旧上下文。普通网络、登录、验证、限流与用户手动导航到其他有效聊天，不触发此重建。

## 如何监控后端

多标签适配：没有默认conversation_url时，即使有多个首页也进入安全空首页选择/后台新建流程，不报“多个目标标签”。不同聊天按规范化URL准确匹配。同一账号重复打开相同聊天时创建一个后台专用页，后续轮次复用缓存绑定；不关闭用户原标签、不覆盖草稿。跨多个登录上下文的同URL重复仍需显式browser_context_index，防止猜测账号。早期版本对重复页的统一拒绝逻辑已被此规则替代。

补充：网站可能将失效/c/路由直接跳回首页而不显示权限提示。此时只在浏览器内/api/auth/session确认仍已登录（只返回布尔值）后按对话失效处理；登录失效不新建。新旧对话不共享上下文，后续调用必须使用返回的新URL。

- GET 8789/health：网页provider、active_jobs、queued_jobs及容量。健康不等于登录有效。
- GET 8789/jobs/<request_id>：queued/running/completed/awaiting_user_input/timeout/blocked/interrupted、stage、answer、generation_complete、user_action、retry、network。
- GET 8789/jobs/<request_id>/events：生命周期与整条回答的SSE，尚不是逐token增量。阶段事件只提供进度，不代表成功。
- GET 8787/status：CDP是否连通、网页标签与当前浏览器锁的请求ID。
- GET 8787/records/<request_id>：原始网页轮次状态、submission_confirmed、user_message_id与同轮网络元数据。只在本机保留，不外发整份记录。

network记录仅包含与本轮问题关联的conversation请求路径、方法、HTTP状态、Content-Type、计时及网络结束/失败标志；不保存Cookie、Authorization、完整请求体、响应正文或账户信息。网页可能在收到足够数据后取消流连接，aborted不等于业务失败；network.stream_finished也只说明网络加载结束，业务完成以页面本轮判定为准。

现有工具：`node scripts/probe-browser.mjs 10000`被动观察10秒网络元数据，不点击；`node scripts/probe-session.mjs`检查会话状态；`node scripts/explore-stream.mjs`是显式发送公开合成问题的流式探索实验，要求唯一空首页，不用于业务重试；`probe-browser-api.mjs`是手动直接请求对照，不随自动化测试运行。

## 登录认证机制怎样探索、如何解释

先区分三层：CDP连通只是能操作Chrome；ChatGPT网页登录状态由浏览器固定配置持有；一次生成还要通过网站前端构造的完整请求检查。前两层成立不代表任意后台HTTP请求都能成功。

本机已观察到的事实：

1. 已登录页面可访问/api/auth/session，探索脚本只返回状态码、session_available、access_token_present、是否存在未来过期时间等布尔值。浏览器内JSON与令牌不返回Node、不打印、不落盘。
2. 正常前端发送触发POST /backend-api/f/conversation/prepare，随后POST /backend-api/f/conversation；实测前者200 JSON，后者200 text/event-stream。流中出现delta_encoding/delta、p/o/v补丁、message_stream_complete和[DONE]等信号。具体请求格式会随网站更新而变。
3. 先前最小直接请求即使在已登录页面内使用会话访问令牌，仍返回403。因此不能得出“拿到登录令牌即可独立调用”的结论。额外请求字段、前端版本、会话准备或网站验证均是待区分假设，现有证据尚未唯一定位403原因。

有效探索顺序是：先监控一次正常网页请求→用本轮问题将prepare、生成流与DOM答案关联→比较失败发生在登录检查、prepare、发送、流读取或DOM完成识别哪个阶段→每次只验证一个假设。不要把所有403都称作令牌过期，也不要遇到403就换请求ID重发。

本项目当前让网页前端处理其认证和请求构造，没有实现后台令牌刷新服务。会话需要重新登录或网站要求人工验证时，用户在原浏览器完成，再recover原轮次。CDP负责复用登录环境及页面操作，不代表可以自动解决验证、导出会话或构造网站保护证明。需要后续独立HTTP通道，须以“同一已授权会话下不依赖输入框、完成两轮续聊及故障恢复”为验收，当前尚未满足，不能宣称已完成。

## 调用、排队与恢复

### 可选的官网项目

这里的项目是ChatGPT官网项目，不是本机文件夹或API平台项目。体验页默认“不使用官网项目（普通对话）”；可刷新官网项目列表、选择已有项目，或输入名称创建一个官网项目。操作手先GET 8789/projects获取当前侧边栏已加载项目；POST 8789/projects {"name":"公开项目名"}在网页创建项目。同名唯一项目直接复用，多个同名项目要求按URL选择。创建结果不确定时先查列表，不盲目再次创建。创建时由网站保留默认记忆设置，本项目不擅自改变；项目分组不等于严格上下文隔离，模型回复也可能出错。

用户授权后可按项目启动任务（最后一个参数可省略，省略即普通对话）：

```text
node task-controller.mjs ask task-name approved-packet.json https://chatgpt.com/g/g-p-<32位项目ID>/project
```

项目URL保存在本机任务状态，通过适配器控制元数据传递，不写入模型提问正文。任务绑定后不随意换项目；后续ask/recover继续使用原任务ID。手动调用POST /jobs时可带project_url；首次问题在项目主页输入框发送，得到/g/g-p-…/c/…对话URL。网站URL可能附带项目名称slug，后端按稳定项目ID与对话ID规范化；local-chatgpt临时URL不能绑定。普通/c/对话与项目对话不能混用。项目失效不自动把任务挪到普通聊天或另一个项目，需要重新选择可访问项目。

本机侧边栏按“官网项目（或普通对话）→ 本机任务 → 多轮记录”组织。GET /history恢复本服务管理过的最近500条作业，包含本机项目/任务元数据；这些元数据不传给网页模型。历史记录不等于导入账号全部官网聊天，项目列表也仅反映当前侧边栏已加载项；不会自动打开所有历史对话读取正文。换账号后旧本机任务仍保留，官网权限由当前账号实际检查，不能把缓存项目名称当作可访问证明。

2026-10-17已实际创建官网测试项目，经8789项目列表识别并确认同名复用；通过作业接口在该项目中新建聊天，23+19返回42，沿同一项目对话追问返回23+19。体验页可从本机后端恢复该任务的两轮历史，并显示官网原对话入口。观测到真实/g/g-p-…/project与/g/g-p-…/c/…路由；这不代表独立网页私有HTTP接口已经可用。

```text
node task-controller.mjs ask project-task approved-packet.json
node task-controller.mjs show project-task
node task-controller.mjs recover project-task
```

task_id在本地映射/c/ URL，每一轮新request_id。摘要自动渲染Markdown，不把本地管理ID写进提问正文。直接使用适配器时：

```text
node consult-web.mjs new request-01 approved-summary.md
node consult-web.mjs continue request-02 approved-summary.md https://chatgpt.com/c/<id>
node consult-web.mjs recover request-02
```

8789 POST /jobs接收{request_id, question, queue:true, conversation_url?}，首次不传URL。默认网页全局执行1个、最多等待32个；重复ID与相同内容返回原作业，不重复发送。队满返回request_submitted=false。不同会话可以排队，但不并行操作网页。不要绕过队列同时调用8787。

超时先查询GET原作业。需要继续读取时POST /jobs/<id>/recover；它调用8787/recover读取锚定原轮次，不填入问题。仅retry.allowed=true时可显式POST /jobs/<id>/retry，最多两次生成重试；不是新问题重发。POST /jobs/<id>/refresh需要已锚定消息、无草稿且没有正在生成，刷新原页后读取。人工验证和限流不自动点击重试。重启时queued/running标记interrupted，不自动重放；没有原网页轮次的queued任务需核对后处理，不能假装已提交。

generation_complete=true表示网页回答生成结束，不代表用户整个任务完成。awaiting_user_input可能来自页面弹窗，也可能是回答文本的启发式提示；应展示原话让用户判断。下载沿用8787/files与/download，只定位本轮文件，不把发现下载链接当作下载成功。

## 保密与现状

### unresolved_request 不是网页busy

URL自动链接兼容：当前输入框会把URL装饰为带图标的富文本元素，innerText可能在URL前凭空插入换行。输入与用户消息校验已改为按段落/BR读取语义文字并忽略隐藏图标，不去掉正文、不使用前缀匹配。公开合成URL与多段Markdown已在真实网页验证输入匹配、发送确认及完整回答；仍失败时composer_diagnostics仅返回字符数量，不输出草稿正文。

补充实测发现：Markdown的[标签](URL)会被前端自动链接再次转义，导致输入校验通过但发送后用户气泡已变形。现发送前将简单HTTP(S) Markdown链接转成等义纯文本（相同标签/URL只保留URL，自定义标签保留为“标签 — URL”）；原question保留，submission_text用于实际输入/发送确认/恢复，input_transform明确告知调用方。2026-10-17真实三轮测试覆盖纯URL、Markdown链接、自定义链接标签、查询参数/锚点及合成本地路径，全部发送确认并读取完整回答。复杂嵌套链接不保证转换，仍完整匹配而非模糊放行。仅改变格式，不擅自访问地址。/health增加composer_reader及进程启动时reader_build指纹，更新文件但未重启时指纹不变；排查输入失败可仅提供指纹、composer_diagnostics长度与首差异索引，无需发送正文。

输入阶段失败：filling_composer提示文本不一致时，不能据此判断会话失效。富文本innerText可能引入额外空行，校验仅归一化CRLF、连续空行及NBSP，仍完整比对文字；发送意图单独保存submit_attempted。未执行发送的输入失败返回request_submitted=false，不再占用未完成对话保护。旧版此阶段遗留记录recover一次可识别为未发送。新会话没有实际URL时禁止回退默认对话恢复，避免串上下文。该路径以回归测试验证，目标环境具体编辑器差异仍需实测。

直接调用8787/ask且省略conversation_mode会续用默认对话。同对话存在未完成且可能已经提交的旧轮次时返回409 unresolved_request；本次输入未发送。响应包含request_submitted=false、pending状态、answer_chars、原错误及recovery命令。先GET /records/<旧ID>，再POST /recover读取原轮次，不用新ID重发旧问题。新问题若确实要独立上下文，明确使用新的request_id及conversation_mode=new，且不传conversation_url；force_new=true是兼容别名，与continue或显式对话URL冲突时拒绝。旧版不支持force_new，可能将它静默忽略，因此迁移时推荐标准conversation_mode字段。新会话不继承旧历史，旧记录仍保留。缺少URL的未确认旧请求不再阻塞明确指定的其他对话。

### 网页提示刷新时

站点可见alert/dialog的“请刷新页面”“Please refresh the page”，或网页正文区的明确Refresh/Reload按钮，会被归类refresh_required；不扫描助手回答正文来触发刷新。即使错误页暂时没有消息气泡，也先报告此错误，不误判为原消息丢失。

体验页显示“刷新官网并恢复”，等价于POST /jobs/<id>/refresh或`node task-controller.mjs refresh <task_id>`。刷新的是Chrome里的原ChatGPT对话，不是本机体验页。仍需已保存的用户消息ID、固定URL，无草稿、无活动生成、无后续新用户轮次；每个原请求最多两次。刷新意图先落盘，再reload原页，之后只读取原回答。没有锚定用户消息时提示人工检查是否送达，不以新ID重发。

| 现象 | 处理 |
| --- | --- |
| 本地超时、连接中断 | 先查询/恢复原请求 |
| 站点明确要求刷新 | 按上述条件刷新原页并恢复 |
| 本轮显示Retry | 仅对原轮次显式重试生成，最多两次 |
| 验证、限流 | 人工完成验证或等待，不循环刷新 |
| 明确提示无权访问/对话不存在 | 新建一次、记录context_reset、更新绑定，不复制旧历史 |
| 无错误提示但页面/会话身份不一致 | 停止，避免误操作其他有效对话 |

刷新不能保证修复网站服务故障；持续失败或达到上限时保留现场供人工检查。识别与安全条件通过合成错误场景自动化测试，未人为制造真实网站故障。

操作手使用controller-operator技能与摘要校验，禁止凭据、源码、diff、个人数据及原始日志出站。体验页直接发送用户输入，不提供强制内容脱敏；仅输入可披露内容。localStorage保存体验页会话，records/web-jobs保存作业，records/role-tasks保存操作手映射，这些记录不提交Git。

已实测：2026-10-17从8789发起新网页会话，返回“网页已记住。”和真实ChatGPT /c/ URL；重启服务后沿同一URL续聊正确返回公开口令MAPLE-5286，另一新会话回答“不知道。”，且观察到第二个作业等待排队。两次均关联到prepare的200 JSON和conversation的200 text/event-stream响应；会话检查返回已登录与有效期在未来的布尔状态，没有输出认证值。实测摘要在records/web-tests/latest-verification.json，仅本地保留。当前生产路径依赖网页操作，独立HTTP接口403尚未解决，逐token代理、完整自动登录刷新和作业取消尚未实现。
