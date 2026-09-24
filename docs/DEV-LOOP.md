# 开发态快速验证（DEV-LOOP）——不打包也能验证改动

> 起因（2026-09-08）：连续两个 bug（NSIS 资源打平、扫码轮询读错字段）都只能靠
> `npm run release`（PyInstaller + cargo + NSIS，4–6 分钟）出包后人工试出来，
> 一轮排查要十几分钟。实际上**绝大多数改动都不需要整包重建**——把「要验的状态」
> 搬到能秒级复现的环境里即可。

## 一、先分清「要验的是什么」

打包版之所以会坏，通常不是因为「打包」本身，而是因为打包版才具备的状态：

| 打包版独有的状态 | 开发态默认没有 | 怎么在开发态复现 |
|---|---|---|
| 全新数据目录（无 `.env` / 空库） | 项目根 `.env` + 老库 | `DDTOOLKIT_DATA_DIR=<空目录>` |
| 冻结运行时（PyInstaller `_internal`） | 源码直跑 | `python scripts/build_backend.py` 后直接跑 exe |
| Tauri 资源映射（installer 布局） | 无 | 只有它需要整包重建（改 `tauri.conf.json` 时） |
| 前端产物（`dist/` 打包进 exe） | Vite dev server | `npm run dev` + `VITE_API_BASE` 指到后端 |

**结论**：后端逻辑 / 登录 / 首启 / 迁移类改动 → 秒级或 1 分钟级就能验完；
只有动到 Rust（`src-tauri/src`）、`tauri.conf.json`、或需要真机确认前端产物时才整包重建。

## 二、一条命令的快速自检

```powershell
python scripts/dev_check.py             # 语法扫描 + 单测 + 开发态后端冒烟（约 20 秒）
python scripts/dev_check.py --frozen    # 追加：冻结后端 exe 冒烟（需先 build_backend，约 1 分钟）
python scripts/dev_check.py --portable  # 追加：重打便携 zip（免 cargo/NSIS，约 2 分钟）
python scripts/dev_check.py --full      # = --frozen --portable --docs --upstream
```

它做三件事：

0. **全仓 Python 语法扫描**（`ast.parse`，105 个文件约 0.2 秒）—— 没有任何其它门禁会编译
   `scripts/`，所以工具脚本的语法错误会**静默绕过全部红灯**：
   2026-09-16 实测在 `ui_probe.py` 的一句 help 文案里写了直引号 ⇒ 探针整体不可用，
   而 pytest / tsc / eslint / doc_check 全绿（devlog/131）。这一步就是为它加的。
1. `pytest tests/` —— 回归网（**基线数字只在 `docs/TODO.md` §6.2 维护**，别处一律不复述；含 B 站扫码四态、同名 cookie 冲突、
   账号白名单回填、首启标记等回归用例）；
   **另加前端三条**：`npm run lint`（eslint，`--max-warnings 0`）、
   `npm run test`（vitest，纯函数单测）、`npm run check:dates`（日期区间 30 条断言）
   —— 已并入 `dev_check.py` 的 `frontend logic` 一项；缺 `frontend/node_modules`
   时显式打印 `[skip]` 而非静默通过；
2. **空数据目录**起后端（源码或冻结 exe）→ 验 `/healthz` + 扫码状态机
   （`qr/start` → 连续 `qr/check` 必须停在 `waiting`，防「读错 code 字段」回归）；
3. 需要时重打便携 zip。

失败时会把现场数据目录打印出来（`console.log` / `logs/sidecar.log`）便于定位。

### 桌面端图标（LOGO 变更后重生成）

```powershell
python scripts/make_icons.py     # 从 docs/design/png/NGNlogo无底.png 生成
```

品牌粉圆角底 + 白猫脸，输出 `frontend/src-tauri/icons/`（含多尺寸 `icon.ico`、
`icon.png`、Windows 商店 `Square*Logo.png`、`icon.icns`）。改 LOGO 后跑一次即可。

## 二·五、布局类改动的机器验证（`scripts/ui_probe.py`）

布局问题（原生滚动条、内容出窗、出现滚动条导致宽度跳动）肉眼难复现、打包才暴露。
2026-09-08 起固化为可复跑的探针：

```powershell
python scripts/ui_probe.py                          # 1100 / 1280 / 1440 三档宽度
python scripts/ui_probe.py --width 1100             # 指定宽度
python scripts/ui_probe.py --height 680             # 矮窗（视口 ≈541）：验弹窗高度兜底路径
python scripts/ui_probe.py --shot                    # 额外每档宽度存一张「筛选弹窗打开态」图
python scripts/ui_probe.py --archive                 # 只跑一档：dump 直播日历每格实渲染 + 最近一场详情弹窗内容
python scripts/ui_probe.py --first-run --width 1100 # 空数据目录：验首启登录浮窗（走独立契约，不做布局断言）
python scripts/ui_probe.py --vtuber 15 --width 1280  # 指定 V（默认取列表第一条）——用于命中多平台药丸等特定数据形态
python scripts/ui_probe.py --hero-print --vtuber 15  # 只打印 cards 视图 hero 药丸签名与实测明细（建立基线用）
python scripts/ui_probe.py --hero-expect <sha256>    # 位级回归：hero 药丸签名必须与基线一致，否则退出 1
python scripts/ui_probe.py --archive --archive-print --vtuber 15      # 取「日历格内文本」基线（A-2 取数链路护栏）
python scripts/ui_probe.py --archive --calendar-expect <sha256> --vtuber 15  # 重构后比对日历格签名
python scripts/ui_probe.py --archive --archive-day 11 --vtuber 14    # 点指定日号的格子（最近一场常未收录弹幕/热词）
python scripts/ui_probe.py --settings --vtuber 15   # 档案设置弹窗：几何 + **可点性** + 点候选行换来源（两个带签名账号）
python scripts/ui_probe.py --settings --vtuber 14   # 同上但只有一行且签名长：断言渐隐/可滚距离，切换断言打印 [跳过]
python scripts/ui_probe.py --scene --vtuber 15      # 场景切换机（切 V）：预取→退场→提交是否走完 + fetch 全程
python scripts/ui_probe.py --add-v --vtuber 15      # 添加 V 浮窗：本地/上游**来源分流** + 行可命中 + UID 换档
python scripts/ui_probe.py --polish                 # R15 三处前端打磨（devlog/087）：标题粗体不撑破 /
                                                    # 筛选钮「文字+箭头」组居中 / 药丸「+」未 hover 不占位且 hover 可点
python scripts/ui_probe.py --reservations           # R13 预约进日历（devlog/088）：脚本先往**数据副本**种一条
                                                    # 明天的预约 → 断言格子徽章/时刻/人数/标题 + hover 浮层条目
python scripts/ui_probe.py --capabilities            # 未登录提示：该说的都说了 + 功能没被过度限制
python scripts/ui_probe.py --status-island           # R12a/R12b 顶栏状态岛（devlog/089、090）：空闲无容器 +
                                                     # 空闲轮播在走且不出进度词 / 消息点亮 / 面板可命中且不挤动
                                                     # 右栏 / Esc 收起 / ttl 过期自清 / 入场动画真的挂上
python scripts/ui_probe.py --app-settings            # R14a 应用设置（devlog/091）：齿轮可点 → 弹窗几何/命中 →
                                                     # 可写+只读都渲染（只读逐条带理由）→ 越界被拦 →
                                                     # 保存后**再问一次后端**对账 → 恢复默认回默认值
python scripts/ui_probe.py --filter-pill             # R16 两枚「筛选」浮片逐项对账（devlog/093）：侧栏那枚当基线，
                                                     # list 那枚每个样式字段都要相等（唯一例外 minWidth）+
                                                     # 三态（静态/真实最长/合成超长）的文字居中与 caret 间距
python scripts/ui_probe.py --tray-suspend            # R18 托盘隐藏后的**停表**验证（devlog/095）：可见时轮询在跑
                                                     # （基线）→ 隐藏后请求停住、空闲轮播停住 → 唤回立刻补一轮
python scripts/ui_probe.py --close-ask               # R20 首次点 ✕ 的询问流程（devlog/097）：ask 弹框（两选项 +
                                                     # 记住）→ 选托盘则写偏好并隐藏 → 再点不再问
python scripts/ui_probe.py --switch-perf --vtuber 15 # **切换性能测量**（devlog/132、133）：视图与 V 切换的
                                                     # 「点击 → 目标可见」耗时分布 + 连点 + 主线程长任务
python scripts/perf_report.py --affinity-proxy      # **整机体检**（devlog/134）：整棵进程树的内存/线程/句柄 +
                                                     # 冷热启动 + 空闲 CPU + 托盘深休眠 + 单核亲和代理（约 4 分钟，
                                                     # 自动解压便携版、跑完自清；--keep 留现场、--json 落基线）
python scripts/ui_probe.py --profile-sync --vtuber 15 # R33（devlog/135）：左栏是否跟着「档案设置」的签名/头像
                                                     # —— 探针往副本 DB 种 override，再断言左栏实际渲染值 + 对照组
python scripts/ui_probe.py --board                    # R37-P2b（devlog/144）：档案视图的**可编辑画布**
                                                     # —— 切视图 → 进编辑态 → 合成 PointerEvent 把第一张卡
                                                     # 右移 2 列/下移 1 行 → 断言格位变化 + 零重叠 + **去后端对账**
                                                     # （GET /vtuber/{id}/profile-cards 必须已是新位置）；
                                                     # 窄窗另跑一格：单列 + 编辑按钮必须禁用
python scripts/ui_probe.py --pinned                   # R35（devlog/139）：置顶动态排在「帖子列表」第 1 张 + 带角标
                                                     # —— 种一条 **2020 年时间戳**的置顶帖（排序不生效必掉到末尾）
                                                     # + 一条当下的对照帖（不许挂角标）
python scripts/ui_probe.py --shot-board               # R37-P4a（devlog/146）：档案视图**视觉存档** ——
                                                     # 阅读态 / 编辑态 / 动效调测页各一张（先「重置默认」再截）
python scripts/ui_probe.py --motion-cards             # R37-P4b（devlog/147）：档案视图**手势动效**
                                                     # —— 合成 pointer 走「按下 → 长按 350ms 拾起 → 跟手 1:1
                                                     # （含跨格）→ 抬手落位 → 收尾」，断言相位链 / 缩放档 /
                                                     # 跟手误差 ≤2px / **连续小步跟手（12 步逐步判，devlog/150）** /
                                                     # **进编辑态不推动画布** / 落位无内联残留 / 短按不被迟到定时器拿起
python scripts/ui_probe.py --motion-trace             # **手感报障先跑这个**（devlog/150）：模拟真鼠标小步连续移动
                                                     # 26 次，逐步打印「卡片中心实际 vs 期望」误差 + 模型格位 +
                                                     # 内联 transform + DOM 顺序。**测量模式、不做断言** ——
                                                     # 误差在 0 与 ±一格之间来回跳 = 跟手补偿取错了格位
python scripts/ui_probe.py --motion-cards --reduced   # 同上，但给浏览器加 `--force-prefers-reduced-motion`：
                                                     # 断言缩放归零、落位不过渡，而**跟手仍 1:1**（那是输入反馈）
python scripts/ui_probe.py --motion-scroll            # R37-P4d（devlog/151）：**拖到边缘自动滚动** —— 把卡片拖到
                                                     # 底部触发区停住 ⇒ 画布自己滚（≥200px）/ **卡片钉在手指下
                                                     # （同步误差 ≤2px）** / 模型行号与网格高度跟着涨；回到顶部区
                                                     # 反向滚；抬手停表；缩放手柄同样适用
python scripts/ui_probe.py --deck                     # R40（devlog/158）：**数据视图牌堆**（一次一张卡）——
                                                     # 方向语义（向下=前进/向上=退回，按 CSS 落点判）、
                                                     # 一格一张、锁内反向不吞（欠账）、快拨到末张的耗时、
                                                     # 键盘五键与首尾不越界、圆点与真值同源、非前卡 inert+aria-hidden
python scripts/ui_probe.py --motion-lab               # R37-P4b：动效调测页（`?motion=cards`）—— 面板是**动态载入**的，
                                                     # 载入失败只会「什么都没有」⇒ 断言面板挂上 + 「按下」真能驱动手势
```

> `--motion-cards` / `--motion-lab`（2026-09-18 起，devlog/147）：**虚拟时间下 CSS 过渡不推进** ——
> 实测 `getAnimations()` 里过渡是 `running`，但 `currentTime` 恒为 0，于是 `getComputedStyle().transform`
> 永远停在**过渡起点**（按下时读到 1、落位后还读到拾起时的矩阵）。所以动画类的断言只能判两件事：
> ① **我们提交了什么**（读 `element.style.transform` 内联值）；② **过渡有没有登记**
> （读 `transition-duration`）。想看动画真的怎么走，用调测页的 0.25× 慢放，别指望 computed。
>
> `--motion-trace`（2026-09-18 起，devlog/150）：**"手感不对"先跑它**。它按真鼠标的节奏小步连续移动
> 并逐步量误差 —— 抽两点采样会**假绿**（第一版 `--motion-cards` 只量"同格 +30"和"跨一格"，
> 恰好一个不跨格、一个跨格，两点都对，而真实输入的每一步都在错，误差 212.5px）。
> 手感类断言一律**按真实输入节奏连续采样 + 把误差写成数字**。
>
> `--motion-scroll`（2026-09-19 起，devlog/151）：**虚拟时间下 rAF 几乎不被服务** —— 实测 400ms 里只被叫
> **0–1 次**（`--motion-scroll` 的打印行里有这个计数）。所以自动滚动的循环是 **rAF + 定时器双驱动**
> （真机靠 rAF 跟帧率、探针靠定时器可观测，两者共用一个 8ms 闸门防止滚两倍速）。
> 另外两条探针侧的坑：合成 `pointermove` 必须派发在**网格**上（监听挂在 `.board-grid`，
> 派发到祖先不会向下冒泡）；两段手势之间要**等保存落地**（`busy` 期间 `beginDrag` 不接新手势）。


> `--profile-sync`（2026-09-17 起，devlog/135）：**我看不到界面时它就是眼睛**（DSH 自己的窗口压在上面）。
> 两个坑写在这里免得再踩：① 探针跑在**虚拟时间**下，图片加载**永远完不成**，Radix 的 `AvatarImage`
> 因此不挂 `<img>` ⇒ 头像要读**为可测性挂上的** `data-src` / `.hero[data-avatar-src]`（别当冗余删掉）；
> ② 种进 `vtubers.avatar` 的头像**必须挑非 B 站账号**那一枚，否则旧代码"恰好"取到同一个 URL ⇒ 断言假绿。
>
> `--pinned`（2026-09-17 起，devlog/139）：跑在**未登录副本**上（`_prepare_logged_out()`）——
> 第一次实现跑在有凭据的副本上，后端起来就抓动态流，而 R35 的置顶集合同步会把**种下的假置顶帖**
> （不在上游置顶集合里）当场撤销 ⇒ 断言时绿时红。未登录现场连一次上游请求都不发，本地帖子照常渲染。
> 判据的牙口在**时间戳**：种下去的置顶帖是 2020 年，排序一旦失效它必然掉到列表末尾。
>
> 「四角白边」这类**窗口层**的问题探针看不见（不是 DOM），当时的取证办法（一次性脚本，未进仓库）：
> 把窗口挪到**第二块显示器**（第一块被 DSH 窗口压着，截到的是别人的窗口）→ `SetWindowPos(TOPMOST)` →
> `GetWindowRect` + `CopyFromScreen` → 沿四角**对角线逐像素**读 RGB。
> 判据：角上像素若比底色**更亮且偏冷**，就是"底色压在白底上"；若与桌面同温，说明只是正常抗锯齿。
>
> `--archive` 的 **R36 段**（2026-09-17 起，devlog/140）：打开场次详情弹窗后**连采两格**
> （点格子后 120ms = 上游未到位 / 稳定后 = 到位），比**滚动内容高**（`.lc-dlg-body .os-scroll`
> 的 `scrollHeight`）+ 窗高 + 两列区 + 右列卡 + 速览卡，并要求四处一致；另断言速览卡紧贴
> 封面下方（间距 12px、同宽 264）且四枚胶囊 2×2 不越界。
> 两个坑：① 后端对上游有 **10 分钟缓存** ⇒ 不拦的话第二次跑同一场次会"两格都采到位态"（判据空转），
> 所以探针自己把 `/upstream` 压后 2.5s 来**造**未到位态；② **窗高在内容顶到 `max-height` 后恒等**
> ⇒ 只比窗高是假绿（反向验证实测：把预留高度改成 0，窗高仍然相等）—— 有牙口的是**内容高**。

> `--switch-perf`（2026-09-16 起，devlog/132；R31 起带一条硬判据，devlog/133）：耗时**只打印**
> （单次下限本来就是刻意退场 `useSceneTransition.EXIT_MS`，为了全程不出现「正在加载」闪帧），
> 判失败的两条是「切换没落地」与「**连点重播了退场**」（连点该比单次**更快** —— 退场只播一次）。
> 本机 dev 构建实测（1280 宽，同一台机器两次跑）：
> · 改前（devlog/132，`EXIT_MS=200`）：视图切换 210ms ×4 / V 切换 225–230ms / 连点（60ms 间隔）**270ms**、
> 长任务 0 条 ⇒ 时间几乎全在那 200ms 动画上，挂载与渲染不是瓶颈；连点 270 ≈ 60 + 210 ⇒ **重播了一整轮退场**；
> · 改后（devlog/133，`EXIT_MS=150` + 连点直接提交）：视图切换 **165ms** ×4 · V 切换 **165–170ms** ·
> 连点 **75ms**（比单次快 90ms ⇒ 没重播退场）· 长任务 0 条。

> `--polish`（2026-09-15 起，devlog/087）：三条都是"差 2px 肉眼看不出"的占位/对齐问题，所以**全部量出来**：
> ① 顶栏标题的字重与**文本实际宽**（粗体更宽，断言不撑破 150px 容器）；
> ② 筛选钮**「文字 + caret」这一组**的左右间隙（实测文字本身早已居中，偏的是被钉在最右角的 caret ——
> 这条判据的第一版量错了对象：`selectNodeContents` 把绝对定位的 caret 也算进去了）；
> ③ 药丸「+」的**两个状态**：空闲高度 0 / 不可命中 / 徽标→分割线 = 10px，hover 后 37px / 可命中 / 离开复位。
> ⚠️ CSS `:hover` 在 `--dump-dom` 里无法模拟，所以 `.stat-sets` 上挂了 React 维护的 `data-hover`，
> 探针派发 `pointerover/pointerout` 翻转它 —— **这个属性就是为可测性存在的**，别当冗余删掉。

> `--reservations`（2026-09-15 起，devlog/088）：**探针自己造现场** ——
> 开发库里未必有未来的预约（实测 V14/V15 都是 0 条），靠数据碰运气会让断言空转。
> 脚本在起后端**之前**往数据目录副本的 `posts` 里插一条明天的预约帖
> （`desc1` 用完整日期而不是"明天 HH:mm"：后者按帖子发布日推断，与运行时刻耦合），
> 然后断言"格子上真的出现了预约"。断言链覆盖 `posts.body_json` → 服务端解析 → API → 格子/浮层。
>
> ⚠️ 顺带一条实测教训：**日历签名（`--calendar-expect`）会因数据变化而漂**，
> 与本批代码无关的漂移也可能发生（2026-09-15 当晚 V15 新落库两场直播，
> 签名从 `48519bae…` 变成 `50b78ec0…`）。判断方法：先问仓库层"这个 V 有没有未来预约"
> （`VtuberEventRepo.future_reservations`），排除自己的改动，再重取基线。

> `--status-island` 里的**空闲轮播**（2026-09-15 起，R12b devlog/090；**R19 起下线**，devlog/096）：
> 轮播是"随时间自己变"的界面，静态 `--dump-dom` 一眼看不出它在不在走，所以探针**连采三次**
> （每次间隔 7s 虚拟时间）。**当前断言与 R12b 那版相反**（语录集暂时下线）：
> 空闲文案必须**恒为「数据服务运行中」**、索引恒为 0、`data-idle-carousel === 'off'`；
> 池子与扩展点照旧量（池子还在 = 实现没被删；池内**不许出现进度词**
> `轮询`/`抓取中`/`同步` —— 那句"语录是长期驻留文案，写成进度词就破坏了『自动节拍不占顶栏』"
> 的教训将来接真实条目时同样成立）。
> ⚠️ **上线时是两处一起改**：`IDLE_CAROUSEL_ENABLED = true` + 恢复"必须轮播/索引前进/文案不重复"
> 那组断言（探针读的 `data-idle-carousel` 会对不上而报红 —— 故意的，省得悄悄开了没人知道）。
> 入场动画同理：量的是 `getComputedStyle(panel).animationName` 与 `getAnimations()`，
> **CSS 文件里写了不算数**。reduce 支路用 `--force-prefers-reduced-motion` 跑一次即可验证
> （实测 `si-panel-in-fade` / 180ms / `motionReduced=true`），探针本身按 `matchMedia` 自动分派；
> chevron 也要断言"展开后翻转了"（计算值是**带 `-1` 的矩阵**）—— **reduce 下不许把状态指示一起减掉**，
> 减的应该是位移与插值（实测 reduce 支 `transform=matrix(-1,0,0,-1,0,0)` / 过渡 0ms）。
> ⚠️ 量 chevron 之前**必须先注入 `transition:none !important`**（读过渡时长要在注入之前）：
> 虚拟时间会把 `transition: transform .2s` 冻在中途，直接读计算样式读到的是**过渡进度**
> （可能是 identity 矩阵）而不是"规则有没有生效" —— 2026-09-15 因此得到过一条时绿时红的判据
> （同一天两次跑，一次 `matrix(-1,…)`、一次 `matrix(1,…)`）。判据说到底只有两种：
> **量"有没有生效"就掐掉动画/过渡，量"动画对不对"才让它开着**。
> ⚠️ 与 `--settings` 的取舍不同：那边为了量几何先注入 `animation:none; transition:none`，
> 这边**故意不冻结**（冻结了就没得量）；代价是几何可能停在动画中途，
> 所以断言留了余量（位移 6px、缩放 1.5% 都不影响 `elementFromPoint` 与"不挤动右栏"）。

> `--app-settings`（2026-09-15 起，R14a devlog/091；R17 扩到两栏，devlog/094）：本仓库第一条
> **会写盘的探针** —— 它真的 `PUT` 一次设置、再恢复默认。所以纪律与 `--reservations` 相同：
> 跑在**数据目录副本**上，绝不碰开发库。判据要点：
> ① **判"弹窗关没关"必须看 `data-state`，不能看节点在不在** —— radix 的 `Presence`
>    会把关闭后的内容留着播退场动画，而虚拟时间下动画不跑完 ⇒ 节点永远在。
>    2026-09-15 因此得出过一个**错误结论**（"radix 的 Esc 在本应用里不生效"，还照此自己挂了一条
>    Esc 监听）；改成看 `data-state` 后复测：radix 那条一直是好的，自挂的那条是多余的，已删。
>    教训：**先怀疑判据，再怀疑被测对象**（与 devlog/071→080 的"卡死"反转是同一类）。
> ② 保存后的对账**不看界面回显**，而是在页面里再打一次 `GET /settings` ——
>    回显可以来自本地草稿，"存了没生效"照样能让回显正确。
> ③ 越界值断言"保存钮禁用 + 红字"（前端那道）；后端的 400 由 `tests/test_runtime_settings.py` 钉。
> ④ 主题（R14b）也在这一条里：切「跟随系统」→ **再问一次后端**确认偏好落库 → 断言
>    `html[data-theme]`；系统是深色时还要求界面**给出那句"深色尚未实现"的说明**。
>    本机默认是浅色系统，验深色那一支要额外跑一次：给 Edge 加 `--force-dark-mode`。
> ⑤ **R17 起设置窗口分页**（左导航 + 右内容），探针多了两条纪律：
>    · **每次交互前重查节点** —— 切页 = 卸载重挂，早先抓到的 `input` 是游离节点，
>      写它不触发 React `onChange`（表现成"保存了但服务端没变"）。与 devlog/071→080
>      的"读了旧 DOM 节点"同类，这次由分页引入。
>    · **文案匹配别写死**：按钮从「全部恢复默认」改成「恢复全部默认」，正则 `/恢复默认/`
>      就再也匹配不到（报"底部没有这个按钮"）—— 判据把测试坑了。改成 `/恢复.*默认/`
>      并把按钮文案打进结果（`resetBtnLabel`），下次改名一眼能看出来。
> ⑥ `--shot` 给这一条加了个开关：URL 上的 `&keepOpen=1` 让探针**跳过收尾的 Esc**，
>    于是能截到"弹窗开着"的图做视觉存档（`ui_probe --app-settings --shot`）。

> `--tray-suspend`（2026-09-15 起，R18 devlog/095）：**托盘是 OS 级能力，无头浏览器测不到**，
> 但"隐藏之后该发生什么"完全可断言 —— 页面里有 dev 钩子
> `window.__ddtoolkitSetShellHidden(true/false)`（`utils/shellLifecycle` 在启动时装的；R20 另有
> `window.__ddtoolkitCloseClick()`，见下方 `--close-ask`）。
> 探针分三段，**第一段是灵魂**：可见时必须证明轮询在跑（基线）——否则"隐藏后没请求"这件事，
> 一个彻底卡死的应用也能满足。量的是 `performance.getEntriesByType('resource')` 里
> `/vtuber/fetch-status` 的条数，并把**每次请求的时刻**一起打出来（排查"漏网那一发"全靠它）。
>
> ⚠️ 这条探针抓到的两个真 bug（写代码时想当然就会踩）：
> ① **停表判据要读同步源**：React 状态要等下一次渲染才落地，而定时器可能恰好落在那道缝里
>    → 判据读 `isShellHidden()`（同步置位），不读 state/它同步过来的 ref；
> ② **"排程时判"不够，触发时还要判一次**：定时器可能是**还可见时**排下的 10s 后那一轮，
>    隐藏之后照样到点触发 —— 实测漏网时刻 `22063`（隐藏发生在 `14349`），
>    而它是 `12053` 那次轮询结束时排的。⇒ **停表要在"排程"与"触发"两处都判。**
>
> 深休眠（P2）与托盘交互只能人工验：打包版点 ✕ → 窗口消失 + 托盘图标在 → 等 10 分钟
> （调试可用 `DDTOOLKIT_TRAY_SLEEP_SECONDS=20`）→ 唤回后**位置与数据都要是新的** →
> 托盘「退出」→ 任务管理器无 `ddtoolkit.exe` / backend 残留 → 再点 exe 应**唤回**而非开第二个实例。
>
> ⚠️ **R20 起「托盘退出」的失败方向变了**，人工验收要**两种现场各验一次**：
> ① **没任务在跑** → 点托盘「退出」应当**直接退出**（不必等窗口出现；任务管理器无 `ddtoolkit.exe` 与 backend）；
> ② **有任务在跑** → 应**唤回窗口 + 弹确认框**，确认后才退。原先托盘退出只发事件等前端确认，
> 而深休眠/未加载时没人接事件 ⇒ 选过"最小化到托盘"后**根本退不出去**（R20 用户实测报的 bug）。

> `--close-ask`（2026-09-15 起，R20 devlog/097）：窗口 ✕ 是非 Tauri 环境下的 `disabled` 按钮，
> 探针点不到 —— 所以开发构建里挂了 `window.__ddtoolkitCloseClick()`（与 `__ddtoolkitSetShellHidden`
> 同一族 dev 钩子，`import.meta.env.DEV` 下才有）。判开合**读 `data-state`**（理由同上：`Presence`）。
> 三段：ask 弹框（两选项 + 「记住」）→ 选托盘则写 `prefs.close_action=tray` 并隐藏 → 再点 ✕ **不再问**。
>
> ⚠️ **探针的打印里有排版字符**（`✕` U+2715、`−` U+2212 等）**不在 GBK 码表里** ——
> Windows 控制台是 cp936 时，一句 `print` 就抛 `UnicodeEncodeError` 把整条探针从中间打断
> （症状很误导：**退出码 1 但一条失败行都没有**）。`ui_probe.py` 启动时把 stdout 的编码错误
> 降级成 `?`（2026-09-16 实测踩到后加的护栏）；脚本里新增文案尽量用 ASCII 的 `-` 而不是 `−`。

> `--filter-pill`（2026-09-15 起，R16 devlog/093）：用户给的是**两张截图**（"list 视图那枚
> 要跟随侧栏那枚的样式"）—— 截图能看出"像不像"，但没法证明"一样不一样"，所以先把两枚浮片
> 的样式**逐项量化**，再让脚本断言一致：尺寸 / 字号 / 行高 / 内距 / 圆角 / 颜色 / 斜切 /
> caret 的定位方式·inset·尺寸·垂直偏移 / **纯文字的中心偏移与两侧留白**。
> 三条经验：
> ① **文字矩形要用 `Range` 框文案节点**，不能量元素矩形 —— 后者把 caret 的宽度算进去，
>    "文字到底居没居中"就量不出来（这正是 R5/R15 两次误判的同源原因）；
> ② 文案节点可能裸着、也可能套在 `.pf-label` 里，探针两种都要认（换 DOM 结构不该让探针失明）；
> ③ 断"宽度够不够"要**造一个超长文案**（本探针直接改文案节点量一帧再改回）：
>    真实文案最长的「筛选 · 3」够不到边界，而"caret 出流后靠留白让位"这件事
>    恰恰只在长文案时才暴露 —— 第一版断言写成"文案变长后宽度必须变大"，被
>    「筛选 · 2」证伪（89px 本来就装得下，不需要变宽）；真正的不变量是
>    **文字居中 + caret 与文字的最小间距 + 浮片要能长过 min-width**。

> `--add-v`（2026-09-15 起，devlog/083）：打开侧栏「+」浮窗 → 打关键词 → 断言三条：
> ① 敲键只打本地 `/vtuber/pool/search`，`/vtuber/bili/search` **必须 0 次**
> （"B 站检索只在显式触发时发生"这条决策的机器判据；被改回"输入即搜"时界面看不出异常，
> 但风控预算会被无声烧掉）；② 结果行 `elementFromPoint` 命中测试 + 本地行不得置灰；
> ③ 纯数字输入 → 按钮换「按 UID 添加」且可点。
> ⚠️ 探针**不点结果行、不点「搜索 B 站」**：前者是真收录+真抓取，后者是真上游调用；
> 关键词也不猜 —— 先问 `/vtuber/pool/search`，没命中就打印 `[跳过] 行级断言`。
> 结果区必须是 `OverlayScroll`（`.av-list.os-root > .os-scroll`），原生滚动条会被判失败。

> `--scene`（devlog/080）：真的点侧栏切 V，记录点击后**所有 fetch**（预取有没有回来）、
> `.view-body` 的 class 变化序列、提交耗时与末态（hero/侧栏/路由是否一致）。
> 它挡的是"进了退场态却没提交"——布局不变量对那种错法完全无感。
> ⚠️ 采样必须**每次重新查 DOM**：devlog/071 记的"永久停在 scene-exit"就是拿了点击前的旧节点，
> 实际机器 250ms 就提交完了（真相反转记在 devlog/080）。

> `--settings`（2026-09-13 起，devlog/075）测 21 项，除了几何还有**可点性**：
> `elementFromPoint` 命中测试（`panelHit`/`rowHit`）与"点一行会怎样"（`pickValueMatches`/
> `pickKeepsDialog`/`pickClosedPanel`/`restoredSource`）。加它们的起因是几何全绿但用户
> **点不动**（面板 portal 到 body 继承了 radix 给 body 的 `pointer-events:none`）。
> 另外两点测量口径：① 探针跑在**虚拟时间**下，入场动画会被冻在中途 → 量之前先注入
> `animation:none; transition:none`；② 同宽看 `offsetWidth`（布局宽），不看视觉矩形。

它自动：复制开发数据目录 → 起后端 → 起 Vite → 无头浏览器加载
`/vtubers/<id>?probe=1`（`frontend/src/dev/probe.ts` 会依次切四个视图、在列表页跑一遍
**筛选弹窗全链路**（开 → 预设 → 确认 → 重置 → Esc）、再点一次「投稿」筛选，共八段测量），
断言八组不变量：

| 不变量 | 含义 |
|---|---|
| **探针完整性**（2026-09-11 两轮加固）| **「跑通了」必须等于「量到了」**：量测段数须等于契约序列（`EXPECTED_TAGS`，八段）、不得量到空置页（`empty`）、页面自报的 `degraded`（视图钮点不中 / 投稿 chip 缺失 / 无视图光条）一律判失败。此前 `_first_vtuber` 一失败路由就落到 `/`，探针只 emit 一段 `empty`、**所有卡片与筛选断言静默空转，脚本照旧打印 `[ok]` 退出 0**（静态审计 2026-09-11 点出的假通过路径）。<br>**第二轮（同日）补掉剩余 5 处空转**：顶栏未采到（`ok=false`）现按契约失败、`overflowing`/`scrollers` 缺键不再当空列表、`cards.innerMaxW` 为 `null` 判失败、卡片段无内容时报「未量到」 |
| `scrollbarPx == [0,0]` | 文档层永不出现滚动条（窗口级滚动条 = 内容宽度跳 12px 的根源） |
| 无可见出窗元素 | 没有元素越过窗口左右缘（被 `overflow:hidden` 裁掉的折叠组不算） |
| 无容器横向溢出 | `overflow-x:auto/scroll` 容器不得 `scrollWidth > clientWidth`（白名单：`.type-chips` 有意横滚） |
| 无原生滚动条 | 滚动容器统一 OverlayScroll，否则出现/消失会挤动布局 |
| 列表卡片列宽契约 | 列表页 `.list-inner` ≤ 900px、卡片铺满该列且宽度一致、封面恒 220 且不被左缘裁切（2026-09-08 回归事故固化：OverlayScroll 插层让 `.list-scroll > .list-inner` 静默失效，列宽随内容在 566～1350px 之间乱跳）。**列宽契约量测已与「列表里有没有帖子」解耦**（`measure().contract` 常驻）——旧写法把守卫写在 `cards` 非空分支里，列表一空断言就失效 |
| 筛选弹窗不出右栏 | `.post-filter-pop` 完整落在 `.posts-panel` 可视区内（该容器 `overflow:hidden`，越界＝静默裁掉左月历/底部按钮）、可见月份面板 = 2 且各 42 格、预设 = 6、初始「确认」可用（2026-09-10 P10-A 固化：首跑即抓到弹窗超出可用高度 50px 与窄窗降级反而更高） |
| 筛选弹窗交互链 | 草稿态不改触发器（`筛选`）→ 点预设高亮 → 点「确认」关窗且触发器变 `筛选 · 1` → `重置`+Esc 回 `筛选` 且关窗 |
| 顶栏展示策略 | 采样当时若**只有自动节拍在跑**（`post.auto`/`account.auto` 且无手动任务）→ 顶栏必须是空闲态（不亮容器、文案不是任务进度）。2026-09-10 起探针每次运行会打印一帧「后端事实 vs 顶栏渲染」采样，用于核对。<br>⚠️ **外部第三方数据任务在跑时跳过**（2026-09-15 修，devlog/083）：顶栏按设计要显示 `正在同步…`（`busy = … || external.running`），而探针起后端后它往往正在跑 —— 旧口径只看 post/account，于是三档宽度一起报"只有自动节拍在跑却亮起了事件容器"（假失败）。采样已补 `externalRunning`/`externalLabel` 并打进打印行 |

> **量不到 ≠ 通过**：`max-width`/`coverW`/`confirmDisabled` 等取值一旦为 `null`（选择器踩空）
> 都直接判失败，不再静默放过——「断言被 null 中和」与「断言通过」在报告里必须区分得开。
> 全部失败条目都会打印（旧版只印前 8 条，后面的被吞）。

> **纯逻辑（无浏览器）**：日期区间算术（预设量纲 / 月位移夹取 / 本地解析 / 6×7 网格）
> 在 `frontend/src/utils/dateRange.ts`，可直接跑
> `node scripts/check_date_range.mjs`（Node 24 类型擦除直读 `.ts`，30 条断言）。
>
> **`--archive`（内容类排查）**：把直播日历每格的**实渲染文本**与「最近一场详情弹窗」
> 的弹幕/词云/动态行数落进探针 JSON 并打印——内容缺失类问题（不是布局）靠它定位，
> 2026-09-10 修「近期场次详情空白」（devlog/052）即用它做的端到端复验。
>
> ⚠️ `--archive` 固定点「**最近一场**」：若最近一场刚下播、danmakus 还没收录，会量到
> `弹幕行 [] / 词云格 0` 并显示「第三方收录中」占位 —— 此时它**什么都没验证**却仍然退出 0。
> 要确认词云/弹幕实渲染，先用 `--vtuber <id>` 选一个近期有收录的 V，或等收录后再跑。
>
> **`--hero-expect`（位级回归护栏）**：cards 视图的平台药丸（数量 / 每集切分 / 逐枚
> `索引:色系:展示数值` 顺序）哈希后比对。加它的原因很具体：2026-09-13 的 P2 批次把
> `orderAccounts`（拖拽排序）/ `chunkBy`（每 3 枚切集）/ `accountHomeUrl`（主页兜底）
> 搬出了 `PostsPage`，而**布局不变量对「药丸少一排 / 顺序变了 / 切集错了」完全无感**
> —— 那正是"搬坏了但探针全绿"的形态。改这三段逻辑前后各跑一次比对即可（见 devlog/056）。
>
> **`--calendar-expect`（位级回归护栏）**：日历 42 格 `day|badge|body` 的 sha256，
> 覆盖「**取数 → 分类 → 渲染**」这条链路 —— 拆 `useLiveSessions`（A-2）时布局不变量
> **完全覆盖不到**它（搬坏了表现为"某些天没内容了 / 月份错位"，不是元素出窗）。
> 见 devlog/057。
> ⚠️ 两个签名都**受真实数据变化影响**（粉丝数、新场次入库、danmakus 收录延迟、分类校正），
> 只适合**「重构前后立刻各跑一次」的短窗口比对**，不要当长期稳定基线。
> ⚠️ `--calendar-expect` **跨天必然失败**（2026-09-15 定性，devlog/083 §8.2）：无场次的格子
> 按 `key < todayKey` 显示「休息」否则「待定」（`LiveCalendar.tsx`），每天都可能翻转。
> 跨天只能先 `--archive-print` 取当天值再比对。

`--first-run` 额外断言：空数据目录下 `?firstRun=1` 必须**自动弹出登录浮窗**，
且浮窗内含「凭据仅保存在本机」说明。

> ⚠️ `--first-run` 走**独立契约**（探针用 `?probe=first-run`，只断言浮窗，不做布局断言）：
> 空数据目录下页面落在 `/`、**本来就没有视图光条**，若照常走四视图量测会被判「量到空置页 +
> 缺八段」三条失败 —— 那是 2026-09-11 第一轮加固引入的**必然假失败**（该命令曾恒退出 1），
> 第二轮修掉。

⚠️ 需要完整权限（Vite 的 esbuild 与无头浏览器在受限沙箱会失败）；失败时保留
`_ui_probe_tmp/`（含 DOM dump 与截图用的 profile 目录）供定位。`--shot` 存图
（`_ui_probe_tmp/shot-<宽>.png`，筛选弹窗打开态）时同样保留该目录——**不参与断言，
纯视觉存档**：布局不变量只管「在不在框里」，配色/密度这类还得看图。

## 二·六、第三方数据「抓不下来」的定性（`scripts/check_danmaku_fetch.py`）

上游（danmakus）会**间歇性变慢**：同一场次同一份代码实测在 **1.1s ↔ 15.6s** 之间摆
（2026-09-13，devlog/062）。所以「最近的数据都抓不到」这类报障，先分清是
**超时 / 断供 / 真没弹幕**，不要直接当成数据问题：

```powershell
$env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\com.ddtoolkit.app-dev"   # 必设：否则读项目根的裸跑残留库
python scripts/check_danmaku_fetch.py          # 最近 6 个 danmakus 场次：词云状态 + 事件数 + 耗时
python scripts/check_danmaku_fetch.py 10 --self  # 顺带跑自建路径（v3 原始弹幕 + 分词，很慢）
```

**只读**（sqlite `mode=ro`，不写库不删数据）；全绿退出 0、有失败退出 1，可当探针。
库路径跟随 `DDTOOLKIT_DATA_DIR`（不硬编码机器路径），未设该变量时会告警指明用的是哪个库。

### 看日志（2026-09-13 起按天轮转，devlog/077）

```powershell
$log = "$env:APPDATA\com.ddtoolkit.app-dev\logs"
Get-ChildItem $log                                  # app.log（今天）+ app.log.YYYY-MM-DD（最近 7 天）
Get-Content "$log\app.log" -Encoding UTF8 | Select-String -Pattern '\[(ERROR|CRITICAL)\]'
```

⚠️ 两份日志不要混：`app.log` 是**后端**（`app/core/logging_setup.py` 配置，双通道 + 按天轮转），
`sidecar.log` 是**Tauri 启动器**（就绪信号 / 性能打点 / 父进程看门狗）。
排查报障时**先按天切一刀**再读 —— 轮转前的老文件跨了几个月，八月的旧记录容易被当成现行问题
（devlog/076 的教训）。`app.log` 里的 `httpx` 行占大头（每个请求一行），按 `[ERROR]` 过滤最省事。

## 二·六、端到端上游冒烟（`scripts/smoke_upstream.py`，真打上游）

有些链路**只在真环境里才暴露**：登录态、上游回包形态、池外收录（候选池与索引不一致）。
这类问题过去靠"临时写个脚本 + 用户实测"发现（2026-09-15 那批写了 5 个一次性脚本，
其中 3 个抓到真问题 —— 但都被删了）。现在固化成常驻护栏：

```powershell
python scripts/smoke_upstream.py              # 真上游（数据目录副本 + 真后端）：B 站检索 /
                                              # uid 直查 / 候选池来源标注 / 池外收录 / 场次上游
python scripts/smoke_upstream.py --cold       # 冷进程：空数据目录 + **清空凭据**，
                                              # 断言未登录时的降级形态（不是"能不能用"）
python scripts/smoke_upstream.py --only bili  # 只跑名字匹配的检查
python scripts/smoke_upstream.py --capture    # 顺带把真实回包刷进 tests/fixtures/
python scripts/dev_check.py --upstream        # 接进一把梭（真上游 + 冷进程各一次）
```

判定口径：`[ok]` 真验到了 · `[skip]` **环境不成立没验到**（未登录 / 上游不可用，必须打印原因）
· `[FAIL]` 链路真坏了。⚠️ 池外收录检查会在**副本**里真建一个 V（副本每次重建，不碰真库）。

> ⚠️ 两条实测澄清（都写进了 `GLOSSARY` §8）：
> ① **「空数据目录」不等于「候选池为空」**：`backend_main.py` 首启会把随包的 `vtubers.csv`
> 引导复制进数据目录 —— 所以池外收录检查必须挑一个**不在池里**的 uid；
> ② **凭证要显式清空才算冷**：shell 里残留的 `BILI_SESSDATA` 会被子进程继承
> （`config.py` 读 `os.getenv`），否则测出来的是"登录态"，结论会完全反过来。

## 二·七、文档漂移门禁（`scripts/doc_check.py`）

索引类文档最容易漏，而且**不会让任何测试红**：`docs/ROADMAP-DONE.md` 的
「批次 → devlog 索引」（实测缺 082/084）、`docs/README.md` 的 releases 列表（漏了新版本）、
六处版本号。跑：

```powershell
python scripts/doc_check.py            # 只读，有 FAIL 退出 1
python scripts/dev_check.py --docs     # 接进一把梭
```

`scripts/release.py` 的预检也会调它 —— 发布前先拦，别让"这版改了什么"日后查不到。

## 二·八、未登录能力边界（`scripts/capability_matrix.py` + `ui_probe --capabilities`）

用户口径：「未登录也尽可能用所有功能，并明确告知限制」。边界**必须实测**（devlog/086）：

```powershell
python scripts/capability_matrix.py                    # 两态 × 轻量接口，打印矩阵
python scripts/capability_matrix.py --include-content   # 额外量投稿/动态（**会触发 IP 级 412**，别勤跑）
python scripts/capability_matrix.py --write             # 刷新 tests/fixtures/capability_matrix.json
python scripts/ui_probe.py --capabilities               # 未登录现场的界面提示（数据副本删 .env）
```

结论（2026-09-15 实测）：匿名可用 = 本地归档 / 第三方历史 / **检索（名称搜、uid 直查）** /
粉丝数 / 直播状态；**内容抓取（投稿 + 动态）与微博必须登录**（匿名被 `412 request was banned`）。

> ⚠️ 三条纪律（都是踩出来的）：
> ① **一个进程只发一条请求** —— 前一条的失败会波及后面，混在一个进程里量出来的矩阵是错的；
> ② 冷态要**显式清空凭据**（shell 里残留的 `BILI_SESSDATA` 会被子进程继承）；
> ③ 匿名探测本身有代价（会脏 IP，且**不连累登录态**，已实测），所以默认不量内容接口。

`ui_probe.py --capabilities` 断言的是**两条相反**的错法：该说的没说（顶栏/说明窗/去登录缺失）
与**过度限制**（受限功能被隐藏、或归档/账号信息被一起禁掉）。

## 三、手动复现打包版状态（脚本没覆盖时）

```powershell
# ① 全新数据目录跑后端（验首启迁移 / 登录 / 抓取）
$env:DDTOOLKIT_DATA_DIR = "E:\tmp\dd-fresh"
$env:DDTOOLKIT_PORT = "8131"
python backend_main.py

# ② 验冻结运行时（PyInstaller 相关，如 alembic 资源缺失）
python scripts/build_backend.py
$env:DDTOOLKIT_DATA_DIR = "E:\tmp\dd-fresh2"; $env:DDTOOLKIT_PORT = "8132"
frontend\src-tauri\binaries\backend\ddtoolkit-backend.exe

# ③ 验前端（对着上面的后端跑 dev server，浏览器打开即可）
cd frontend; $env:VITE_API_BASE = "http://127.0.0.1:8131"; npm run dev

# ④ 免安装包验证「打包后的应用」（后端热替换：便携版直接换 binaries\backend）
python scripts/build_backend.py
python scripts/collect_release.py --portable-only     # 重打 dist-release\DDtoolkit-portable-win64.zip
```

## 四、什么时候必须整包重建

- `frontend/src-tauri/src/*.rs`（Rust 壳）、`tauri.conf.json`（窗口/资源/CSP）；
- 需要确认**安装包布局**（如本次 `_internal` 事故）——只有 `npm run tauri:build`
  产出的 `installer.nsi` / setup.exe 能反映；
- 发布前：**`python scripts/release.py <版本>`** 一条命令把"版本同步 → 门禁 → 整包重建 →
  产物校验（含安装包布局）→ 提交/tag → 推送 → Release"全跑一遍（devlog/084；
  只想预演用 `--dry-run`，手工分步与排查见 `docs/RELEASE.md`）。

## 五、新增回归用例的约定

修 bug 时**先补用例**（`tests/test_auth.py` 等），命名里带现场信息，注释写清「用户看到什么 /
根因是什么」，例：

```python
def test_bili_poll_reads_inner_data_code():
    """回归（2026-09-08 实机）：扫码状态在 data.code，外层 code 恒为 0。..."""
```

这样下次同类问题在 `pytest` 里 6 秒就能拦住，不必等出包。

## 六、拆前端入口 / 抽共用样式时的坑（2026-09-24 加，devlog/181）

小窗拆成独立 HTML 入口（`widget.html` → `src/widgetMain.tsx`）时踩到的两类问题。
**共同点：它们都不在任何 import 图里，所以编译、类型检查、单测全是绿的。**

### 6.1 「顺带生效的全局样式」是最容易漏的一类依赖

拆完之后探针量到胶囊宽 **224px**，规格是 **200px**。

根因：`box-sizing: border-box` 不是项目自己写的，是 **Tailwind preflight**（只在
`index.css` 里）全局设的。新入口不再加载 `index.css` ⇒ 退回浏览器默认 `content-box`
⇒ 宽高各多出 padding + border。

**规矩**：新建入口后，**逐个核一遍"当前布局靠哪些全局样式兜着"** ——
preflight / base 层 / reset / 自定义属性（`tokens.css`）。判据：
*这个属性我在组件里没写过，那是谁给的？*
找不到出处，就当它不存在，显式补上。

### 6.2 抽成共用文件的那份必须**自包含**

抽 `status-island.css` 时，开头几行 reset 是**两个入口都需要**的，
一度只留在主入口那份里 —— 表现是"主窗口正常、小窗错位"。

**规矩**：共用样式文件不假设调用方设好了什么。要复用的 reset / 变量，跟着内容一起搬。

### 6.3 反例：别用"症状"当跳过断言的前提

`--status-island` 的空闲语义断言在真机上必然误报（探针自己起的后端会跑启动外部补抓）。
第一版修法写成"**胶囊亮着** ⇒ 判为环境问题 ⇒ 跳过"——

**这是循环论证**：把"空闲却常亮"这个**真 bug** 一起当环境问题放过了，
而"空闲不占顶栏"正是那段断言要守的东西。**跳过等于把断言删了。**

**规矩**：跳过断言必须**取独立凭据**（这里是后端 `/vtuber/fetch-status` 的
`external.running`），不能拿被测对象的症状当自己的前提。四种分支要分清楚：

| 情况 | 处理 |
|---|---|
| 前提成立 | 照常断言 |
| 前提不成立（有独立凭据） | 跳过，**打印**凭据说明原因 |
| 症状表明可能有问题、但凭据取不到 | 跳过（环境判不了，但绝不伪造成"失败"） |
| **症状表明有问题 + 凭据确认没问题** | **报红** —— 这正是要抓的回归 |

### 6.4 绿色 ≠ 断言有效（反向验证）

跳过逻辑一旦写错，**绿色的含义就变了**：它可能什么都没验。
所以新增/修改断言后**必须反向验证**：人为破坏 → 必须红 → 恢复 → 绿。

例（devlog/181）：伪造"后端说没任务"（`_backend_ok = True; _busy = []`）再跑 ——
确实红了、退出码 1，才证明那条断言有牙齿。**这一步不能省。**

### 6.5 「在大容器里绿」推不出「在小容器里能用」（2026-09-24 加，devlog/183）

**这是本仓踩过的最隐蔽的一类假绿。**

小窗（200×40）里的通知面板 `top = 胶囊底(40) + 6 = 46` —— **整个落在窗口外**，
宽 280 也超出 200。**用户从来没看见过那个面板**，而所有探针一路绿。

**为什么绿**：`ui_probe --status-island` 一直在**主窗口的视口**（1100×800）里量状态岛那套样式。
在 1100 宽的视口里，280 宽的面板当然"在视口内、可命中"。

**它量的是「这套样式在一个大视口里对不对」，而不是「在小窗里能不能用」——
判据的坐标系错了。**

**规矩**：

1. **同一个组件被塞进不同尺寸的容器时，"在大容器里绿"完全不能推出"在小容器里能用"。**
   判据必须跑在**实际会被使用的坐标系**里（这里就是 `widget.html` 本身）。
2. 新写一条判据时，问一句：**它的坐标系是谁的？** 如果答案不是"最终用户看到的那个盒子"，
   它就是在替**另一个**东西把关。
3. 布局类改动**别只看算出来的数字** —— 先手算一遍几何（宽/高/左右边界 vs 容器），
   常常一眼就能看出"这东西根本装不下"。devlog/183 就是这么发现的：
   做 hover 之前顺手算了一下 `top`，当场对不上。
4. **量出来要连原始矩形一起报**（`shellRect` / `islandRect` / `viewport`），
   不要只报一个"误差 = −290px"。只给差值的话，偏了也**不知道是谁的尺寸不对**
   （容器不是视口高？元素被撑高？父级没撑开？），只能猜。

### 6.6 ⚠️ `git stash -u` 是**全仓**操作，别拿它回答只读问题（2026-09-24 加）

判断"某个 tsc 报错是不是我引入的"时，我用了 `git stash push -u` —— 结果 stash 到了
**另一个进程正在改的 6 个文件**（本仓可能同时有别的 agent / 别的窗口在编辑）。
这次两次 stash 都完整 pop 回来了（核对过 `git stash list` 为空、diff 规模未变），**没丢东西**，
但这是**运气好**。

**规矩**：

- 判断"报错是不是我的"用**只读**办法 —— 直接按文件名过滤：
  `npx tsc --noEmit | Select-String <我改过的文件名>`；
- 真要 stash，**先 `git diff --stat` 记下范围**，事后逐条核对；
- **别用会动工作区的命令去回答一个只读问题。**

---

## 七、多会话并行（两个窗口同时改一个仓）（2026-09-24 实测）

> **背景**：本仓实际发生过"两个会话并行改同一仓"，代价是**撞车两次**：
> 我 `git stash -u` 扫走了对方 6 个文件（§6.6）；两个会话**都占了 devlog 182**（已让到 183）。
> 本节把"要不要并行、怎么并行"从经验变成**可执行判据**。全部数字为 **2026-09-24 本机实测**。

### 7.1 结论先行

| 情况 | 做法 |
|---|---|
| 两边改的**代码文件不重叠** | ✅ **开 `git worktree`** —— 隔离成本远小于收益 |
| 两边都会碰 `ui_probe.py` / `tokens.css` / `TopBar.tsx` 这类枢纽文件 | ❌ **别并行**，串行做（或一个会话里分两批，如 R38 批 5c/5d） |
| 不管哪种 | ⚠️ **动手前必须分配 devlog 编号段**（见 §7.4） |

**判据不是"功能是否独立"，而是"改动的文件集合是否重叠"。**
两个"独立功能"如果都要动 `TopBar.tsx`，合并时的冲突量会超过并行省下的时间。

### 7.2 为什么"开个分支"不够

**分支只是一个指针，一个工作目录同时只能 checkout 一个分支。**
两个会话在同一目录里 = 改同一批文件，`git status` 混在一起、`git add -A` 会扫走对方的工作。
**要的是 `git worktree`**（独立目录 + 独立分支，共用同一个 `.git` 对象库）：

```powershell
git worktree add ..\DDToolkit-featB -b featB   # 同级的兄弟目录
git worktree list
git worktree remove ..\DDToolkit-featB         # 用完删（加 --force 丢弃改动）
git worktree prune                             # 目录被手删过之后清元数据
```

⚠️ **`worktree add` 会创建分支**，失败时分支可能已经建出来了 —— 清理要连分支一起：
`git branch -D <name>`（这条实测踩过）。

**隔离性已实测**：worktree 里的 `.git` 是一个**文本指针文件**
（内容 `gitdir: …/.git/worktrees/<name>`）；在 worktree 里新建未跟踪文件，
**主工作区的 `git status` 完全看不到**。

### 7.3 ⚠️ 两个"看起来能省事、实际会咬人"的坑

#### 坑 1：新 worktree **开箱不能编译**（必须处理）

`frontend/src-tauri/tauri.conf.json` 的 `bundle.resources` 是 `["binaries/backend/**/*"]`，
而 **`frontend/src-tauri/binaries/` 被 gitignore**（本机 **163 MB**，是构建产物）。
⇒ 新 worktree 里 `cargo check` **必然失败**：

```
error: failed to run custom build command for `ddtoolkit v1.0.2`
Caused by: glob pattern binaries/backend/**/* path not found or didn't match any files.
```

**解决办法（实测有效）**：用 junction 指回主仓库那份，**不要复制**（省 163 MB）：

```powershell
cmd /c mklink /J "<worktree>\frontend\src-tauri\binaries" "<主仓库>\frontend\src-tauri\binaries"
```

接上之后 `cargo check` 通过（**20 秒**，增量）。

#### 坑 2：**别共享 `CARGO_TARGET_DIR`**

cargo 构建时对 target 目录**上独占锁**，两个会话共享会**串行化**——一个编译另一个干等，
比各自独立更慢。本仓现在**没有**配 `CARGO_TARGET_DIR`（无 `.cargo/config.toml`），**保持这样**。

**成本实测**（本机）：

| 项 | 数值 |
|---|---|
| `frontend/src-tauri/target` | **18.9 GB**（debug 16.2 + release 2.7，是**增量累积**，不是基线） |
| 新 worktree 冷 `cargo check` | **102 秒**，产出 target **1.1 GB** |
| `frontend/node_modules` | **236 MB**（gitignore，要重装） |
| `Cargo.lock` crate 数 | 527 |

⇒ **18.9 GB 具有误导性**：`[profile.release]` 的 `lto`/`codegen-units=1` **只影响 release**，
debug 侧一次冷构建只要 ~100 秒 / 1.1 GB。**并行的工作区成本远低于那个数字暗示的量。**

⚠️ **`node_modules` 别用 junction 共享**：`node_modules/.vite` 是 dev server 的**共享缓存目录**，
两个 dev server 会抢它（本仓**未**配 `cacheDir`）。要快要各自 `npm ci`。

### 7.4 ⚠️ 真正的冲突面是**追加型文档**，不是代码

代码再怎么分都能干净合并；每次必冲突的是这三处（都是"往末尾追加"，git **无法自动合并**）：

| 文件 | 为什么必冲突 |
|---|---|
| `devlog/` 编号 | 两边都取"最大编号 + 1" ⇒ **撞号** |
| `docs/ROADMAP-DONE.md` 索引表 | 两边都往表尾追加行 ⇒ **同一位置插入** |
| `docs/TODO.md` §6.2 门禁基线 | 两边都更新实测数字 |

**纪律**：

1. **动手前分配编号段**（例：会话 A 用 183–189，会话 B 用 190–196）。
   **不要**让两边各自"取最大 +1" —— 那正是撞号的机制。
2. 索引表那一行留到**合并时由一方统一补**，别在各自分支里各加一行。
3. 合并后**必跑** `python scripts/doc_check.py` + `python scripts/gen_doc_numbers.py`
   （⚠️ 后者**没有 `--check` 参数**：**不带参数就是跑检查**，`--list` 才是只打真值）。

#### ⚠️ 门禁**抓不到**文件名层面的重号（实测确认）

`gen_doc_numbers.derive_devlog()` 用的是 `nums[-1] + 1`（**只排序、不去重，也不检查重复**）。
实测：同时存在 `183-…A.md` 与 `183-…B.md` 时，它照常报
`count 182 / devlog_max 183 / devlog_next 184` —— **看不出任何异常**
（`count` 数的是文件数，所以重号时它会**正常 +1**，不是少报）。
`doc_check.py` 同样返回 **`[ok] 无 FAIL`**。

⇒ **撞号不会自己变红。** 所以 §7.4 第 1 条（预先分配编号）不是"锦上添花"，是**唯一防线**。
合并后建议眼睛过一遍：

```powershell
# 文件名层面的重号（门禁不管这个）
Get-ChildItem devlog -Filter "*.md" | Group-Object { $_.Name.Substring(0,3) } |
  Where-Object Count -gt 1 | ForEach-Object { "重号 $($_.Name)" }
```

> **另注**：`devlog_count` 与本仓"篇数覆盖范围"**天然对不上**（现有 181 篇覆盖编号到 183，
> 因为 **068 / 161 是缺号**）。看到 `count < max` **不一定是撞号**，先查缺号 ——
> 别把缺号误判成重号去"修"。

### 7.5 必须各自隔离的**运行态**（同一台机器上并行）

| 资源 | 现状（2026-09-24 核实） | 并行时怎么办 |
|---|---|---|
| **开发数据目录** | `%APPDATA%\com.ddtoolkit.app-dev`，`app/core/config.py` **只认 `DDTOOLKIT_DATA_DIR`** | ⚠️ 两个会话跑后端会**写同一个 SQLite** ⇒ 每个 worktree 设**自己的** `DDTOOLKIT_DATA_DIR` |
| **探针现场** `_ui_probe_tmp/` | `ui_probe.py` 里是 `ROOT / "_ui_probe_tmp"`（**仓库根相对**） | ✅ worktree 一分开**自动解决**（以前两个探针并发会撞 `OSError [WinError 1224]`） |
| **Vite 端口** | `vite.config.ts` 写死 5173 但**未开 `strictPort`** ⇒ 自动递增；`ui_probe` 用 `_free_port()` | ✅ 本来就是动态的，不用管 |

⚠️ **worktree 建在仓库目录内**（如 `_wt-test/`）时，它会以 `?? _wt-test/` 出现在主工作区的
`git status` 里。实测**扫描类脚本不会漏进去**（`gen_doc_numbers` 只扫 `devlog/` 等固定路径），
但**肉眼会被干扰**。建在**仓库外的兄弟目录**更干净 —— 不过那要写仓库父目录，
在受限沙箱下会被拦（需授权）。

### 7.6 一份可照抄的开工清单

```powershell
# ① 先看会不会重叠（判据是**文件集合**，不是功能名）
git worktree add ..\DDToolkit-featB -b featB
cd ..\DDToolkit-featB

# ② 补上 gitignore 的构建依赖（不补则 cargo 必失败）
cmd /c mklink /J "$PWD\frontend\src-tauri\binaries" "E:\work\Project\DDToolkit\frontend\src-tauri\binaries"
npm --prefix frontend ci                 # node_modules 不共享（.vite 缓存会抢）

# ③ 隔离运行态
$env:DDTOOLKIT_DATA_DIR = "$PWD\.devdata"   # 别用共用的 app-dev

# ④ 分配 devlog 编号段（**动手前**，别等写完再取"最大+1"）

# ⑤ 干完：合并 → 统一补 ROADMAP-DONE 索引行 → 跑门禁
python scripts/doc_check.py
python scripts/gen_doc_numbers.py            # 不带参数 = 跑检查（没有 --check 参数）

# ⑥ 清理
git worktree remove ..\DDToolkit-featB
git worktree prune; git branch -D featB
```


