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

示例：

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/tasks
```

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

这是一个单机 MVP。当前使用 JSON 文件存储，成长指标、视频内容和复盘数据仍有演示内容，尚未接入账号体系、数据库、真实媒体源、日历或外部写操作审批。后续可以在现有 API 基础上接入 SQLite/PostgreSQL、目标与项目模型、工作流和权限审计。
