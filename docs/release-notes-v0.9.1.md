# DDtoolkit v0.9.1

个人向 VTuber 帖子 / 账号证据归档工具 —— 定时抓取 B 站与微博动态、账号统计并归档到本地 SQLite，桌面端浏览与管理。

## ✨ 本版本亮点

- **直播场次内容管道**（M1–M4 前端呈现）：格内单场（时间+标题+N 场计数）、hover 浮层全量、点格详情弹窗（直播信息/分类校正/弹幕词云/直播动态/内容分析预留）
- **弹幕词云（全新）**：增量摊铺加权 Voronoi 拼贴 —— 面积∝词频（单调性 100%）、力导向站点摊铺、逐个入池（150ms/词）、点击破泡局部闭合（缺口由 λ 重分配自动塞补，远处纹丝不动）、浅色填充+同色系深字、宽度自适应、圆角轮廓；「已破泡 N · 恢复」胶囊
- **滚动条设计标准**：不占宽 + 自动隐藏 + OverlayScroll 组件统一（全应用接入）
- **粉丝趋势卡重写**：ECharts 6.1 canvas 自绘（缩放/平移/双轴/容量档位）
- **二级窗口统一规格**：12px 圆角/发丝边/统一遮罩/入场动画/Esc+点击关闭/26×26 关闭钮/黑玻璃 tooltip
- **前端系统性审计**：UI-MAP 全文重写对齐、死代码清理、图表色值集中、令牌规范化

## 📦 资产

- `DDtoolkit_0.9.1_x64-setup.exe` — Windows NSIS 安装包（用户级安装）
- `DDtoolkit-portable-win64.zip` — 便携版（解压即用，含后端 onedir）

数据目录：安装版 `%APPDATA%\com.ddtoolkit.app`；便携版可设 `DDTOOLKIT_DATA_DIR` 自定义。

## 🔧 技术栈

- 后端：Python 3.14 + FastAPI + SQLAlchemy 2.0 + SQLite(WAL) + APScheduler + Alembic（迁移链 e007）
- 前端：Vite + React 18 + TypeScript + Tailwind v4 + ECharts 6 + Radix
- 桌面壳：Tauri v2（拉起后端 + 注入空闲端口 + Job Object 看门狗杀进程树）

## ⚖️ 许可

MIT License（见 LICENSE）。字体：思源黑体（Noto Sans SC，OFL 1.1）+ 阿里妈妈方圆体（官方许可免费商用+嵌入）。
