---
doc: design/status-island/projects-source-review
class: snapshot
scope: 三个开源「灵动岛 / 状态浮窗」项目的源码调研（FocuSD / RustyIsland / TokenNote）：逐项带「文件:行」证据与【码】【推】【缺】标注
not-scope: 本项目的形态决策（见 review 与 d1-form-options）
verified: 2026-09-25
---

# 三个开源「灵动岛 / 状态浮窗」项目源码调研

> ⚠️ **小窗已整体退役（2026-10-01）**：本文是**设计记录**（外部项目调研），不是本项目现状；
> 小窗实现在分支 `f2-widget-archive`，现状见 `docs/TODO.md` §4（`devlog/270`）。

> 方法：`git clone --depth 1` 后**直读源码/配置**，非转述 README。
> 标注：`【码】`= 从代码/配置直接读到（附 `文件:行`）；`【推】`= 推断；`【缺】`= 仓库里没找到。
> 三者都是真实、非空、确为 Tauri 2 + React 的仓库。⚠️ **FocuSD 的 owner 已由 `zzliu93-debug` 改名为 `flyl1u`**（GitHub 自动重定向；commit author 仍为 `zzliu93-debug`，HEAD `c284eb1`，2026-08-10，v0.2.3）。
> 三者都是**单 commit**（squash/初推）——**没有 git 历史可挖"曾经怎么做"**，所有"试过 X 放弃 Y"只能从代码注释取。**README 描述与代码冲突时，以代码为准**（下面有实证）。

---

## 1. FocuSD — 唯一从架构上根除 resize 抖动的项目

`github.com/flyl1u/FocuSD`，Tauri 2 + React 19 + TS，Windows 优先。

### 1.1 窗口形态【码】——**窗口宽度是常量，永不横向 resize**
**1 个窗口**。`src-tauri/tauri.conf.json:13-27`：label `main`，**820×460**，`decorations:false` `transparent:true` `resizable:false` `alwaysOnTop:true` `skipTaskbar:true` `shadow:false` `visible:false`。**1 个 HTML 入口**（根 `index.html` 唯一，`vite.config.ts` 无 `rollupOptions.input`）。

```rust
// src-tauri/src/lib.rs:29-41
const STAGE_WINDOW_WIDTH: f64 = 820.0;   // ← 窗口宽度恒定，与岛屿宽度无关
const STAGE_WINDOW_HEIGHT: f64 = 460.0;  // ← 只是高度的"最小值"
const STAGE_WINDOW_PADDING_Y: f64 = 24.0;
// apply_stage_geometry() lib.rs:1177-1189
let stage_height = STAGE_WINDOW_HEIGHT.max((base_height * state.size_scale).ceil() + STAGE_WINDOW_PADDING_Y);
window.set_size(Size::Logical(LogicalSize::new(STAGE_WINDOW_WIDTH, stage_height)))
```
**锚定**：`x` 恒为显示器水平居中（`centered_x = monitor.x + (monitor.width - 820)/2`，`lib.rs:1216`），`y = monitor.y + margin_y*scale`（`lib.rs:1214`）；岛屿元素在窗口内靠 flex `justify-content:center` 居中（`App.css:59-66`）。
→ **抖动被架构性消除，而不是被补偿**：窗口宽度不动 ⇒ `x` 无需重算；高度变大时因顶边固定、内容贴顶，**向下生长不移动任何可见像素**；320→560 的横向变化完全发生在 CSS 层（`transform-origin: top center`），OS 窗口毫无感知。
【推】代价：820×460 的透明大窗口会盖住桌面一块区域，**必须**配鼠标穿透兜底（见 1.4）。

### 1.2 形态梯度【码】——**2 档** + 1 个正交 `is_tucked`
```rust
// src-tauri/src/lib.rs:61-88
enum IslandMode { Collapsed, Expanded }
fn base_size(self, collapsed_width: f64, expanded_height: f64) -> (f64, f64) {
    match self {
        Self::Collapsed => (collapsed_width, COLLAPSED_ISLAND_HEIGHT),  // (320, 58)
        Self::Expanded  => (EXPANDED_ISLAND_WIDTH, expanded_height),    // (560, 306..546)
    }
}
```
| 档 | 尺寸（逻辑 px） | 依据 |
|---|---|---|
| Collapsed 胶囊 | **320×58**（可压到最窄 240） | `lib.rs:33-35` `MIN_COLLAPSED_ISLAND_WIDTH=240`/`COLLAPSED_ISLAND_WIDTH=320`/`COLLAPSED_ISLAND_HEIGHT=58` |
| Expanded 面板 | **560×306**，高可达 546 | `lib.rs:36-38` `EXPANDED_ISLAND_WIDTH=560`/`DEFAULT_EXPANDED_ISLAND_HEIGHT=306`/`EXPANDED_ISLAND_HEIGHT_RANGE=240` |
| Tucked 收起 | 只露 **10px** | `lib.rs:41` `TUCKED_VISIBLE_EDGE_HEIGHT=10`；`y = monitor.y - (58*scale-10)*scale`（`lib.rs:1209-1212`） |
| 圆角 | 胶囊 29(=高/2)、展开 30 | `lib.rs:83-88` `EXPANDED_RADIUS=30` |

**过渡**：纯 CSS transition，**340ms `cubic-bezier(0.16,1,0.3,1)`**（近似 easeOutExpo，**无过冲**）作用于 `width/height/border-radius`，另 `background 260ms` / `box-shadow 300ms`：
```css
/* src/App.css:91-99 */
transform-origin: top center;
will-change: width, height, border-radius, transform;
transition: width 340ms cubic-bezier(0.16,1,0.3,1), height 340ms cubic-bezier(0.16,1,0.3,1), ...
```
无弹簧（全仓无 framer-motion/react-spring/gsap）。React→Rust 状态同步用 `requestAnimationFrame` 节流（`App.tsx:3513,3530`）。
**⚠️ 补正：宽与高是两张分开的表**——宽度由 `mode` 定，**高度由 `page` 定**。`IslandPage = "todo"|"music"|"clipboard"|"layout"`（`App.tsx:46`；**"设置"不是独立窗口，只是一个 page**）。展开高度常量 `App.tsx:211-224`：`BASE_EXPANDED=306 / TODO_ARCHIVE=352 / MUSIC=286 / CLIPBOARD=430 / EDITOR=430 / TODO_ROW_HEIGHT=46 / GROW_START_ROWS=2 / SCROLL_START_ROWS=6`，选择逻辑 `App.tsx:3409-3419`（todo 页还按行数 `+46*n` 动态增高）。
**收起宽度是按文字内容算出来的**，不是固定值：`getCollapsedIslandWidth()`（`App.tsx:616-638`）按"视觉字数"（半角 0.55 / 全角 1 / 空格 0.35）插值到 240–320，再下发并让 Rust clamp（`lib.rs:245-248`）。

### 1.3 主题【码】——**无深/浅色**；只有外观预设；单窗故无同步问题
`prefers-color-scheme` 全仓 **0 命中**（只有 `prefers-reduced-motion`：`App.tsx:939,1228,2703,2833`）。"主题"实为外观预设：`type AppearanceMode = "classic" | "liquidGlass"`（`App.tsx:145`），底色硬编码 `--island-background-color: #101013`（`App.css:54`）、文字 `#f8f6f0`（`App.css:74`）。**【缺】无主题广播机制**（只有 1 个 renderer，不存在该问题）。

**材质——README 与代码相反，且这是三库里唯一写明的"试过 X 放弃 Y"**：
```rust
// src-tauri/src/lib.rs:1157-1175  apply_glass_material()
// The main window is a fixed, transparent stage (820x460), while the island
// itself is much smaller. Windows 11's DWM Acrylic backdrop is applied to
// the whole HWND and cannot be reliably clipped by SetWindowRgn, leaving a
// large blurred rectangle around the island. Keep the native state clear
// and render the glass effect on the island element with CSS instead.
let _ = window_vibrancy::clear_acrylic(window);   // ← 每个状态都主动清掉 Acrylic
clear_window_glass_region(window)?;
if state.glass_enabled { Ok("css-fallback".to_string()) } else { Ok("disabled".to_string()) }
```
配套 `lib.rs:1464-1465`：*"Native Acrylic/Region is intentionally not reapplied on DPI changes. Liquid glass is rendered inside the island element."*
→ **README 称"Windows 11 上优先使用 Acrylic 背景采样"，代码却在所有路径主动清除 Acrylic**，原因：Acrylic 作用于整个 HWND、无法被 `SetWindowRgn` 可靠裁切，会在岛屿周围留一大块模糊矩形。**结论：Tauri 里"小岛 + 原生 Acrylic"在 Windows 上不可行。**
⚠️ 连带发现：该函数**恒返回 `"css-fallback"`/`"disabled"`，从不返回 `"active"`** ⇒ `NativeGlassState` 的 `"active"`（`App.tsx:146`）是**不可达值**；Rust 存的 `glass_intensity`/`glass_tint`（`lib.rs:101-103,252-258`）**只写不读**（死数据）。
CSS 侧：`backdrop-filter: blur(var(--glass-panel-blur)) saturate(1.18)` + 多层 `linear-gradient` 折射/高光 + `inset` 青/品红描边，`island--glass-css-fallback` 在无 backdrop-filter 时回退纯渐变（`App.css:118-158`）。
**对比度**：无 `text-shadow`（`App.css` 0 命中）。靠 ①整体 `opacity: var(--island-opacity)` 默认 0.92（`App.css:47,85`）②玻璃 tint `rgba(16,16,19,0.53)` 压暗 ③`inset 0 0 0 1px rgba(255,255,255,0.08)` 内描边勾勒边界 ④高光折射让它"看得出是玻璃"从而接受不实底。

### 1.4 交互【码】
- **点击展开**（非悬停）：`finishCollapsedPointer` 在未发生拖动时 `onOpenPage(page)`（`App.tsx:1029-1039`）。
- **收起靠"窗口失焦"，不靠鼠标移出**（很值得抄）：`getCurrentWindow().onFocusChanged(({payload:focused}) => { if (!focused && mode==="expanded") collapseIsland() })`（`App.tsx:4699-4714`）——无定时器、无误判。
- 悬停**只**用于从 tucked 唤出：`onMouseEnter={() => { if (isTucked) onReveal() }}`（`App.tsx:1047-1051`）。
- **拖动**：手动 pointer capture + **3px** 阈值，命中 `button,input,textarea,select,a,[contenteditable],[data-window-drag='false']` 不拖（`App.tsx:976-1023`）；结束判定靠 Rust 轮询 `GetAsyncKeyState(VK_LBUTTON)`（`lib.rs:295-299`）。
- **鼠标穿透：有，且因舞台大而是必需品**——12ms 轮询线程用 `GetWindowRect`/`GetCursorPos` 判断光标是否落在**岛屿矩形**（非窗口矩形）内，动态 `set_ignore_cursor_events`（`lib.rs:1278-1329`）。命中测试是**圆角矩形**、并用**实测窗口宽度反推 DPI**（`physical_scale = window_width/820`，`lib.rs:1313`，不调 `scale_factor()`）；所有错误分支 `return true`（**可交互优先**）；仅状态翻转时才真正调用（避免 IPC 抖动）。
- 无 pin。**【缺】无全屏自动隐藏**（`fullscreen`/`GetForegroundWindow`/`HWND_TOPMOST` 全 0 命中）。托盘显隐有（Show/Hide/Quit 三项菜单，`lib.rs:1410-1445`）；单实例唤起岛屿（`lib.rs:1450-1452`）。全局热键触发时会先 `show()`+`set_focus()` 再发事件（`clipboard_history.rs:610-616`）。
- 另一条"放弃"记录（`docs/agent-status-hooks.md:9`）：*"Do not use process or CPU detection… Codex and Claude Code can stay alive while idle, and Claude Code may run inside a VSCode terminal. The reliable path is to wire into lifecycle hooks."*；`:45` marker 超 10 分钟判 stale 转黄，**避免永久红灯**。

### 1.5 技术取舍【码】
- ✅**恒定宽透明舞台 + 内层 CSS 形变**（见 1.1）——**最有价值的一条**。
- ✅**显式窗口状态机 + 常量表**：`IslandWindowState{mode,is_tucked,size_scale,margin_y,collapsed_width,expanded_height,custom_position,is_dragging,glass_*}`，单一 `WINDOW_STATE: OnceLock<Mutex<..>>`，变更统一走 `mutate_window_state`（`lib.rs:59,92-128,1121-1136`）；前端入参全部 `clamp` 防越界（`lib.rs:202-203,235-247`）。几何被抽成**纯函数 `resolve_stage_position`**（`lib.rs:1252-1264`）因而**可单测**（`lib.rs:1388-1400` 有"tuck/reveal 不丢自定义位置"的用例）。
- ✅**位置持久化**：前端 `localStorage["focusd-island-position"]`（`App.tsx:210,666,4631-4633`）+ Rust `custom_position`；拖动结束 `record_dragged_position`（`lib.rs:1266-1276`）。
- ✅**多显示器**：`monitor_for_island_position` 选"岛屿中心点落在其矩形内"的屏（`lib.rs:1230-1250`），退化链 `custom → primary → current`（`lib.rs:1201-1203`）；恢复前先校验持久化位置是否仍在某块屏上（`lib.rs:226-231`）。
- ACL 极简：`capabilities/default.json` 仅 **2 条权限** `core:default` + `opener:default`，作用域仅 `windows:["main"]`——**无 `allow-set-size`/`allow-set-position`/`allow-set-ignore-cursor-events`**，因为几何全在 Rust 内部完成、前端只 invoke 自定义命令（自定义命令默认不受 capability 限制）；未使用 `withGlobalTauri`；`"csp": null`。**最小攻击面设计。**
- ❌前端是 **4838 行单文件 `App.tsx`** + 3433 行 `App.css`——【推】反面教训。
- 可调参数：`size_scale` 0.75–1.4、`margin_y` 0–160（`lib.rs:202-203`）。

---

## 2. RustyIsland — 有抖动 bug 的反面教材，不要参考

`github.com/iamdhakrey/RustyIsland`，0.1.0，**单 commit**（2025-09-08），无 Release。【推】demo 级项目。

### 2.1 窗口形态【码】——**有我们踩过的那个抖动 bug，且未修**
**1 个窗口**（未写 `label`，默认 `main`）。`tauri.conf.json:14-25`：**320×40**，`resizable:false` `decorations:false` `alwaysOnTop:true` `skipTaskbar:true` `transparent:true` `center:false`。**1 个 HTML 入口**。
```rust
// src-tauri/src/lib.rs:95-118  只有 set_size，没有任何 set_position 配合
match window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height })) { ... }
```
```tsx
// src/DynamicIsland.tsx:86-89 展开 / :98-101 收起
await invoke('update_window_size', { width: 420, height: 420 });
await invoke('update_window_size', { width: 320, height: 40 });
```
**无锚定补偿**：OS 默认保持**左上角固定**，320→420 向右下生长 ⇒ 窗口中心右移 50px；而岛元素又靠 flex 在窗口内居中（`App.css:24-32`）⇒ 视觉横跳。**【推】这正是 DDToolkit 已解决的问题，在它这里仍是未修状态。**
初始定位只在 `setup()` 做**一次**，宽高**硬编码 320/40**：`x=(monitor_width-320)/2, y=0`（`lib.rs:197-206`）。无位置持久化（`move_window` 命令存在但前端**从未调用**）。⚠️ `resizable:false` 却在 `lib.rs:172` 被 `set_resizable(true)` 覆盖。

### 2.2 形态梯度【码】——名义 3 档、**实际 2 档**
`type IslandMode = 'compact' | 'expanded' | 'activity'`（`DynamicIsland.tsx:30`）——`'activity'` 是**死代码**（全仓无处设为它）。Rust 侧 `DynamicIslandState.mode` 也声明了 `"activity"`（`lib.rs:23-27`），但 `set_island_mode` 是**只 println 的空实现**（`lib.rs:85-92`），前端也没调用。
| 档 | 窗口尺寸 | 岛元素 CSS 尺寸 | 依据 |
|---|---|---|---|
| compact | **320×40** | **320×40** | `tauri.conf.json:17-18`；`DynamicIsland.css:21-25` |
| expanded | **420×420** | **380×auto（min-height 200）** | `DynamicIsland.tsx:86-89`；`DynamicIsland.css:27-32` |
⚠️ **窗口与元素尺寸不匹配**（420×420 窗口装 380 宽的岛）⇒ 四周一圈透明死区。【推】未对齐的设计。
**过渡**：CSS `transition: all 0.3s cubic-bezier(0.4,0,0.2,1)`（`DynamicIsland.css:10`，`all` 是反模式）+ 内容 `slideIn 0.3s ease-out`（`:371-373`）。但 **OS resize 是瞬时的**，与 300ms CSS 时间轴不匹配 ⇒【推】形变不可能同步。

### 2.3 主题【码】——**有深/浅，但只是跟随系统的媒体查询**
```css
/* src/DynamicIsland.css:320-356 */
@media (prefers-color-scheme: dark)  { .dynamic-island { background: rgba(0,0,0,0.9);   border-color: rgba(255,255,255,0.15); } }
@media (prefers-color-scheme: light) { .dynamic-island { background: rgba(255,255,255,0.9); color:#000; ... } }
```
**无应用级主题状态、无手动切换、不持久化**。单窗口 ⇒ **不存在跨窗口同步问题**。【缺】无 emit/listen、无 localStorage 主题键。
**材质**：`rgba(0,0,0,0.85)` **与** `backdrop-filter: blur(20px)` 并用（`DynamicIsland.css:3-8`），加 `1px rgba(255,255,255,0.1)` 描边 + `0 8px 32px rgba(0,0,0,0.3)` 阴影。Cargo.toml **无 `window-vibrancy`** ⇒ **无任何原生 Acrylic/Mica**（依赖仅 tauri/opener/serde/ctrlc/sysinfo/chrono/tokio/once_cell）。
**对比度**：仅时间文本有 `text-shadow: 0 1px 2px rgba(0,0,0,0.3)`（`:137`；浅色态反向 `rgba(255,255,255,0.3)`，`:337`）。靠 0.85/0.9 高不透明度实底保证可读——**不是"半透明仍可读"路线**。

### 2.4 交互【码】
- **点击展开**（`handleClick`，`DynamicIsland.tsx:74-106`），再点或按 X 收起；有 `hasDragged` 守卫防"拖完顺手展开"（`:74-79`）。
- 悬停**只做装饰**：`scale(1.02)` + 阴影加深（`DynamicIsland.css:34-37`），不展开。
- 拖动：自实现 mousedown + **5px** 阈值 → `invoke('start_drag')`（`DynamicIsland.tsx:108-153`），拖动时 `pointer-events:none` 防子元素干扰（`:39-51`）。
- **【缺】无 pin、无鼠标穿透、无自动隐藏、无贴边、无全屏隐藏**（`set_ignore_cursor_events` 0 命中）。
- 有趣的 hack：前端每 **5 秒**重新 `ensure_always_on_top`（`DynamicIsland.tsx:66`），启动后 500ms 再设一次（`lib.rs:178-184`）——【推】兜住 Linux/Wayland 置顶失效。
- ACL 极简：`capabilities/default.json` = `windows:["main"]` + `core:default` + `opener:default`。

### 2.5 技术取舍【码】
- ❌模板残留严重：`greet` 命令（`lib.rs:154-156`）、`set_island_mode` 空实现、`toggle_island_expansion` 维护前端从不调用的全局 bool、前后端两套 `mode` 概念互不相通、尺寸硬编码散落。
- **【缺】无窗口状态机、无位置/尺寸持久化、无多显示器重定位**（只在启动读一次 `current_monitor`）、**无单元测试**（`package.json` 无 test 脚本）。
- README 称 Linux/macOS/Windows "Full support"，代码里只有 Linux 的置顶补丁 ⇒【推】**README 可信度低**。
- **结论：不适合作为架构参考；只值得当"没做锚定补偿"的失败样本看。**

---

## 3. TokenNote — 6 窗口 / 6 HTML 入口，与我们的形态最像

`github.com/imw61/tokennote`，Tauri 2 + React 19 + Vite + Tailwind，Windows/macOS（另有 Android），v0.3.24。

### 3.1 窗口形态【码】——**6 窗，前端驱动真 resize**
6 窗全部 `transparent:true` `decorations:false` `shadow:false` `alwaysOnTop:true`（`src-tauri/tauri.conf.json:14-128`）：
| label | 尺寸 | 关键位 | url |
|---|---|---|---|
| `widget` | **210×180**，min 146×86 / max 320×340，`resizable:false` `visible:true` `skipTaskbar:true` `x:20 y:100` | `:15-36` | `/windows/widget.html` |
| `main` | **390×720**（min 340×520），`resizable:true` `visible:false` | `:37-51` | `/windows/index.html` |
| `update` / `security-notice` / `force-reminder` / `low-balance-alert` | 520×290 / 400×300 / 420×260 / 360×172 | `:52-127` | 各自 html |

**「一窗一 HTML 一入口」严格贯彻**：`windows/` 6 个 html，`vite.config.ts:19-28` 6 个 `rollupOptions.input`，每 html 只引自己的 tsx。**这正是我们 124MB→85MB 的同类做法。**
⚠️【码】**`visible:false` ≠ 懒加载**——config `windows` 是声明式的，**启动时 6 个 webview 全部创建**，`visible:false` 只是不显示（`windowing.rs:217,240,269,292,319` 才 `show()`）。

**resize 由前端发起，`windowing.rs` 里一行几何逻辑都没有**（`set_size|set_position|LogicalSize|PhysicalPosition` 全仓只命中 3 处，均在 `lib.rs` 的 `snap_to_edge` 内）：
```ts
// src/widget.tsx:315-331
const nextSize = isExpanded ? { width: expandedWidth, height: expandedHeight } : capsuleSize
const size = new LogicalSize(nextSize.width, nextSize.height)
await appWindow.setMinSize(size); await appWindow.setMaxSize(size); await appWindow.setSize(size)  // min==max 锁死
await moveWidgetToEdge(widgetAutoHideEnabled && autoHiddenRef.current)   // ← 每次 resize 后立刻重新贴边
```
ACL 对应 `capabilities/default.json:11-14`：`core:window:allow-set-size` / `allow-set-min-size` / `allow-set-max-size` / `allow-start-dragging`。

**锚定 = 由"窗口中心偏向哪半屏"决定吸附哪条竖边 + 纵向 clamp**：
```rust
// src-tauri/src/lib.rs:1285-1314  snap_to_edge()
let snap_margin: i32 = 8;  let reveal_width: i32 = 22;
let win_center_x = position.x + (size.width as i32) / 2;
let dist_left = win_center_x - mon_pos.x;
let dist_right = (mon_pos.x + mon_size.width as i32) - win_center_x;
let new_x = if dist_left <= dist_right {
    if should_auto_hide { mon_pos.x - size.width as i32 + reveal_width } else { mon_pos.x + snap_margin }
} else {
    if should_auto_hide { mon_pos.x + mon_size.width as i32 - reveal_width }
    else { mon_pos.x + mon_size.width as i32 - (size.width as i32) - snap_margin }
};
let new_y = position.y.clamp(mon_pos.y, mon_pos.y + mon_size.height as i32 - (size.height as i32));
```
⇒ **x 永远从"屏幕边"重新推导**，148→210 时朝屏内生长、贴边侧不动 = 不抖；`y` 保留原值（顶边固定、向下生长）。
⚠️【推】**没有距离阈值判定**——不判断"离边缘 <N 才吸"，只要触发就**无条件吸到最近一侧**；`8px` 是吸附后**留边量**，不是触发阈值。README 的"拖动吸附"比字面更强制。

**并且专门切断"程序移动→onMoved→再移动"的自激环**（我们缺这层）：
```ts
// src/widget.tsx:110-112,151,164-169,301-307
const widgetSnapDelayMs = 300; const widgetProgrammaticMoveBufferMs = 520
const suppressMovedUntilRef = useRef(0)
suppressMovedUntilRef.current = Date.now() + widgetProgrammaticMoveBufferMs   // invoke 前置位
const unlistenPromise = appWindow.onMoved(() => {
  if (Date.now() < suppressMovedUntilRef.current) return          // ← 忽略自己造成的移动
  timer = setTimeout(() => moveWidgetToEdge(widgetAutoHideEnabled), widgetSnapDelayMs)  // 300ms 防抖
})
```
⚠️【推】**DPI 单位错配（真实缺口）**：前端用 `LogicalSize` 改尺寸，Rust 用 `outer_position()/outer_size()` + `PhysicalPosition`（`lib.rs:1237-1238,1313`）= 物理像素，且 `8`/`22` 硬编码、**无 `scale_factor()` 补偿** ⇒ 150% 缩放下留边≈5.3 逻辑px、露出条≈14.7 逻辑px。

### 3.2 形态梯度【码】——**2 档**（`isExpanded` 初值 `true`）
```ts
// src/widget.tsx:102-112
const capsuleStationLimit = 4;  const expandedStationLimit = 6
const capsuleSize = { width: 148, height: 88 }
const expandedWidth = 210;  const expandedChromeHeight = 158
const expandedSummaryRowHeight = 17;  const expandedSummaryRowGap = 2
const expandedSummaryPanelExtraHeight = 31
const widgetAutoHideDelayMs = 520
```
展开高度**算出来**（`widget.tsx:282-286`）：`expandedHeight = 158 + rows*17 + (rows-1)*2`，`rows = ceil(min(站数,6)/2)`。
| 档 | 尺寸 | 依据 |
|---|---|---|
| 胶囊态 | **148×88** | `widget.tsx:104` |
| 展开态 | **210×175 / 194 / 213**（1/2/3 行，宽度恒 210） | `widget.tsx:105-109,283-286` |
| 贴边隐藏态 | **不改尺寸**，x 偏移出屏仅留 **22px** | `lib.rs:1286,1295,1301` |
**tauri.conf 的 146×86→320×340 用不用？**【码】运行时被前端 `setMinSize/setMaxSize/setSize` **立即覆盖** ⇒【推】它只是创建那一刻的 OS 级信封；注意 148×88 比 min 各**大 2px**、210×213 远低于 max 340 ⇒ 是宽松信封而非精确值。无任何 Rust 代码读它做形态判断（`match (mode)` 0 命中）。
**过渡**：**窗口尺寸没有 CSS transition，形变是"瞬切"**；动画全在入场关键帧（`.animate-fade-up` 0.55s / `.animate-pop-in` 0.42s / `.stagger-children` 0.58s 带 0.04s 递增 delay，`styles.css:239-280`）+ 常驻浮动 `animate-float-soft`（4.8s `translateY(-4px)` 无限循环，`styles.css:188-195,248-250`，挂在 `widget.tsx:364`）+ 悬停 `scale(1.018)` 260ms（`.widget-hover-scale`，`styles.css:297-305`）。
⚠️【推】一个**永不停止的 transform 动画叠加窗口 resize**，在部分 GPU 上可能引入亚像素抖动，值得警惕。
【码】平台差异：`platform-motion.ts:5-9` 只判 UA，**Windows 上强制加 `.force-motion` 从而主动忽略 `prefers-reduced-motion`**（`styles.css:538-547`），macOS 才尊重系统偏好；6 个入口全部调用（`widget.tsx:18` 等）。

### 3.3 主题【码】——**没有主题系统（纯浅色）；但跨窗广播管道齐备**
全仓 grep `data-theme` / `prefers-color-scheme` / `dark:` / `darkMode` / `ThemeProvider` → **0 命中**（唯一命中是二维码配色常量 `dark: '#0F172A'`，`ConfigQrExportDialog.tsx:52`）。`tailwind.config.js` **无 `darkMode` 键**；`styles.css`（547 行）**无 `:root` / `[data-theme]` / `.dark`**。所谓 "theme" 全是 `GlassNoticeCard` 的**语义配色** `NoticeThemeName = 'info'|'warning'|'danger'`（`GlassNoticeCard.tsx:3,44-48`）。界面硬编码浅色（`text-gray-900`/`bg-white`，`widget.tsx:450,523,532`）。
→ **「两窗主题同步」这个问题在它这里不适用**——本来就只有一套浅色。**但它的广播机制正是我们要的**：Rust 用 `app.emit`（**全局广播**，`emit_to` 全仓 **0 命中**）：
```rust
// src-tauri/src/lib.rs:521（save_settings 内）
let _ = app.emit("settings-updated", normalized_settings);
// 另有 lib.rs:332,563,620,637,689,724 + refresh.rs:410 "stations-changed"
// refresh.rs:412 "snapshot-updated"; refresh.rs:414 "balance-history-updated"
```
```ts
// src/widget.tsx:217-222  —— 悬浮窗自己订阅
const unlistenSnap = listen<BalanceSnapshot>('snapshot-updated', () => refresh())
const unlistenSettings = listen<AppSettings>('settings-updated', event => {
  setWidgetOpacity(event.payload.opacity); setWidgetAutoHideEnabled(event.payload.widgetAutoHideEnabled)
})
```
⇒ **跨 webview 同步机制 = 「Rust 作 single source of truth + 全局事件广播 + 各自 `invoke` 拉全量」**，不是共享存储 / 不是 CSS 变量注入 / 不是 URL query。【码】widget 全文 **不读写 localStorage**（仅 main 侧两处非主题用途）。
**材质**：悬浮窗外壳=**一层纯白 alpha 蒙版**，alpha 直接来自设置：`shellBackground: rgba(255,255,255,${alpha})`（`widget.tsx:130-140`）。
【码】**widget 路径上没有任何 `backdrop-filter`**——`.mac-panel` blur(20px) / `.mac-section` blur(18px) / `.mac-button-icon` blur(14px)（`styles.css:333,343,410`）**在 `widget.tsx` 中 0 次使用**（widget 全用 Tailwind utility + inline style）⇒【推】早期/主窗设计残留。
**Windows 侧无 Acrylic/Mica**；macOS 靠 `"macOSPrivateApi": true`（`tauri.conf.json:133`）+ objc **手抠 NSWindow**（`setOpaque:false`/`setBackgroundColor:clear`/`views drawsBackground=false`，`windowing.rs:361-378`），**不是 vibrancy、无 `window-vibrancy` crate**。6 窗全 `shadow:false`，阴影由 CSS `glow-soft` 关键帧伪造（`styles.css:197-204`）。
**对比度处理：没有**——不采样壁纸亮度、无自适应前景色、无描边/阴影兜底。⇒【推】**这是本设计最明显的可读性缺口**：alpha 越低白底越薄，深灰文字在深色壁纸上越不可读。
⚠️【码】**透明度设置存在下限双标（真实 bug 面）**：滑杆是"透明度"、存的是"不透明度"，`opacity: widgetOpacityMax - value/100`，边界 `widgetOpacityMin=0 / widgetOpacityMax=1`（`main/utils.ts:28-30`，`SettingsView.tsx:148-160`）⇒ 运行时可推到 **opacity = 0.0（外壳全透明）**；但**导入配置**时被 clamp 到 **0.58** 下限（`data.rs:227`），默认 0.82（`models.rs:103`）。两个下限不一致。

### 3.4 交互【码】
- **双击切换形态**：`onDoubleClick={handleWidgetDoubleClick}` → `toggleWidgetMode()`（`widget.tsx:371,343-350`），按钮上双击被 `closest('button')` 排除。另有胶囊态展开按钮 / 展开态收起按钮（`:427-433,507-513`）。
- **悬停用于"从贴边隐藏唤出"**：`onMouseEnter/onMouseMove/onPointerMove → handleHoverReveal → revealWidget`（`widget.tsx:359-369,171-179`）。
- **移开自动隐藏（可选，默认关）**：`onMouseLeave → scheduleAutoHide`，**520ms** 后贴边只露 22px（`widget.tsx:181-187,370`）；拖动前先 `clearHideTimer()`（`:336`）。【推】恢复只能靠那 22px 条的 hover，吸走后不碰它就一直是条状。
- **贴边吸附**：拖动结束 `onMoved` **防抖 300ms** → `snap_to_edge`（`widget.tsx:299-313`）。
- **拖动**：`data-tauri-drag-region`（`:372`）**与**手动 `appWindow.startDragging()`（`:333-341`）**两者并用**——【推】手动那条是为了在拖动前插入"先 reveal、清定时器"的副作用，单靠原生属性做不到。
- **无 pin**：`alwaysOnTop` 设置项只作用于 `main`（`windowing.rs:41-48`，UI 在 `MainHeader.tsx:52-64`）；**widget 是硬编码置顶且每次 show 都强制回 true**（`tauri.conf.json:29`、`windowing.rs:52-56`）⇒ 悬浮窗**无法取消置顶**。【缺】无鼠标穿透（`set_ignore_cursor_events` 0 命中）。
- **多显示器**：`available_monitors()` + 按"窗口与显示器矩形的**外部间隙平方距离** `dx²+dy²`"取最小者，并注释说明原因：*"Hidden widget windows can sit partially outside the monitor bounds, so choose the nearest display instead of relying on the top-left corner"*（`lib.rs:1240-1281`）。【推】比 FocuSD 的"中心点归属"更能处理半出屏窗口，值得借鉴。
- 托盘仅 macOS+Windows（`lib.rs:1429-1465`），图标按平台分（`windowing.rs:336-349`）；macOS Dock 显隐随主窗联动（`setActivationPolicy`，`windowing.rs:77-87,124-135`）——**常驻菜单栏、不进 Dock**，但**没有 NSMenu 本体**，托盘图标即菜单栏项。单实例二次启动直接 `show_main_window`（`lib.rs:1343-1345`）。
- **【缺】无位置持久化**：`AppSettings`（`models.rs:64-92`）**无任何 x/y/w/h**，坐标只在 `tauri.conf.json:34-35` 写死 20/100，无 `tauri-plugin-window-state` ⇒ **拖动后的位置与形态重启全丢**。
- **【缺】无 `on_window_event`**（0 命中）。

### 3.5 技术取舍【码】
- ✅**一窗一 HTML 一入口**（`vite.config.ts:19-28` + `windows/*.html`）——省内存的直接手段。共享的只是 **CSS 模块**与 **TS 模块**（`widget.tsx:8` 复用 `components/BalanceOdometer`），**不共享一个 JS bundle**。`tailwind.config.js:4` 的 content 含 `'./windows/*.html'`（因 HTML 上有字面 class）。
- ✅**"固定宽度 + JS 量高"是全局统一模式**：4 个通知窗全部自己量内容改尺寸——`update.tsx:107-111`(宽520) / `force-reminder.tsx:66-70`(420) / `security-notice.tsx:43-47`(400) / `low-balance-alert.tsx:76-80`(360，用 `ResizeObserver`+rAF)，与 config 里 `minWidth==maxWidth` 互为印证。**这是本仓库最一致的架构约定，和我们的"展开成面板"同构。**
- ✅**显隐抖动补偿**：主窗显示走"先 `emit("main-window-shown")` → `sleep(60ms)` 让 React commit → 再 `show()`"，注释写明是为了避免*"先看到完成态再闪回初始态"*（`windowing.rs:206-215`）；前端接事件后用"移除类 → `void el.offsetWidth` 强制 reflow → 加回类"重放关键帧（`useAppShell.ts:213-221`，`App.tsx:31-39`）。
- ✅**ACL 按 label 白名单 + 长 CSP**：`capabilities/default.json:5` 列全 6 个 label，窗口类只给 `close/hide/minimize/set-size/set-min-size/set-max-size/start-dragging`（**无 `allow-set-position`/`allow-set-focus`/`allow-show`**）；`withGlobalTauri:false`。
  【推】**这解释了为什么贴边移动写在 Rust 而不是前端**：**自定义 `invoke_handler` 命令默认对所有窗口开放、不需要 capability**（Tauri 官方 Capabilities 文档），而前端 `setPosition` 那条路根本没授权。
  ✅**CSP 短白名单与 Rust 侧 IO 互为因果**：`connect-src` 只放行固定 4 个域名、**无通配**（`tauri.conf.json:130`），而应用要访问用户自填的任意站点——只有在"**所有站点请求都由 Rust 用 reqwest 发**"时才成立（`Cargo.toml` reqwest+rustls；`refresh.rs`、`providers/*.rs`）。这也是能把 `script-src` 收到 `'self'`（无 `'unsafe-eval'`）的前提；`style-src` 需 `'unsafe-inline'` 因大量 inline style。
- ⚠️**发现一处未接线**：存在 `capabilities/console.json`（`windows: ["console-*"]`，配合 `console_scripts.rs:14` 的 `console-{station_id}`），但 `tauri.conf.json:131` 只写 `"capabilities": ["default"]` ⇒ 按官方语义*"一旦显式启用，构建中只用这些"*，`console-*` 窗口拿不到核心窗口与插件权限（自定义命令仍可用）；`build.rs` 仅 `tauri_build::build()`，未用 `AppManifest::commands(...)` 收紧自定义命令。
- ✅**注释里的"试过 X 放弃 Y"（README 无此类章节）**：`lib.rs:1380-1383` mobile setup 里 `blocking_lock()` 会 panic → 改提前 `app.manage`；`lib.rs:1467-1469` Kotlin 曾无条件启动前台 Service 覆盖用户关闭操作；`useAppData.ts:17-25` 后端 emit 与 reorder 时序导致卡片"先回原位再换位"→ 加 800ms 抑制窗口；`styles.css:70-77` safe-area padding 曾放 body 上导致橡皮筋滚动；`lib.rs:1247-1248` 隐藏窗可能半出屏 → 改最近邻显示器；`Cargo.toml:36-38` 桌面独占依赖用 `cfg(not(target_os="android"))` 隔离。
  ⚠️注意 `useAppData.ts` 这个 **800ms 抑制窗口与 `widget.tsx` 的 520ms `suppressMoved` 是同一类招式**——**"程序化移动/变更后，在一个时间窗内忽略自己引发的回调"**，这个仓库反复用它。
- 【推】`.github/workflows/release.yml` <!-- 非本仓 --> 只有 macOS arm64/x64 dmg + Windows x64 nsis，**无 Linux CI**（尽管 `platform.ts` 有 Linux 分支）⇒ Linux 非受支持目标。

---

## 4. 横向对比表

| | **FocuSD** | **RustyIsland** | **TokenNote** |
|---|---|---|---|
| **① 窗口形态** | 1 窗；**820×460 固定透明舞台，宽度永不变**，只按需增高；x 恒居中/顶边固定 ⇒ **架构性消除抖动** | 1 窗；320×40 ↔ 420×420 真 resize；**无锚定补偿，左上角固定 ⇒ 存在横向抖动 bug（未修）** | 6 窗（**启动即全建**）；widget 210×180（min146×86/max320×340）**前端 `setSize` 真 resize**；每次 resize 后重贴边，**以屏幕左右边锚定 + y clamp**，另有 520ms `suppressMoved` 防自激；⚠️前端 Logical / Rust Physical 无 DPI 补偿 |
| **② 形态梯度** | **2 mode × 4 page × 1 tuck**：胶囊 320×58（**收起宽度按文字内容算**，240–320）/ 展开 560×(**306/352/286/430**，按 page，todo 可 +46n) + tucked 只露 10px；CSS **340ms cubic-bezier(.16,1,.3,1)**，无过冲 | 名义 3 档（`activity` 死代码）实为 2 档：compact 320×40 / expanded 窗口 420×420 而元素仅 380×auto（**不匹配**）；`all 0.3s` 与瞬时 resize 不同步 | **2 档**（初值展开）：胶囊 **148×88** / 展开 **210×175/194/213**（宽恒 210，高按行数算）；**无尺寸 transition，瞬切** + 常驻 4.8s 浮动动画 + 悬停 scale(1.018) |
| **③ 主题与同步** | **无深/浅色**，只有 classic/liquidGlass 预设；单窗无同步问题；**主动 `clear_acrylic` 放弃原生 Acrylic**（HWND 无法裁切、留大块模糊矩形），改 CSS backdrop-filter + 多层渐变；靠 0.92 不透明度 + tint 保可读 | **有深/浅，仅 `prefers-color-scheme` 媒体查询**，无应用级状态/无手动切换/不持久化；单窗无同步问题；`rgba(0,0,0,.85)`+blur(20px) 并用；仅时间有 text-shadow | **无主题系统，纯浅色**（0 命中）；**但跨窗广播齐备**：Rust `app.emit("settings-updated"/…)` + widget `listen()`；widget 为 `rgba(255,255,255,opacity)` 纯 CSS、**无 backdrop-filter**（`.mac-*` 玻璃类在 widget 中 0 次使用）；**无对比度处理**；⚠️透明度下限双标（运行时 0.0 vs 导入 0.58） |
| **④ 交互** | **点击**展开；**收起 = 窗口失焦 / Esc / 点标题区**（**无 mouseleave 延时收起**）；悬停仅用于从 tucked 唤出；**有鼠标穿透**（12ms 轮询 + 圆角命中 + 实测宽度反推 DPI，因舞台大而必需）；拖动 3px 阈值；无 pin；托盘 Show/Hide/Quit；无全屏隐藏 | **点击**展开/再点或 X 收起；悬停仅 scale(1.02) 装饰；**无穿透/无自动隐藏/无贴边/无 pin/无全屏隐藏**；拖动 5px 阈值；每 5s 重申置顶（Wayland hack） | **双击**切换；悬停=从贴边唤出；移开 **520ms** 后自动贴边只露 22px；拖动结束防抖 300ms 吸附（**无距离阈值，无条件吸最近边**）；`data-tauri-drag-region`+手动 startDragging 并用；**无穿透、widget 无法取消置顶**；托盘+Dock 联动；**无位置持久化** |
| **⑤ 技术取舍** | ✅恒定宽舞台、✅Rust 状态机 + 参数 clamp、✅**几何抽成纯函数因而可单测**、✅localStorage 位置持久化、✅多显示器（中心点归属）+ **显示器丢失自愈**、✅**唯一写明"试过 Acrylic 并放弃"**、✅ACL 仅 2 条权限（几何不过 ACL）；❌4838 行单文件 App.tsx | ❌模板残留（greet/空实现/死代码）、❌无状态机/无持久化/无多屏重定位/无测试、❌README 与代码不符 | ✅**一窗一 HTML 一入口**、✅Rust 广播 + listen、✅"固定宽度+JS 量高"全局统一、✅**emit→sleep60ms→show** 防闪回、✅ACL 按 label 白名单 + CSP 短白名单（与 Rust 侧 IO 互为因果）、✅多显示器用最短距离、✅注释里 6 处"试过 X 放弃 Y"；❌无位置持久化/无 `on_window_event`、❌`console.json` 未接线 |

---

## 5. 对我们（DDToolkit 状态岛）最有价值的 5 条结论

1. **把"变宽"从 OS 窗口层挪进 CSS，是抖动问题的终极解法，而不是补偿**——FocuSD 让窗口宽度恒为 820、只让内层元素做 CSS 形变（`lib.rs:1177-1189` + `App.css:91-99`），抖动从"要补偿的 bug"变成"不可能发生"。**代价很明确**：舞台变大就必须补鼠标穿透（FocuSD 用 12ms 轮询线程，`lib.rs:1278-1294`）。我们已用"顶边中心锚"解决 200→280，若想根治可考虑"固定尺寸透明舞台 + 内层形变"，但要先算清穿透这笔账。
2. **每次 resize 后从"屏幕边"重新推导 x，比让 OS 保持左上角更稳；再叠一层"程序化移动抑制窗"切断自激环**——TokenNote 的 `new_x = mon.x + 8` / `mon.x + mon.width - width - 8`（`lib.rs:1293-1305`）天然让形变朝屏内生长；`suppressMovedUntilRef` 520ms 忽略自触发的 `onMoved`（`widget.tsx:151,301-307`）**我们没有，值得直接抄**。同类招式在该仓库反复出现（`useAppData.ts:17-25` 的 800ms 抑制窗）。
3. **三家里没有一家解决"跨 renderer 主题同步"，但 TokenNote 给出了该用的管道，主题 payload 要我们自己加**——`app.emit("settings-updated", settings)`（`lib.rs:521`）是**全局广播**，widget 用 `listen('settings-updated', …)` 收（`widget.tsx:219-222`）；机制是"Rust 作真源 + 广播 + 各入口拉全量"，**不依赖 localStorage 共享**（该仓 widget 根本不读 localStorage）。旁证：我们既有的 `docs/design/status-island/review.md` 里 LuckyIsland 也是同构思路（Rust/SQLite 为真源 + 广播 + 各入口共用一份 theme 解析）。
4. **两个可直接搬的交互决策**：(a) **「收起 = 窗口失焦」比「收起 = 鼠标移出」更省事、不易误判**——FocuSD 用 `onFocusChanged` 收起展开面板（`App.tsx:4699-4714`），无需定时器；TokenNote 的 520ms 悬停计时器（`widget.tsx:181-187`）则要额外处理拖动/程序移动竞态。(b) **显示窗口前先 `emit` + `sleep(60ms)` 再 `show()`**，避免"先看到完成态再闪回初始态"（`windowing.rs:206-215`）——我们的小窗展开面板若也重放入场动画，这条可直接用。
5. **不要参考 RustyIsland；并且不要相信任何 README 描述的浮窗材质**——RustyIsland 是单 commit demo：`set_size` 无位置补偿、窗口 420×420 与元素 380×auto 不匹配、`set_island_mode` 是空实现、`activity` 是死代码（`lib.rs:85-92`、`DynamicIsland.tsx:86-89`、`DynamicIsland.css:27-32`）。同理 **FocuSD 的 README 说"优先使用 Acrylic"，代码却在每个状态主动 `clear_acrylic` 并注释了原因**（`lib.rs:1162-1167`）——**浮窗材质的真相只能从代码读**。反过来，这条注释正好印证我们的判断：Tauri 里"小岛 + 原生 Acrylic"在 Windows 上不可行，因为它作用于整个 HWND、无法被 `SetWindowRgn` 裁切。
