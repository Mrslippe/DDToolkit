# 531-20261018-dev环境FailedToFetch的真根因：数据根不存在

用户如实说了启动方式：`frontend` 下 `npm run tauri:dev`。据此把 `Failed to fetch` 追到底。
## 一、不是端口、不是代理
先排除了两个假线索：

- **Vite 代理（8000）不参与**：`tauri:dev` 下前端靠壳注入的 `setApiBase` 直连 sidecar
  （8765–8769），`request()` 内部会 `awaitApiReady()` 等注入完成，没有竞态。
- **代理本身好的**：后端放在 8000 时，`/api/fan/*` 四个端点经代理**全部 200**；
  只有后端不在 8000 时才是 500（那是探针自己的端口没对齐）。
## 二、★ 真根因：dev 数据目录里没有 `fan-structure`
`E:\work\Project\database\dev` 只有 `vtuber.db` / `static` / `logs` / `vtubers.csv`，
**没有 `fan-structure`**，`DDTOOLKIT_FAN_DATA_DIR` 也没设。

于是 `resolve_data_dir()` 在 `<DATA_DIR>/fan-structure` 与 `<DATA_DIR>/datasets/fan-structure`
两处都找不到 ⇒ 抛 `FanDataNotFound`。

与截图逐条对上：`（无数据）` 标签、`0 / 983 场可分析`、滑杆 `已采 0 / 待采 75` —— 全都是"没有事实表"。

## 三、两处修

**① 数据（让 dev 能看到已有的试点数据）**
给 `database\dev\fan-structure` 建 **junction** 指向仓库的 `datasets\fan-structure`
（瞬间、不复制 679 MB，源更新自动跟随）。
验证：`resolve_data_dir() = …\dev\fan-structure`，三个试点子目录都在。

**② 代码（缺数据根时不许 500）**
`session_preview` 里 `resolve_data_dir()` **没兜 `FanDataNotFound`** ⇒ 500 ⇒ 前端只看到
`Failed to fetch`。改成 **409** + 可执行的话：
「还没有任何分析数据根。请在工作台里选一个区间后点「开始采集」建立它；开发时也可以设 `DDTOOLKIT_FAN_DATA_DIR`…」
实测：数据根不存在时 `/sessions` 返回 **409**（不再是 500），消息带上具体路径。
## 四、给用户的两步
1. **重启后端**（`tauri:dev` 里 Ctrl-C 重开即可）—— 后端是 Python，改代码不热更。
2. 重启后工作台应能读到 3 个试点的 75 场事实表，`已采` 不再是 0。

## 五、仍未解释的一条

「切回帖子浏览时左栏空 / 揭幕没显示」—— 我的复现图里**左栏被正确隐藏**（工作台没留白），
说明 `data-bare` 那份改动是生效的。用户那边没生效，最可能是**窗口加载的不是同一份前端**
（`frontend/dist` 停在 2026-10-15，里面搜不到任何一个今天的标记）。待用户重启后复核。
