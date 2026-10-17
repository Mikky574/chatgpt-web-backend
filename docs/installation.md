# 安装、启停和技能加载

## 当前机器

双击项目根目录 `start.bat`：复用固定Chrome CDP登录环境，启动网页后端8787、聊天体验页与队列8789，以及已有操作手界面3030。打开http://127.0.0.1:8789/体验，不自动新增浏览器标签页。`start-web.bat`与默认启动采用同一网页通道。认证、接口与实测见[网页通道说明](web-controller.md)。已运行的服务复用，不重复启动。双击 `stop.bat`：按PID和启动时间只停止本脚本启动的服务；浏览器、登录配置与任务历史保留。启动前已存在的服务不属于本脚本，关闭其原终端或原应用即可；stop不会终止未知进程。

启动和关闭可能中断正在进行的操作，结束任务后再关闭。进程状态保存在 records/runtime/services.json，日志在该目录。端口8789为聊天页与队列，8787为网页后端，9222为CDP，3030为当前操作手界面，全部仅本机访问。启动失败时查看对应日志；执行 `powershell -NoProfile -File scripts/manage-services.ps1 -Action check` 只检查状态。

本机操作手运行时来自已构建源码 `%LOCALAPPDATA%\ZCode-CLI\ZCode-main`，Node来自其上级toolchain目录。可用环境变量ZCODE_SOURCE指定其他源码根目录。脚本不安装或重建操作手，不读取模型密钥。浏览器配置固定为 `%LOCALAPPDATA%\ChatGPT-CDP-Profile`，首次登录后持续复用；会话过期仍需重新登录。

## 首次安装或换机器

1. 安装Node.js（建议24系列）和Google Chrome。安装操作手应用及自行配置模型。官方桌面安装见 [安装文档](https://zcode.z.ai/cn/docs/install)。桌面安装并不自动生成本项目启动脚本要求的源码构建目录；使用桌面版时可从桌面打开项目，网页3030部分需单独部署。
2. 下载或克隆完整项目，双击 `start.bat`。脚本会检查Node.js与依赖是否可加载，缺少依赖时自动在项目目录运行 `npm ci --no-audit --no-fund`，安装成功后继续启动；已有可用依赖时跳过安装。首次安装需要npm仓库可达，沿用机器已有npm网络配置，不写入项目代理。失败会显示npm原始错误并停止，不会报告服务已全部启动。不要同时运行多个start.bat。手动安装仍可用 `npm ci`，验证可运行 `npm test`。
3. 3030操作手界面依赖现有源码构建产物：packages/server/dist/entry-http.js、packages/web/dist、apps/zcode-cli/packages/cli/dist/zcode.cjs及安装目录下toolchain的Node。新机器未安装这些产物时会跳过可选操作手界面，不影响8787网页后端与8789体验页；可在桌面操作手中打开本项目。
4. 首次启动固定CDP浏览器后，登录ChatGPT。不要复制Cookie进仓库，不要清空登录配置。操作手密钥由其应用管理，本项目不需要DeepSeek密钥文件。

## 技能放在哪里

当前项目已包含 `.zcode/skills/controller-operator/SKILL.md`。在ZCode中打开这个项目，然后到“设置 → 技能”刷新并启用。输入 `$` 选择 controller-operator，也可输入 `$controller-operator 帮我完成：你的任务`。拖文件到聊天只能作为临时附件，不等于安装技能。

若要所有项目可用，将整个controller-operator技能文件夹放到用户级目录 `%USERPROFILE%\.zcode\skills\controller-operator\`，再刷新并启用。[官方技能说明](https://zcode.z.ai/cn/docs/skill)确认用户级目录和刷新方式。全局技能仍依赖本项目的task-controller.mjs及本地后端；在其他项目使用时要明确本项目安装路径，不能只复制SKILL.md就假定脚本位于其他项目根目录。内部项目不因技能全局安装而获得出站披露批准。

## 很久之后恢复同一任务

task_id应包含项目代号，例如 project-a-login-fix，别复用“任务1”到不同项目。

```powershell
node task-controller.mjs list
node task-controller.mjs show project-a-login-fix
node task-controller.mjs ask project-a-login-fix path/to/approved-packet.json
# 上次超时或断线时先恢复
node task-controller.mjs recover project-a-login-fix
```

packet中的task_id必须匹配。首次ask新建主控对话，后续ask自动延续保存的URL；每轮新request_id，recover复用未完成ID。状态持久保存在 records/role-tasks/<task_id>/state.json，重启不丢失。不要删除records；迁移机器时私下备份任务状态和浏览器配置，不能提交Git。记录可能包含任务摘要和模型回答，按敏感资料处理。

状态文件丢失时不能自动找回身份，可从原请求记录和实际URL人工核对恢复；对话被删除、登录过期、页面变化或超长上下文也可能阻止继续。固定URL保证定位同一对话，不保证模型永久记住全部内容；久未处理的任务应发送经过披露检查的当前目标、版本和结果摘要。

异常退出可能留下任务目录中的.lock。先确认没有请求正在执行，再人工移除该空锁目录并recover，不能靠删除锁并重发解决不确定提交。任务编号不变即可跨操作手本地聊天继续任务。

适配器定义在role-collaboration.example.json，可复制为忽略Git的role-collaboration.json修改。消息使用主控手与操作手角色，底层模型名称留在本地部署配置；新模型仍需要兼容new/continue/recover和结构化返回值的适配器。
