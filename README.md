# 网页 ChatGPT 本地后端

本地程序通过 HTTP 提问，后端用 Playwright/CDP 操作已登录的 ChatGPT 网页，并复用同一个对话。它是网页自动化桥接，回答来自浏览器页面。2026-10-14 已在 Chrome 155、当前 ChatGPT 页面完成真实回答读取及超时恢复验证。网页结构以后变化时可能需要更新选择器。

## 启动

```powershell
npm install
npm start
```

服务仅监听 `127.0.0.1:8787`。浏览器必须已开启 CDP；在 conversation.json 配置 `cdp_endpoint`（默认 `http://127.0.0.1:9222`）。当前使用 Google Chrome 的固定配置目录 `%LOCALAPPDATA%\ChatGPT-CDP-Profile`，用户已完成首次 ChatGPT 登录。后续复用该目录，不需要重新创建配置；会话过期时仍可能需要重新验证。

首次启动会从 conversation.example.json 创建本机 conversation.json。真实对话地址、records、登录配置和日志均不提交到 Git。

在项目目录可运行启动脚本：

```powershell
& './skills/chatgpt-browser-bridge/scripts/start-browser.ps1'
```

脚本优先复用已运行的本机 CDP；未启动时查找 Google Chrome 并用固定配置启动。首次登录之后保留该目录；它不继承原 Edge 的登录态。也可手动运行：

```powershell
$profilePath = Join-Path $env:LOCALAPPDATA 'ChatGPT-CDP-Profile'
& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" '--remote-debugging-port=9222' '--remote-debugging-address=127.0.0.1' "--user-data-dir=$profilePath" 'https://chatgpt.com/'
```

首次成功提问后保存实际 `/c/...` 对话 URL。也可先手动把已有对话 URL 填入 conversation.json。修改配置后重启服务。不要使用临时聊天。运行期间不要手动切换该对话或并行提问。

## 调用

```powershell
$body = @{ request_id = 'question-001'; question = '请帮我分析这个方案'; timeout_ms = 120000 } | ConvertTo-Json
Invoke-RestMethod 'http://127.0.0.1:8787/ask' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

接口：
- `GET /health`：服务是否启动。
- `GET /status`：CDP 是否连接；不代表登录及完整网页调用已验证。
- `POST /ask`：question、request_id（建议由调用者生成）、timeout_ms（1000–600000）。
- `POST /recover`：request_id、可选 timeout_ms；只恢复读取，不重新发送。
- `GET /records/{request_id}`：读取记录。
- `POST /files`：传 request_id，刷新当前轮的可下载文件列表。
- `POST /download`：传 request_id 和 file_id，保存选定文件并返回本地路径。

对话模式：`conversation_mode: "continue"`（默认）继续默认对话；`"new"` 新开独立对话。新建不会替换默认对话。继续新建或指定对话时，传 `conversation_url` 与 `continue`。每轮使用新的 request_id；同次重试保持原 ID。

响应额外提供 `generation_complete`、`generation_status`、`messages`、`user_action`、`files`。`awaiting_user_input` 表示可能需要澄清/确认，`user_action.source` 区分正文启发式与页面弹窗。正文识别是 possible 提示，应结合上下文复核；不会自动答复确认。生成结束不等于任务完成，`task_complete` 当前为 null。等待期间可 GET /records/{request_id} 查看部分回答。

返回 JSON 包含 status、answer、incomplete、conversation_url、record_path。completed 和 awaiting_user_input 对应 HTTP 200，timeout 对应 504，blocked/failed 对应 503，busy 或未恢复请求对应 409。调用方应保留 request_id，并处理非 200 响应。相同 ID 的已完成请求返回缓存；更换问题或上下文模式但复用 ID 返回冲突。

超时后调用 `/recover`。存在未确认完成的提交时，服务拒绝继续同一对话，避免把两次回答混在一起；可以显式 new 使用独立对话。若发送前就连接失败，可使用新的 request_id 重试。提交状态不确定且对话地址尚未保存时，需要在浏览器手动确认，然后将实际对话地址填入配置并重启恢复。

文件下载支持附件链接和“下载文件”按钮卡片，通过浏览器下载事件保存真实文件。2026-10-14 实测新建对话、生成 bridge-test.txt、识别待确认回复、下载并验证内容 bridge-download-ok 全部成功。期间网站下载接口曾返回 HTTP 403，后来同一文件重试成功；原始失败正文未保留，因此不能确认历史 403 的具体原因。接口不会把文件列表当成已下载结果，也不会绕过网站验证。

记录保存在 records 下，每个请求一个 JSON 和 Markdown。只运行一个服务实例；当前锁在进程内，不支持多个实例共享一个浏览器或记录目录。长对话的网页消息虚拟化、验证码、登录过期、额度限制、页面结构变化可能阻止恢复或完成识别。

技能入口在 skills/chatgpt-browser-bridge/SKILL.md；本地 Agent 可加载它，再用 HTTP 工具调用此服务。纯推理模型需要宿主程序提供工具执行能力。

内部项目需要源码保密时，参见 [内部模型与外部 GPT 协作设计](skills/chatgpt-browser-bridge/references/internal-mode.md)。当前后端仅提供网页调用能力，尚未实现设计中的强制披露审批、隔离与版本协调，不可直接作为保密网关。

框架与使用注意事项见 [docs/framework.md](docs/framework.md)。

## ZCode 执行 + GPT 决策

一键启动：`start.bat`；关闭本脚本启动的服务：`stop.bat`。安装、技能加载及长期任务恢复见 [安装说明](docs/installation.md)。`task-controller.mjs` 按任务编号保存并自动复用对话地址。

ZCode 管理自己的模型配置与凭据，本项目只提供 GPT 网页后端和摘要调用脚本，不读取执行模型的密钥。独立 DeepSeek API 客户端及 8788 协调器已移除。

使用 [ZCode 示例](docs/zcode-gpt-example.md)：ZCode 生成可披露摘要，运行 consult-gpt.mjs，保存 conversation_url，本地执行并测试，再将结果摘要发回同一 GPT 对话。
