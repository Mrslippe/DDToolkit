# DDtoolkit 前端（Better DD Toolkit · VTuber 帖子查看）

Vite + React 18 + TypeScript + Ant Design 5 的轻量只读管理界面：
**选 VTuber → 看账号 → 帖子列表（过滤/分页）→ 帖子详情抽屉**，并带抓取触发按钮与统计概览。

## 快速开始

```bash
# 1. 启动后端（另开终端，ddtoolkit 目录）
cd ../ddtoolkit   # 即仓库根
uvicorn app.main:app --port 8000

# 2. 安装依赖并启动前端
cd frontend
npm install --cache .npm-cache   # 沙箱/受限环境把 npm 缓存放到工作区内
npm run dev                      # http://localhost:5173
```

开发模式通过 Vite 代理访问后端：`/api/*` → `http://127.0.0.1:8000/*`（见 `vite.config.ts`）。
直连模式：`VITE_API_BASE=http://127.0.0.1:8000 npm run dev`（后端 CORS 已放开）。

## 生产构建

```bash
npm run build      # 产物在 dist/，可交给任意静态服务器或由 FastAPI 挂载
```

## 页面与功能

| 路由 | 内容 |
|---|---|
| `/` | VTuber 卡片列表：头像（本地缓存/ CDN）、粉丝数、直播状态徽标、签名 |
| `/vtubers/:id` | 账号信息条 + 统计概览（总数/类型分布/归档/时间跨度）+ 类型 Tabs 过滤 + 服务端分页表格 + 详情抽屉 |
| 抽屉 | 标题/封面/正文/图片组/统计（播放/赞/评论/转发…）/原文链接/raw_json 折叠 |

抓取按钮：`抓取账号信息`（POST /vtuber/fetch）、`抓取帖子`（POST /vtuber/fetch-posts?name=…）。

## 依赖的后端接口

| 端点 | 说明 |
|---|---|
| `GET /vtuber/list` | VTuber 列表（含账号） |
| `GET /vtuber/{id}` | 单个 VTuber |
| `GET /posts/{platform}/{uid}/paginated?page=&page_size=&type=&is_archived=` | 服务端分页 + 过滤 |
| `GET /posts/{platform}/{uid}/stats` | 帖子统计概览 |
| `POST /vtuber/fetch` · `POST /vtuber/fetch-posts` | 抓取触发 |

> 分页/统计端点为前端新增（后端 devlog/014），旧端点 `GET /posts/{platform}/{uid}` 行为保持不变。
