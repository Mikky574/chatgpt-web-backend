# 消息发送、登录复用与回答读取链路

记录日期：2026-10-14。

## 本次真实测试结果

本次直接调用运行中的8787后端，发送“发送连通性测试，请只回复：收到。”，指定new模式和15000毫秒等待时间。

首次接口返回504 timeout，但页面已出现用户问题，输入框清空，记录取得user_message_id。随后对同一request_id调用recover，返回200、status=completed、generation_complete=true、answer=“收到。”。

因此本次后端实际可以发送。首次超时发生在等待生成结果阶段，不能据此认定没有发送。此结果只证明当前本机环境和这次短消息，不证明其他机器、长消息或不同网页布局都能成功。

重要版本区别：本次运行中的服务仍使用此前加载的Enter提交路径；本地文件已增加显式发送按钮与提交确认，但该变更尚未完成真实网页验证和推送。Node服务不会因磁盘源码改动自动重新加载。此次成功不能算新发送按钮实现已验证。

测试记录在本机records/send-live-check-1791954435905.json及同名Markdown；浏览器实际对话URL保存在该记录中，不将登录数据或私有记录写入文档或仓库。

## 两条调用路径

实际协作调用：

```text
用户在操作手对话提出任务
  → 操作手读取controller-operator技能
  → 本地生成并检查packet.json
  → task-controller.mjs：维护任务身份、锁和未完成请求
  → consult-controller.mjs：字段与敏感格式检查，渲染Markdown
  → consult-gpt.mjs：HTTP请求
  → 127.0.0.1:8787 server.mjs
  → bridge.mjs：Playwright连接CDP9222
  → 已登录Chrome中的目标对话
  → 输入、提交、识别本轮回答
  → JSON结果逐层返回操作手
  → 操作手本地实施、验证，必要时回报同一对话
```

本次诊断绕过操作手及摘要管理，直接POST /ask测试后端。这样可以判断问题是否位于浏览器桥接，而不是把全部层一起测试后只看到一个超时。

## 登录状态如何保持

浏览器启动脚本固定使用%LOCALAPPDATA%/ChatGPT-CDP-Profile，不使用临时目录或项目当前目录。Chrome自己在这个配置目录保存Cookie及网站存储；用户首次登录后，后续始终使用同一目录。CDP连接到正在运行的Chrome，复用其中已有浏览器上下文，不创建新的无痕上下文。

登录与任务对话是不同身份：同一个登录可以有多个对话。登录失效、网站要求验证或用户退出账号时，仍需要用户处理，CDP不能保证永久登录，也不会自动绕过验证。代码不把Cookie导出到提示词或仓库。

## 同一任务如何继续同一对话

task-controller.mjs按固定task_id保存records/role-tasks/<task_id>/state.json，包含conversation_url、pending_request_id、requests和last_result。

首次ask没有URL，使用new创建独立网页对话；页面出现/c/地址后bridge.pin保存实际URL。后续同task_id使用continue并显式传回这个URL。浏览器已有对应标签页就复用；没有时打开该URL。无法访问或身份变化时报错，不静默换成其他对话。

每个新问题生成不同request_id；同一个问题超时后recover沿用原request_id，只读取，不重新输入。任务ID只留本地，Markdown问题正文不包含它。不要删除records，跨项目的任务ID需带项目区分。

## HTTP后端执行顺序

1. 校验请求来源、Host、JSON类型、长度、request_id、对话模式和超时参数。
2. 检查单进程busy锁，拒绝并发浏览器操作；检查同ID冲突和同上下文未完成请求。
3. 在records中保存问题、目标URL、发送前消息数量和提交意图。
4. bridge.page连接本机CDP，选择浏览器上下文和对应对话页面，定位可见contenteditable textbox。
5. 确认对话没有正在生成的轮次，填入问题并提交。
6. 轮询本次用户消息及其后助手消息，保存部分状态；只取得本轮回答。
7. 返回状态、answer、generation_complete、user_action、files等信息，并持久保存JSON及Markdown。

## 发送动作与提交确认

GitHub此前版本：input.fill(question)，随后input.press('Enter')，直接开始等回答。Enter可能受网页输入方式、界面状态或提交行为影响，不能仅因按键调用成功就认定网站接受请求。

本地待验证实现：优先寻找唯一可见的发送按钮（send-button或明确的发送aria-label），等待其可点击后点击；找不到明确按钮才使用一次Enter。多个按钮则拒绝猜测。提交后最多10秒观察新增用户消息，必须与完整问题匹配，成功后保存user_message_id和submission_confirmed=true。

没有观察到本轮用户消息就返回提交未确认，而不是再等待完整生成超时。点击结果不确定不再补按Enter，避免已发送的问题被发两遍。按钮缺失、不可用、页面跳转或登录验证需检查网页，不用盲重发。

## 本轮回答如何定位

读取当前可见main内的用户气泡和助手正文。用户气泡可能包含展开/收起按钮、aria-hidden省略号；读取时排除明确控件，保留作者正文中的同名文字。

首先按已保存user_message_id定位本轮问题；首次尚无ID时从before_count之后严格比较完整问题文本。共享前缀不能匹配。目标消息未加载或该问题后出现新的用户问题时停止，避免读取邻居回答。

回答存在且内容连续稳定、没有停止生成按钮，并有明确turn complete或对应完成控件后，才设置generation_complete=true。文字停顿本身不够。正文识别到待补充问题时可返回awaiting_user_input；这不代表本地任务通过验收。

## 如何区分故障阶段

| 证据 | 所在阶段 | 应采取的动作 |
| --- | --- | --- |
| 找不到输入框，显示登录或验证 | 网页可用性 | 用户处理页面；不要发新请求 |
| 文本仍在输入框，无新增用户气泡 | 提交尚未确认 | 检查发送按钮、禁用状态、页面提示；不能直接归因网络 |
| 用户气泡出现、输入框清空、消息ID取得 | 已发送 | 等本轮回答；超时用原ID recover |
| 网页有回答，记录answer为空 | 消息定位或文本匹配 | 对照完整问题、控件文字、锚点、before_count |
| 有部分答案但generation_complete=false | 生成或完成识别 | 检查停止按钮和明确完成状态，不提前结束 |
| cloudflare_challenge等验证提示 | 网页验证阻塞 | 人工处理后recover，禁止自动绕过 |
| 原轮次普通失败且有唯一重试按钮 | 生成失败 | 显式retry原任务，最多两次，不新建问题 |

HTTP504只说明本次等待时限结束，不说明请求没有送达。健康接口200只说明服务可访问，也不说明模型完成了回答。

## 最小可重复诊断

在项目终端执行以下Node脚本，短测试问题仅在首次ask发送一次：

```javascript
const request_id = 'send-check-' + Date.now();
const response = await fetch('http://127.0.0.1:8787/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    request_id, conversation_mode: 'new',
    question: '发送连通性测试，请只回复：收到。', timeout_ms: 15000
  })
});
console.log(request_id, response.status, await response.json());
```

如果返回超时，保留输出中的request_id，用POST /recover携带原ID与timeout_ms。不要再次运行上述脚本生成新ID来恢复同一次请求。GET /records/<request_id>查看问题、消息ID、状态及URL。

CDP只读诊断必须设置连接/定位时限，并在finally调用browser.close()释放本次客户端连接；这里的关闭是断开Playwright接入，保持用户原Chrome运行。不要将命令输出接到等待EOF的管道而忘了关闭连接，否则“没有输出”可能只是诊断进程没有退出。

## 部署与测试边界

修改bridge.mjs或server.mjs后要重启拥有该进程的服务才能加载。start.bat固定后端8787与操作手3030，复用已有浏览器，不自动再打开操作手页面。stop.bat只关闭本脚本拥有的进程。

敏感摘要检查、技能约束和任务锁无法代替操作系统隔离或强制披露网关。新按钮提交路径仍需实际网页测试；本次旧Enter路径的ask和recover已经真实完成。不同页面布局、账号状态、验证码和站点变更都可能改变结果，应保留分阶段证据，而不是把全部故障归为“网络”或“模型幻觉”。
