# 个人朝廷 OS

个人朝廷 OS 是一个本地运行的个人工作与成长管理系统。它把任务、奏折、部门事务和复盘放进同一个工作台，前端页面通过本地 API 读写数据。

项目仓库：[github.com/strongerfly/personal_agent](https://github.com/strongerfly/personal_agent)

## 快速开始

环境要求：Node.js 18 或更高版本。项目不依赖第三方 npm 包。

```bash
npm start
```

启动后打开 <http://127.0.0.1:3000>。

开发模式可以使用 Node.js 自带的文件监听：

```bash
npm run dev
```

也可以直接运行服务：

```bash
node server.js
```

## 当前能力

- 今日朝报：查看今日重点、执行中事务、待批示数量和部门状态。
- 奏折收件：创建草稿、递交奏折，并把已递交奏折转成任务。
- 六部事务：按部门和状态筛选任务，执行批示和验收。
- 整理与同步：运行每日/每周整理，导入微信读书记录，预览并导出 Obsidian Markdown。
- 成长账、视频奏报、史馆复盘：提供当前工作台的展示和后续接入位置。
- 数据管理：导出 JSON，或恢复演示数据。
- 服务状态：页面会显示本地后端是否连接成功。

任务状态按以下顺序流转：

```text
待确认 → 执行中 → 已完成
```

## 数据和 API

首次启动时，服务会自动创建 `data/store.json`。任务和奏折写入这个文件，重启服务后仍然保留。该文件是运行时数据，不需要提交到 Git。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/health` | 检查服务状态 |
| `GET` | `/api/tasks` | 读取任务，支持 `dept`、`status` 筛选 |
| `PATCH` | `/api/tasks/:id` | 更新任务状态 |
| `GET` | `/api/petitions` | 读取奏折 |
| `POST` | `/api/petitions` | 创建草稿或已递交奏折 |
| `PATCH` | `/api/petitions/:id` | 更新奏折状态 |
| `POST` | `/api/petitions/:id/convert` | 将奏折转成任务 |
| `POST` | `/api/reset` | 恢复演示数据 |
| `GET` | `/api/export` | 导出当前数据 |
| `GET` | `/api/overview` | 获取运行总览和最新整理报告 |
| `GET` | `/api/events` | 查看最近的事件记录 |
| `GET` | `/api/digests` | 查看日报/周报 |
| `POST` | `/api/organize/run` | 手动运行每日或每周整理 |
| `GET/PATCH` | `/api/automation/config` | 查看或保存自动整理计划 |
| `GET` | `/api/reading` | 查看阅读记录 |
| `POST` | `/api/reading/import` | 导入阅读 JSON 快照 |
| `POST` | `/api/integrations/wechat-reading/import` | 微信读书导入别名 |
| `POST` | `/api/obsidian/preview` | 预览拟写入的 Markdown 文件 |
| `POST` | `/api/obsidian/export` | 在批准后导出到 Obsidian 目录 |
| `GET` | `/api/obsidian/status` | 查看导出目录和最近同步状态 |

示例：

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/tasks
```

## 微信读书整理

当前采用“用户导出后导入”的方式，不依赖未经授权的私有接口，也不会在项目中保存微信账号凭证。在“整理与同步”页面粘贴 JSON 数组即可：

```json
[
  {
    "title": "书名",
    "author": "作者",
    "progress": 80,
    "note": "我的笔记",
    "quote": "原文摘录",
    "tags": ["数据分析"]
  }
]
```

服务会规范化记录，并按来源、标题、作者、摘录和完成时间生成指纹，重复导入会跳过。后续可以把微信读书的浏览器采集器或用户授权连接接到同一个导入接口。

## 定期整理

整理工作流先用确定性规则汇总任务、奏折、阅读和事件，生成 Markdown 报告并保存在 `data/store.json`。可以手动调用：

```bash
curl -X POST http://127.0.0.1:3000/api/organize/run \
  -H "Content-Type: application/json" \
  -d '{"period":"daily"}'
```

页面中也可以运行今日整理或本周整理。自动整理默认关闭，打开页面中的“启用自动整理”后，常驻的 `npm start` 进程会按上海时区检查每日和每周计划。服务停止期间不会补跑任务；需要长期稳定运行时，应使用 Windows 任务计划程序或其他进程管理器保持服务常驻。

## Obsidian 同步

系统先生成 Obsidian 兼容的 Markdown 文件，再由 Obsidian Sync、Git、OneDrive 或 WebDAV 等方式完成云端同步。默认导出目录是 `data/obsidian-vault`，也可以在启动前指定一个已经由 Obsidian 或云盘管理的本地 vault：

```powershell
$env:OBSIDIAN_VAULT_PATH="D:\Notes\PersonalVault"
npm start
```

页面会先提供文件预览，点击“批准并导出”后才写入。当前目录结构为 `10-阅读/`、`20-整理/` 和根目录 `README.md`。系统只保存 vault 路径和导出记录，不保存云端账号密码或 Token。

## 目录结构

```text
.
├─ dist/index.html          # 前端工作台
├─ server.js                # Node.js HTTP 服务和 API
├─ package.json             # 启动脚本
├─ data/store.json          # 运行时生成的本地数据
└─ 个人朝廷OS设计.md         # 产品设计、实现状态和下一阶段规划
```

## 验证

```bash
node --check server.js
npm start
```

启动后访问 `/api/health`，返回 `ok: true` 即表示后端已启动。页面顶部显示“本地服务已连接”时，前端和后端通信正常。

## 当前边界

这是一个单机 MVP。当前使用 JSON 文件存储，成长指标、视频内容和复盘数据仍有演示内容，微信读书采用导入快照方式，Obsidian 采用本地 vault 单向导出。系统尚未接入账号体系、数据库、真实媒体源、日历或微信读书私有接口。后续可以在现有 API 基础上接入 SQLite/PostgreSQL、目标与项目模型、模型摘要、授权连接器和权限审计。
