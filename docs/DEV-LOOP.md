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
python scripts/ui_probe.py --switch-perf --vtuber 15 # **切换性能测量**（devlog/132）：视图与 V 切换的
                                                     # 「点击 → 目标可见」耗时分布 + 连点 + 主线程长任务
```

> `--switch-perf`（2026-09-16 起，devlog/132）：这是**测量模式，不是不变量门禁** ——
> 只在"切换没落地"时判失败，耗时只打印。已知单次下限 = `useSceneTransition.EXIT_MS`（200ms）的
> **刻意退场**（为了全程不出现"正在加载"闪帧），所以要看的是"**偏离下限多少**"：
> 本机 dev 构建实测：视图切换 210ms ×4 / V 切换 225–230ms / 连点（60ms 间隔）270ms（无积压）/
> 长任务 0 条 ⇒ **时间几乎全在那 200ms 动画上，挂载与渲染不是瓶颈**。

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
