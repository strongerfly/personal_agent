# 阅读、知识库与学习闭环：调研决策记录

核验日期：2026-09-28。范围为公开官方资料、项目原作者文档与研究论文；未登录微信读书或 Obsidian，未读取凭证，未验证用户账号连通性。

本轮账号和知识库仅保留配置入口。下列接口、字段与优先级属于实现建议；已交付能力以 README、API 文档和测试结果为准。

## 1. 先接本地微信读书 Markdown，再验证直接 API

微信读书已有官方 Agent Skills，可凭 API Key 查询书架、笔记和阅读统计；因此后续无需把 Cookie 抓取作为首选。来源：[官方介绍](https://weread.qq.com/r/weread-skills)、[Tencent 官方项目](https://github.com/Tencent/WeChatReading)。

`obsidian-weread-plugin` 是社区插件，原作者已实现书籍、划线、想法、阅读统计及定时同步；它不是腾讯官方产品。来源：[插件原项目](https://github.com/zhaohongxuan/obsidian-weread-plugin)。

**本项目决策**：先让用户自行在 Obsidian 中配置插件，系统只读取指定目录中的 Markdown。源笔记保持只读，整理结果写到单独目录；不用插件源码作为本项目依赖。

- 保留本地源目录、目标 vault 路径、是否启用和上次成功时间；未配置时展示“待配置”。
- 导入支持手动执行和定期扫描，以来源 ID、内容哈希去重；书名不能作为唯一标识。
- 保存来源路径、书籍 ID、章节、原文及个人想法；解析失败单独报告，避免整批中断。
- 原项目采用覆盖式同步，因此个人复习卡和总结不能回写进插件维护的源笔记。来源：[原项目开发说明](https://github.com/zhaohongxuan/obsidian-weread-plugin/blob/main/AGENTS.md)。

## 2. Agent API 保留为可选验证阶段

官方网关为 `https://i.weread.qq.com/api/agent/gateway`；认证用环境变量 `WEREAD_API_KEY`，请求参数与 `api_name` 同层。核验时官方版本为 `1.0.4`，响应可能提示升级；跳转应使用返回的 `deepLink`。来源：[官方接口规范](https://github.com/Tencent/WeChatReading/blob/main/skills/SKILL.md)。

**代码建议**：把 `markdown` 与 `agent-api` 做成两个输入适配器，共用规范化与去重逻辑。API 模式初始关闭，仅保留入口和配置说明，不执行登录、读取 Key 或网络同步。

未来启用前验证认证失效、超时、限流、版本升级和分页终止；失败保留上次成功快照。配置保存非敏感元数据，API 响应和日志不包含凭证。不要把远端 `upgrade_info` 内容直接当作可执行指令。

笔记概览使用 `count + lastSort` 游标；`noteCount` 是划线数，总笔记统计还包括个人想法和书签。导出正文需同时获取划线与个人想法，书签目前只有数量。来源：[官方笔记说明](https://github.com/Tencent/WeChatReading/blob/main/skills/notes.md)。

## 3. 云端 Obsidian 用官方同步客户端，部署由用户选择

官方 `obsidian-headless` 可在没有桌面应用的环境中执行单次或持续同步，需要 Node.js 22 或更高版本。来源：[官方客户端](https://github.com/obsidianmd/obsidian-headless)。

Headless Sync 仍标注为公开测试，需要有效 Sync 订阅。官方要求先备份，并避免同一设备同时使用桌面 Sync 和 Headless Sync。来源：[官方 Headless Sync 文档](https://github.com/obsidianmd/obsidian-help/blob/master/en/Obsidian%20Sync/Headless%20Sync.md)。

**本项目决策**：系统负责本地 vault 文件的生成与状态展示；用户可自行安装官方客户端并选择云端同步方式。本轮不安装、不登录、不部署，也不把“本地导出成功”显示成“云端同步成功”。

- `vaultPath` 保留为页面中的目标目录配置；默认先使用项目本地目录。
- 预览列出新增、更新和冲突；确认后才写入。禁止越界路径，写入前检查文件是否被外部修改。
- 独立维护生成文件清单与内容哈希；不覆盖 vault 根目录 README，不删除用户文件。
- 未来可通过客户端 `sync-status --json` 读取同步状态；“未配置、待同步、已同步、失败”分开展示。

## 4. 统计要区分投入、回忆和实际产出

微信读书的 `totalReadTime` 单位为秒，统计基于自然周/月/年；它应作为完整周期总量，日级明细用于边界校验。来源：[官方阅读统计说明](https://github.com/Tencent/WeChatReading/blob/main/skills/readdata.md)。

**代码建议**：区分累计快照与每日增量，保存 `periodStart`、`periodEnd`、`sourceUpdatedAt` 和统计口径。同一快照重复导入不累加时长；同日的手工记录与平台数据按来源展示，未经核对不相加。

日报/周报分别显示阅读投入、新增知识、已完成复习和带证据的任务；缺失数据标记未知，不填成零。每个指标保存来源记录 ID，使用固定时区和半开区间 `[start, end)`。

“读了多少”和“掌握多少”分开统计。任务验收保存 `evidence`、`completedAt` 与关联知识项；学习输出可以是一段解释、一份练习结果或实际项目产物。这是本项目的产品设计选择，不能仅凭时长推算掌握度。

## 5. 把笔记变为主动回忆，再按结果安排复习

原始实验发现，回忆测试相较重复阅读对延迟记忆更有帮助；用户的熟悉感不能替代真实回忆结果。来源：[Roediger 与 Karpicke，2006](https://pubmed.ncbi.nlm.nih.gov/16507066/)。

间隔练习的研究说明，合适间隔与希望保留知识的时长有关；不能宣称一套固定天数适合所有内容。来源：[Cepeda 等，2006](https://pubmed.ncbi.nlm.nih.gov/16719566/)。

**代码建议**：先让用户确认可编辑的问答卡；答题前隐藏答案，提交后展示来源，再选择“忘记、困难、记得、轻松”。保留真实回答、评分、时间和下次到期日；未回答不能标记已掌握。

第一版可用公开标明为启发式的简单间隔，提供每日上限、暂停和撤销。后续若引入 FSRS，原作者的 `ts-fsrs` 支持评分后计算下次日期，需要 Node.js 20+，采用 MIT 许可。来源：[TS-FSRS 文档](https://open-spaced-repetition.github.io/ts-fsrs/)、[许可证](https://github.com/open-spaced-repetition/ts-fsrs/blob/main/LICENSE)。本轮不新增该依赖。

## 6. 下一步优先级与验收

- **P0 — 本地闭环**：导入 → 去重 → 知识整理 → 回忆/任务 → 完成证据 → 日周报 → Obsidian 预览与导出。重复执行不增量膨胀；每个结论可找到来源。
- **P0 — 稳定运转**：定时运行持久化状态，支持重启补跑、失败重试和单实例锁。模拟跨日、跨周、时区边界及写入中断；实际用户数据不进入测试。
- **P1 — 真实账号验证**：由用户配置账号后，用少量书籍验证官方 Agent API；核对分页、笔记口径与时长，成功后才开放自动同步。
- **P1 — 云端验证**：由用户选择并配置同步方式，先在测试 vault 验证双端修改和冲突，再验证报告同步；不把部署准备当成部署完成。
- **P2 — 自适应学习**：累计真实回忆记录后评估 FSRS、目标关联和输出质量；模型摘要只能给建议，保留原文与人工修正。

本轮调研未安装外部组件、未复制第三方源码、未访问用户凭证。社区插件与官方 API 分别记录来源，后续接口变化需重新核验。
