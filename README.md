# 个人朝廷 OS · v0.3

个人朝廷 OS 是本地运行的个人行动、阅读与复盘系统。v0.3 将三省六部落实为可操作的拟案、审议、派发和验收流程；目标、计划、任务、笔记与完成证据通过 Node.js 后端持久化。这是由用户操作的角色化工作流，尚未运行独立 AI 多代理。

仓库：[strongerfly/personal_agent](https://github.com/strongerfly/personal_agent)。产品愿景见 [设计文档](个人朝廷OS设计.md)，接入选择与来源见 [调研决策](docs/research.md)。

## 安装与启动

需要 Node.js 18 或更高版本及其附带的 npm。项目使用 Node.js 标准库，零第三方运行依赖，无需执行 `npm install`。

```powershell
git clone https://github.com/strongerfly/personal_agent.git
cd personal_agent
npm start
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。已有项目时直接在项目目录运行 `npm start`。开发模式使用 `npm run dev`，普通启动也可用 `node server.js`。

Windows 支持前台启动脚本：

```powershell
.\scripts\run.ps1
.\scripts\run.ps1 -Supervise
```

`-Supervise` 默认在异常退出后最多重启 3 次，正常退出后停止；可用 `-MaxRestarts` 调整（0–10），用 `-Port` 指定端口。也可运行 `npm run start:supervised`。终端需要保持打开；脚本不安装系统服务或开机任务，用 `Ctrl+C` 停止。

`PORT` 环境变量可修改普通启动的端口；`PERSONAL_AGENT_DATA_DIR` 可指定数据目录，默认是项目下的 `data`。不要让两个进程同时使用同一数据目录。

## 一次完整使用流程

1. 创建目标并说明动机；在三省六部首页拟定计划，或捕获想法、直接新建普通行动。
2. 计划经审议批准后派发给负责部门；普通行动可设置截止日期、预计用时和目标。晨朝按截止时间、目标、优先级与精力选出最多三项。
3. 执行行动并填写完成证据；计划中的全部行动完成后，在尚书省填写验收意见结案。
4. 导入阅读笔记，写下自己的回忆或遗忘之处，再反馈“忘记/记得”；把有用观点转成实践行动。
5. 签到记录精力、阻碍和下一步，生成日复盘或周复盘，将建议转成行动。
6. 预览后批准导出本地 Obsidian 文件，或启用定期整理。

首次启动为空数据。旧版种子任务会标记为演示记录，并排除出主要统计。缺少精力数据时显示未知；不以任务数或阅读量推算掌握度。

## 三省六部如何运转

首页展示三省待办、六部真实行动统计和部门工作台；今日、目标与行动、学习、复盘、连接入口继续保留。

1. **中书省拟案**：填写计划标题、目的、负责六部、优先级及可选关联目标；最多 8 个步骤，每步包含行动标题、验收标准和预计分钟数。草案可以暂不完整，提交审议时须补全目的及每步内容。
2. **门下省审议**：批准 `approve` 或退回 `return`；退回必须填写理由。退回后修改，再次提交审议。
3. **尚书省派发**：只有已批准计划能派发。每个步骤生成一项真实行动，继承计划部门、目标和优先级，并保留步骤验收标准；重复派发返回同一批行动。
4. **六部执行**：更新行动状态，完成时填写 `evidence`。计划派发的行动只允许修改状态和证据；标题、部门、目标、优先级、估时及验收标准沿用批准内容。
5. **尚书省验收**：全部派发行动完成且有证据后，填写验收意见结案。系统保存证据快照，结案后这些行动及证据不可修改。

计划状态依次为 `draft → review → approved → executing → completed`；审议可转为 `returned`，修改后回到 `review`。只有 `draft/returned` 可编辑计划。`revision` 随计划操作及关联行动的状态或证据变化递增，使用过期版本操作返回 409；重新读取后再操作，避免按旧证据验收。每份计划的 `history` 保留阶段、动作、意见、版本和时间。

六部工作台将所属行动与已有功能连接：吏部查看成长目标与行动；户部查看今日安排和精力签到；礼部进入阅读与主动回忆；兵部管理项目行动；刑部进入复盘；工部配置自动整理、笔记库和可选模型。部门指标包含待办、已完成、待办预计分钟、逾期与关联目标数量。历史记录中不属于六部的部门值保留原样，并计入未归属提示。

角色名称划分操作阶段，不代表不同登录身份或自治代理。系统校验流程、版本和证据是否存在，验收标准是否真正达成仍由用户判断。

## 配置入口与微信读书

账号与服务配置先保留空值；未配置不会自动登录或访问外部账号。页面设置只保存 vault 路径、阅读子目录、AI 地址和模型等非敏感信息。

微信读书当前采用**本地 Markdown 桥接**：用户自行将读书笔记同步或导出到 Obsidian，系统读取指定目录。当前没有调用微信读书官方 API，也未验证用户账号连通性。

- `vaultPath`：本地 vault 的绝对路径；留空使用 `data/obsidian-vault`。
- `readingFolder`：vault 内相对目录，默认 `WeRead`。例如 vault 是 `D:/Notes/PersonalVault`，源目录就是 `D:/Notes/PersonalVault/WeRead`。
- 点击导入后识别常用标题、作者、书籍 ID、标签、摘录与笔记。源文件只读，不回写插件维护的笔记。
- 一次扫描最多 200 个 Markdown 文件，单文件最大 512 KB；长笔记截取后给出提示，原文件保留。隐藏目录和符号链接会跳过或拒绝。

也支持粘贴文本、Markdown 或 JSON。JSON 使用数组或带 `items` 数组的对象，每批最多 500 条、请求最大 1 MB：

```json
[{"source":"manual","sourceId":"book-001","title":"书名","author":"作者","note":"自己的理解","quote":"待复习摘录","progress":50,"tags":["学习"]}]
```

相同来源与来源 ID 更新同一记录；内容未变化时跳过。请保持 `sourceId` 稳定；没有 ID 时使用回退标识，修改标题或摘录可能形成新记录。无效条目单独返回错误，不中断整批。

## 阅读复习与定期整理

复习使用简单启发式：“记得”按 1、3、7、14、30 天推进；“忘记”在 10 分钟后再复习并重置步数。必须填写回忆内容或遗忘之处，保存回答、反馈和时间。当前未使用 FSRS，也不把自评当作客观掌握证明。

日报和周报由本地规则汇总完成行动、证据、新增阅读、复习与签到，保留来源并给出最多三项下一步。同一周期重新生成会更新同一报告。

自动整理默认关闭。可以设置每日时间、每周日期和时间，以及“整理前导入阅读”。

- 固定使用 `Asia/Shanghai`。日报是自然日，周报从周一开始；当前周期只反映生成时已有的数据，包含当日的部分数据，不能视为全天或全周最终结果。
- 服务每分钟检查计划；启动或恢复后只补最近一次到期的 daily 和 weekly，不逐日补齐全部历史。
- 自动执行每个计划最多尝试 3 次，含首次；失败后分别至少等待 1 分钟、2 分钟再尝试。成功计划不会重复执行。
- 成功、失败与时间保存在运行记录中；中断中的任务重启后标记失败，再按剩余次数恢复。单个笔记异常作为警告保留并继续其他导入；目录缺失等整体故障记为失败。
- 手动补跑 `POST /api/automation/tick` 可立即重试已失败的计划，仍跳过成功计划；也可直接手动生成报告更新当前周期。
- 程序必须常驻。关闭终端、休眠或关机期间不会执行，恢复后按上述规则补跑。

自动整理只生成本地报告，不自动调用 AI 或批准云端上传。

## Obsidian 本地导出

先预览内容及新增、更新、未变化、冲突状态，再明确批准。预览 5 分钟有效；资料、配置或目标文件变化后需要重新预览。

生成内容只写入 vault 的 `PersonalCourt/Reading`、`PersonalCourt/Digests` 和 `PersonalCourt/Goals`，文件名用稳定 ID 哈希，标题保存在 Markdown 内。`PersonalCourt/.manifest.json` 记录生成文件哈希。外部修改的文件报告冲突并保留，不覆盖 vault 根 README，不删除用户文件。

这是**本地文件导出**。云端同步由用户自行配置的 Obsidian Sync 或其他工具负责；导出成功不代表云端已同步。官方 Headless Sync 是后续可选方式，本项目不会替用户安装、登录或部署。

## 可选 AI 分析

AI 默认关闭，服务地址和模型名留空。启用时填写兼容 Chat Completions 的基础地址与模型名；地址不包含 `/chat/completions`，系统会追加该路径。

密钥仅由服务进程环境变量 `PERSONAL_AGENT_AI_KEY` 提供。请在自己的运行环境中配置并重启服务；不要把密钥写入页面、代码、JSON 设置、终端输出或 Git。本项目不读取 `.env`、Cookie 或其他凭证文件，状态接口只返回是否已配置密钥。

调用前展示接收服务、模型、来源及**实际将发送的问题和记录字段内容**，经明确批准后发出请求。预览快照 5 分钟有效，问题、资料或配置变化后须重新预览。请核对出站笔记与接收服务。

AI 返回结构化总结和带来源 ID 的建议，不直接执行任务；有效结果保留最近 50 条。无效引用、超大响应、服务错误或 30 秒超时会报错。基础闭环不需要配置 AI，真实服务与账号连通性仍待用户配置后验证。

## 数据、备份、恢复与迁移

`data/store.json` 保存业务数据与非敏感设置，当前 `schemaVersion` 为 4，新增 `proposals` 计划及其流程历史。每次保存通过临时文件替换，并将保存前版本写入 `data/store.backup.json`；它只保留上一版，不代替独立备份。`data/server.lock` 防止多个进程同时写入。

已退出进程的锁使用独占恢复目录回收。如果恢复期间进程中断，服务会停止并提示检查 `server.lock-recovery`；先确认原服务均已停止、备份数据，再移走这个空恢复目录。不要在运行中手动移除锁。

日常备份：用页面“导出数据”或 `GET /api/export` 下载完整 JSON，另存到安全位置。运行数据、备份、锁文件和本地 vault 不应提交 Git。

旧 schema v1/v2/v3 加载时补齐字段并迁移到 schema v4，保留原任务、阅读、报告和设置等记录；schema v3 缺少的计划列表初始化为空，下一次保存时写入新格式。解析或结构检查失败会停止启动并保留原文件，不会用演示数据覆盖；重置接口已停用。

恢复步骤：

1. 停止所有使用该数据目录的服务。
2. 将现有 `store.json` 复制到带日期的独立备份位置，保留故障现场，同时保留 `store.backup.json`。
3. 选用可信的页面导出文件或上一版备份，确认 JSON 可解析后，复制为数据目录的 `store.json`。
4. 启动并核对任务、阅读和报告。仍失败时保留文件，检查控制台错误；不要用空数据覆盖。

升级前应独立备份。迁移不承诺旧版本可读取新结构，不在实际数据目录运行测试。

## API 概览

写请求使用 `Content-Type: application/json`。列表接口返回数组；错误为 `{ "error": "说明" }`。服务拒绝跨站写入，未知接口返回 404。

- 状态与备份：`GET /api/health`、`/api/state`、`/api/overview`、`/api/morning`、`/api/export`。
- 朝廷概览：`GET /api/court` 返回三省待办、六部统计和未归属行动数；`GET /api/state` 同时包含 `proposals` 与计算出的 `court`。
- 计划：`GET/POST /api/court/proposals`、`GET/PATCH /api/court/proposals/:id`。创建字段为 `title`、`intent`、`dept`、`goalId`、`priority`、`steps`；每步为 `title`、`acceptance`、`minutes`，编辑已有步骤时保留其 `id`。
- 流转：`POST /api/court/proposals/:id/submit`、`/review`、`/dispatch`、`/accept`。编辑和流转传当前整数 `revision`；审议另传 `decision: approve/return` 与 `note`，验收传非空 `note`。已派发计划重试 `dispatch` 只返回原有行动，不重复写入，也不因旧版本重复生成。
- 行动与目标：`GET/POST /api/tasks`、`PATCH /api/tasks/:id`；`GET/POST /api/goals`、`PATCH /api/goals/:id`。完成行动必须提供 `evidence`。
- 收件与签到：`GET/POST /api/petitions`、`POST /api/petitions/:id/convert`；`GET/POST /api/checkins`。
- 阅读：`GET /api/reading`、`POST /api/reading/import`，别名 `/api/integrations/wechat-reading/import`；`POST /api/reading/:id/review`、`/api/reading/:id/task`。
- 复盘：`GET /api/digests`、`POST /api/organize/run`（`period: daily/weekly`）、`POST /api/digests/:id/actions/:index`；`GET /api/events`、`/api/runs`。
- 设置与计划：`POST /api/settings`；`GET/PATCH /api/automation/config`、`POST /api/automation/tick`。
- 本地 vault：`GET /api/obsidian/status`；`POST /api/obsidian/import`、`/api/obsidian/preview`、`/api/obsidian/export`。导出需有效 `previewId` 与 `approved: true`。
- AI：`POST /api/ai/preview`、`/api/ai/run`。调用需有效预览、原问题与 `approved: true`，未配置返回前置条件错误。

## 验证与运行边界

```powershell
npm test
```

测试使用独立临时目录，验证 API、持久化、导入、调度与集成边界；结果以命令输出为准。手工检查可在启动后访问 `/api/health`，走一遍“拟案—提交—退回—修改—批准—派发—完成证据—验收”，核对刷新后的历史与状态，再导入笔记、生成报告和预览导出。

服务固定监听 `127.0.0.1`，供单人本机使用。当前没有登录、多用户权限或公开服务需要的防护，**不要直接开放公网或通过隧道公开访问**。

未实现：微信读书账号直连、云端部署与同步验证、独立多智能体编排、日历和会议录音接入、视频转写与生成、向量检索及自动知识掌握评估。当前聚焦可持续运行的“记录—行动—证据—复盘”。
