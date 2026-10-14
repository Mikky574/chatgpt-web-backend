# 原生 GPT + DeepSeek 基础协作

已实现：coordinator.mjs（127.0.0.1:8788）、deepseek.mjs、run-session.mjs。不接 AI 工位、不读取项目文件、不执行 shell 或测试。GPT 网页是规划侧，DeepSeek 官方云 API 是文本执行侧。本版仅用于公开/合成目标，不作为内部代码安全网关。

本组合只是框架示例。adapters.mjs 分离 planner.request 与 worker.status/complete，createCoordinator 支持注入其他规划与执行适配器；当前内置 chatgpt-web 和 deepseek-api。未来 ZCode 或内网模型需新增适配器，不能仅改 provider 字符串就自动获得支持。用户当前要求只搭建框架和文档，暂停真实密钥及付费联调。

## 密钥与启动

用户将 DeepSeek 密钥自行写入项目 `.secrets/deepseek-api-key.txt`，一行纯密钥，不带引号。该文件与 .secrets 目录被 Git 忽略。不要用文件读取、终端输出、截图或搜索去查看用户密钥，也不要让用户把密钥发进对话。调用程序必须读取密钥，但不输出 Authorization、上游错误正文或密钥内容；模型上下文不包含它。程序访问权限和其他本机进程读取权限仍由操作系统控制，本实现不是密钥保险库。

配置在 coordinator.json，首次启动从 coordinator.example.json 创建。可改 deepseek_model、deepseek_thinking、时限、max_tokens、轮数，但密钥不填进配置。默认使用官方文档当前列出的 deepseek-flash、非思考模式；密钥只发送到固定 https://api.deepseek.com/chat/completions，禁跟随重定向。

先启动 Chrome 和 8787 网页后端，再执行 `npm run coordinator`。GET http://127.0.0.1:8788/deepseek/status 仅返回 configured、model、authenticated。configured 代表有非空密钥，不代表认证通过；真实调用后才能验证。

## 直接调用与协作

POST /deepseek/ask `{ "question": "公开测试问题" }`：一次原生调用，返回 answer、finish_reason、complete、usage、model。不保存独立调用历史。

POST /sessions `{ "session_id": "可选的唯一编号", "goal": "公开或合成目标", "max_rounds": 4 }`：创建会话但不调用模型。编号最多 64 字符，letters/digits/_/-。max_rounds 为 1–10。

POST /sessions/{id}/step `{}`：执行一轮“GPT 规划 → DeepSeek 文本交付”。GPT 返回 task、ask_user 或 finish；只有 task 才调用 DeepSeek。下一轮把 DeepSeek 交付回送同一个 GPT 对话，DeepSeek 也带上自己本地保存的 messages。每个协作会话新建独立 GPT 对话，不覆盖网页后端默认对话。

GET /sessions/{id}：查看过程与结果，保存在 records/sessions/{id}.json。状态 ready、running、awaiting_user、finished、round_limit 或 blocked。finished 是 GPT 主控的文本结束判断，不是代码项目的本地验收证据。

POST /sessions/{id}/reply `{ "reply": "用户选择" }`：只在 awaiting_user 时接受，之后再 step。不会自动代用户确认。

GPT 提交未知或超时时，保留原 gpt_request_id，下次 step 使用网页后端 recover，不另发请求。DeepSeek 结果未知或不完整时，后续 step 返回 409，只有显式 `{ "retry_deepseek": true }` 才重试，可能产生额外计费；不会自动重发。单服务进程内同会话加锁，不支持多进程同时操作同一状态目录。

CLI：`node run-session.mjs "公开或合成目标"`。自动逐轮调用，最多 4 次 DeepSeek 任务；遇到问题、轮数限制、错误或主控 finish 时退出并打印 session_id。结束后用 GET 查看完整记录，不打印密钥。

## 基础版本限制

双方能传对话文本和规划 JSON，不能把文本请求直接变成工具权限。不存在真实文件编辑、代码运行、测试执行、隔离出站审查与保密批准。不要把 DeepSeek 云端 API 当作内网模型；以后替换为内网模型适配器时再实现 internal-mode.md 的安全边界。

参考：[DeepSeek API](https://api-docs.deepseek.com/api/create-chat-completion/)。网页 GPT 的 JSON 需本地校验；结构错误停止，不执行任意 action。
