# 网页调用稳定性审查与流式接口探索

日期：2026-10-17。当前场景是内网操作手通过网关访问外部，不能按单机脚本直接复制来部署。

## 已确认的问题

| 问题 | 代码或行为依据 | 影响 |
| --- | --- | --- |
| 全局浏览器锁 | server.mjs在等待整个生成期间保持busy | 一个长任务会阻塞其他对话，不是所有409都意味着对话身份冲突 |
| 模糊上下文选择 | 原bridge.page只读取contexts()[0] | 多登录上下文时可能选错账号或看不到目标页 |
| 全局默认对话 | 原HTTP接口允许continue但不传URL | 调用者绕过任务控制器时容易混用默认对话 |
| 依赖页面私有结构 | 用户气泡、正文、折叠控件、完成属性 | 页面布局、虚拟化及错误横幅都可能导致错误读取 |
| 部署依赖本机运行时 | manage-services.ps1的操作手源码构建目录 | 拷贝仓库并不包含运行时、登录状态和任务数据库 |
| 本机接口不是内网网关 | 服务Host限制127.0.0.1，客户端拒绝非本机HTTP地址 | 不能直接把地址改成另一台机器的IP来部署 |
| 客户端状态与服务端状态分离 | role-tasks状态和records请求文件各自保存 | 只迁移一部分记录、改账号或多服务实例共享目录会破坏恢复条件 |

本次先做的改进：跨上下文精确匹配对话；请求绑定标签页；重复标签页或账号不明确时拒绝猜测；busy返回占用请求与elapsed_ms；支持0～15000ms有限等待（客户端默认10000ms）；新增显式refresh恢复。

这些改动没有把服务变为高并发产品：仍是单进程全局串行浏览器通道，等待不是公平持久队列，也没有跨进程锁。无法用扩大超时、自动取消其他任务或清空历史来代替作业调度。

## 现场网络探索结果

在复用本机已登录浏览器的情况下，通过正常网页输入发送公开合成问题，使用CDP Network事件读取真实响应流。不导出Cookie、Authorization值、会话令牌、恢复令牌或验证凭证。

| 环节 | 实测结果 |
| --- | --- |
| prepare请求 | POST /backend-api/f/conversation/prepare，HTTP200，application/json |
| 生成请求 | POST /backend-api/f/conversation，HTTP200，text/event-stream; charset=utf-8 |
| 流式事件 | delta_encoding、delta；含p/o/v补丁结构、消息/对话身份字段 |
| 结束标志 | message_stream_complete及[DONE]均在流中出现 |
| 认证机制观察 | 请求包含Authorization头，只记录是否存在，不记录值 |
| 浏览器内最小直接API对照 | 正常会话可获得认证信息，但直接调用生成入口返回HTTP403；未重放验证凭证、未持续重试 |

这证明网页确实存在可观察的流式传输，能够减少对DOM文字与结束按钮的依赖。不证明该私有入口已成为稳定独立API，也不证明只刷新一个登录令牌即可脱离浏览器运行。403的精确原因尚未确认；请求准备、接口版本、必要字段、客户端状态和防护均可能相关，不能只凭状态码断言是哪一种。

第一次探针误把prepare结束当成生成结束，已修正只识别生成流的结束。后续探针捕获25个data事件，并有message_stream_complete和[DONE]。HTTP连接仍可能保活，不能等待连接断开才认定本轮结束。流可能回显用户输入，不能用“流里出现测试字符串”作为助手已回答的证据；必须按assistant角色、消息ID和内容补丁重建答案。当前探针是协议探索，不是完成了该重建工作的生产适配器。

本机记录在records/stream-exploration/，仅保留请求字段类型、流事件结构、计数和HTTP状态。原始登录信息和恢复令牌值未落盘。实验请求仅使用公开合成文本。

## 两条路径应分开

**正式服务API**：使用服务端凭据和文档化接口；会话通过API自身的conversation或previous_response_id管理。它与网页聊天的URL和登录不是相同身份，不能承诺原网页对话自动变成API会话。官方说明：[认证](https://developers.openai.com/api/reference/overview)、[对话状态](https://developers.openai.com/api/docs/guides/conversation-state)。本次未增加正式API调用或要求用户密钥。

**网页会话传输**：保留外部网关上的登录浏览器，让正常前端完成认证和请求准备；后台监听对应请求的流式事件，用消息/对话ID重建结果。DOM仅用于必要提交、登录、错误提示及文件下载的后备操作。若未来验证出可复用的浏览器内请求调度接口，再减少输入框依赖；当前最小直接API实验403，不上线未经验证的HTTP重放。

不把浏览器私有接口等同于公开API；不复制验证凭证来绕过挑战。登录到期、网页验证、限流应变成明确的needs_login、needs_verification、rate_limited等状态，不能反复刷新和盲目重试。

## 内网与外部网关的建议边界

```text
内网操作手 / 内网模型 / 私有代码
  → 本地披露检查与批准后的摘要
  → 组织网关（独立认证、TLS、访问控制）
  → 外部调度服务：会话注册表 + 持久作业队列
  → 可替换传输：正式API 或 网页浏览器网络流
  → 带task、job、conversation、message身份的结果
```

账号和Cookie留在外部网关机器，CDP只绑定该机器127.0.0.1，不向内网客户端暴露9222。客户端使用网关自身的身份，不复用网页认证；内部源码不挂载到外部机器。现有8787仍保留本机防护，不能只删Host检查或绑定0.0.0.0就当作安全网关。网关部署与强制披露控制目前未实现。

会话映射应使用(project_id, task_id, provider, account_profile_id)关联唯一conversation_id，标签页target_id仅作临时句柄。不同账号或不同传输不得自动接管旧会话。网页URL只是网页适配器的一个定位字段，不是所有后端共同的身份。

## 应怎样处理冲突和页面错误

- browser_transport_in_use：本次尚未提交，返回占用request_id、操作和等待时长，可短等待；不要刷新别人的活动对话。
- unresolved_request：同一任务原请求结果未知，先recover；禁止新ID重发。
- 页面出错：先保存任务、消息锚点和事件进度；原问题已有ID、输入框无草稿、无活动生成时，可显式refresh，再按原ID读取。
- 页面仍在生成、未锚定问题、输入框有草稿：拒绝刷新，以免丢失或重复提交。
- 验证、登录失效、限流：明确暂停，人工处理或等待；不能当普通网络失败无限重试。

显式刷新命令：`node task-controller.mjs refresh <task_id>`。这会调用原request_id的/recover并传refresh_page=true，不生成新问题。API不允许refresh与retry_generation同时启用。

## 下一阶段，不伪装成已完成

1. 将提交与等待结果分成作业：POST /jobs返回202及job_id，GET /jobs/:id或事件流查询；页面阻塞不长期占住客户端HTTP请求。
2. 做持久会话注册表、按会话排队、浏览器账号级限流及跨进程作业租约；重启后恢复原job，不重复提交。
3. 将探索到的delta编码实现为有真实样本回归的解码适配器，校验conversation_id、input_message_id、assistant_message_id和明确结束事件。
4. 对比正常网页请求与直接API实验的非敏感协议结构；只在合法会话机制可重复验证后选择browser内调度或独立HTTP。不导出/伪造防护凭证来宣称接口已稳定。
5. 部署带TLS和独立认证的组织网关，提供环境自检和版本化页面适配器，再验证多任务、多账号、断线、重启、限流、验证和附件。

当前仍为实验性网页桥接，尚不适合把它描述为稳定的多租户生产API。此次本地单元/替身测试通过不等同于迁移后的真实网关、多对话高并发或独立HTTP接口验证。

## 探索工具

- `node scripts/probe-browser.mjs`：只读控件计数，不读取对话正文或凭据；附参数毫秒数可被动观察请求路径/方法/状态，不点击、不发问。
- `node scripts/explore-stream.mjs`：主动合成实验。要求唯一的空白ChatGPT主页且无草稿，发送一次公开测试消息，观察流，最多90秒；不能在真实工作对话中随意运行。
- `node scripts/probe-browser-api.mjs`：手动运行的浏览器内单次最小直接API对照，不随自动化测试执行。认证值不返回Node，不读取/重放验证凭证；403就停止。其失败不是认证链路已完整逆向的证明。

机制资料：[Playwright网络监测](https://playwright.dev/docs/network)、[CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)。
