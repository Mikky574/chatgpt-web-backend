# ZCode 通过摘要咨询 GPT

ZCode 负责读取本地项目、执行命令和测试。GPT 网页负责需求决策、边界条件和验收建议。ZCode 使用自己配置的模型密钥；本项目已移除独立模型 API 客户端、密钥文件读取及 8788 协调器。

调用关系：用户 → ZCode → 本地 8787 后端 → GPT 网页；返回后，ZCode 本地执行 → 汇总实际证据 → 同一 GPT 对话复核。GPT 不会主动唤醒 ZCode，执行方控制调用节奏。

## 可直接粘贴给 ZCode 的示例

```text
做一个独立的公开演示，不改现有业务代码：实现 pageCount(total, pageSize)。
total 必须是非负安全整数，pageSize 必须是正安全整数；非法输入抛出 RangeError，total=0 返回0。
先运行：
node consult-gpt.mjs new demo-pagination-你的唯一编号 examples/zcode-task-summary.md
从返回值保存 conversation_url。只有 generation_complete=true 且 status=completed 才继续。
根据 GPT 的验收建议，在本地 examples/demo-pagination/ 下实现并运行测试。
然后只写一份简短反馈到 records/demo-pagination-feedback.md：需求满足情况、实际测试数量、通过/失败、剩余问题和需要 GPT 决定的事项。
不得包含源码、密钥、原始日志、内部路径或完整聊天历史。
运行：
node consult-gpt.mjs continue demo-pagination-你的唯一编号-review records/demo-pagination-feedback.md 上一轮返回的conversation_url
读取复核结论；如需用户确认，停止等待用户。最多3轮，不把模型建议直接当作测试已通过。
```

## 调用与恢复

每个任务首次用 `new`，后续用 `continue` 并显式传该任务的 URL。每轮使用不同 request_id。同一次请求超时后用 `node consult-gpt.mjs recover 原request_id`，不要换 ID 重发。返回 `awaiting_user_input`、blocked、failed 或未结束时停止执行并检查返回信息。

脚本仅读取指定的摘要文件，最多12000字节，不扫描项目或上传附件。默认调用127.0.0.1:8787，GPT_BACKEND可覆盖为其他本机HTTP端口。不要把额外输出JSON存入服务的records根目录，该目录用于请求记录；额外输出用.txt或其他目录。

内部项目先让内部模型形成可公开的抽象摘要，并按内部披露规则审核。小文件和摘要仍可能泄露信息；字数限制不是保密审查。现有示例没有自动脱敏、出站批准或工具执行沙箱，不能直接作为内部项目的强制安全边界。

建议每轮摘要只包含任务编号、目标、已确认约束、行为层面的当前状态、实际测试结论、待决策问题。不传整个项目和双方全部历史；各自维护自己的上下文，以任务编号和conversation_url关联。

## 本次实测

2026-10-14：当时8787、8788、3030可达（8788现已移除）；GPT新对话返回完整决策和6个验收用例。Codex本地实现公开分页示例，10项测试全部通过，随后以同一conversation_url发送摘要复核。此记录不代表ZCode已经自动执行，ZCode应使用上面的提示词自行调用脚本。测试对话：https://chatgpt.com/c/6acee137-4c88-83ee-b19a-b5a9c5937ecb 。

## 简短调用入口

项目技能位于 `.zcode/skills/controller-operator/SKILL.md`。后续在 ZCode 中使用 `$controller-operator 帮我完成：你的任务`，或说“使用主控手／操作手协作技能完成这个任务”。若当前会话尚未刷新技能列表，在设置→技能刷新，或新开 ZCode 任务；也可明确让它读取上述 SKILL.md。用户可以继续在 ZCode 对话补充需求，执行侧只发送审核后的新增摘要。
