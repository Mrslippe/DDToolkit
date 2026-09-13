# 076-20260913-动态流每轮 ERROR：起跑闸门持有 loop-bound 的 asyncio.Lock

> 用户："日志报了一些bug，查看一下。"
> 结论：**真 bug 一个**（R6 引入，从 20:15 起动态流每轮直接放弃），其余是上游慢/登录态过期，
> 另有两条是**八月旧 checkout 的历史记录**（差点被当成现行问题）。

---

## 一、先把日志分成"现行"和"历史"

用户的 `%APPDATA%\com.ddtoolkit.app-dev\logs\app.log` 有 **33963 行 / 5.2MB**，跨了几个月。
按 `ERROR|WARNING` 抽出来是 477 条 —— 但直接看会误判：里面两条最"唬人"的其实是**八月**的
旧代码（traceback 路径是 `E:\work\Project\http-test\...`，仓库早就搬走了）：

| 旧条目（2026-08-22/23，忽略） | 为什么忽略 |
|---|---|
| `_safe_json_parse() takes 1 positional argument but 2 were given` | 旧 checkout 的 bug；现行代码里该函数签名一致（全量测试覆盖） |
| `Instance '<Account ...>' has been deleted` | 同上；旧 `async_fetch_and_update` 的用法 |

**所以第一步是"按天切一刀"**，只看最近一次运行（`2026-09-13`）。当天只有 5 类：

| 次数 | 级别 | 内容 |
|---|---|---|
| **24** | **ERROR** | **`动态流异常: <asyncio.locks.Lock ...> is bound to a different event loop`** ← 真 bug |
| 32 | WARNING | `danmakus live 详情请求失败 ... ReadTimeout`（上游慢，见 §四） |
| 4 | WARNING | `微博用户信息 ok!=0 ... login.php`（微博登录态失效） |
| 1 | WARNING | `weibo_auth: vN 登录失败`（同一件事） |
| 1 | WARNING | `zeroroku gifts 账号异常: ReadTimeout`（上游慢） |

## 二、根因：综合档每轮一个新事件循环，而 pacer 里存着 `asyncio.Lock`

`_tier_loop` 是**每轮 `asyncio.run(_run_combined_tier(...))`**（scheduler.py:2881）——
每次 `asyncio.run` 都新建一个事件循环。而 R6（devlog/070）给动态流加的
平台级起跑闸门 `_PlatformPacer` 把 `asyncio.Lock` 存在模块级实例里：

```python
async def wait(self, pf):                 # 旧实现
    lock = self._locks.get(pf) or asyncio.Lock()
    async with lock:                      # ← 第一次 await 就把锁绑死当时那个循环
        ...
```

`asyncio.Lock` 在**首次 await 时**绑定事件循环，第二轮换循环后再用 →
`RuntimeError: ... is bound to a different event loop`。

**影响面**：异常在 `_run_platform_rounds` 的第一发就被抛出，冒泡到
`run_latest_dynamics_sweep` 的 `except` → 记一条 ERROR + 返回 `{status: done, error}` ——
也就是说**这一轮的动态流什么都没抓**。日志里每 60s 一条，从 20:15 一直持续到 21:40
（用户最后一次运行）。账号流/直播轮询不受影响（各自独立协程），所以现象是
"**顶栏一切正常，只有动态流悄无声息地停了**"。

> 这就是 R6 那个"周期稳定 60s"的代价：周期确实稳定了，但**每轮都在失败**。

## 三、修法：把"锁内 sleep"换成"占时隙"

不再持有任何 loop-bound 原语 —— 用一把**线程锁**（与事件循环无关）在极短临界区里
"占一个起跑时隙"，再在锁外 `await asyncio.sleep()`：

```python
def _reserve(self, pf, now=None) -> float:      # 同步、任何循环都能调
    with self._guard:                            # threading.Lock
        last = self._last.get(pf)
        start = now if last is None else max(now, last + random.uniform(gap_min, gap_max))
        self._last[pf] = start
        return max(0.0, start - now)

async def wait(self, pf):
    delay = self._reserve(pf)
    if delay > 0:
        await asyncio.sleep(delay)
```

语义与旧实现一致（相邻**起跑**间隔 ≥ gap、跨平台互不影响、抓取耗时与间隔重叠），
但循环无关；顺带把"锁内 sleep"（持锁跨 await）也去掉了。

**没有回归**：`test_platform_pacer_spaces_same_platform_but_not_across`（R6 那条）原样通过；
一轮墙钟仍 ≈ 账号数 × 间隔（实测 R6 的 25.7s/轮）。

## 四、顺手清掉同一形态的隐患 + 当天其余条目

- **`BilibiliAuth._lock = asyncio.Lock()`（auth.py:120）**：**从未被使用**（全仓 grep 只有这一处），
  但形态与本次事故完全一样（模块级单例 + loop-bound）—— 直接删掉，免得哪天有人"顺手用起来"。
- **danmakus `ReadTimeout`（32 次）**：不是代码 bug。当天该上游的明细请求共 85 次成功、
  32 次超时，且**簇状分布**（12:34 / 17:25 / 17:55 / 18:41 / 19:34 / 20:14 —— 全是"打开场次详情
  或点重试"的时刻），说明是**人工触发的重试**，不是后台重试风暴。这正是 devlog/062/063 设计过
  的降级路径：单次 30s × 最多 3 次、失败如实报 `fetch_failed` + 就地重试按钮、成功进 10 分钟缓存。
  **保留 WARNING 级别**（它是"上游慢"的诚实记录，不是噪声）。
- **微博登录态失效（4+1 次）**：`ok!=0` + `login.php` 跳转 = 微博 Cookie 过期 →
  微博账号的信息/帖子抓取会失败，需要**重新扫码登录**（应用内登录浮窗）。这是用户动作，不是代码问题。
- **zeroroku `ReadTimeout`（1 次）**：第三方源单次超时，已有账号级隔离（不影响其它账号）。

## 五、护栏：两条，且都验证过"会红"

| 测试 | 作用 | 反向验证 |
|---|---|---|
| `test_platform_pacer_survives_new_event_loops` | 用**两个独立事件循环**依次调**真实的模块级 pacer**，断言不抛错且间隔仍生效 | 临时改回"每平台一把 `asyncio.Lock`" → 立刻 FAILED ✓ |
| `test_module_level_pacers_hold_no_event_loop_primitives` | 结构判据：模块级 pacer 不许挂 loop-bound 原语 | 只能挡"急切建锁"，惰性塞字典的要靠上面那条（注释里写明边界） |

> **为什么 R6 的测试没抓住**：`test_platform_pacer_spaces_same_platform_but_not_across`
> 只在一个 `asyncio.run` 里跑 —— **对"跨事件循环"完全没有感知**。
> 和本仓另一条教训同型：`--settings` 探针的几何断言对 `pointer-events` 也无感
> （devlog/075）。**测试量错了轴，全绿也没意义。**

## 六、验证

- `pytest`：**309 passed**（+2 = 上面两条护栏）。
- **端到端**（不看断言，看真实调度器）：把开发数据目录**复制一份**，用
  `DDTOOLKIT_DATA_DIR=<副本>` 起 `backend_main.py`，观察两轮以上：
  第一轮 21:44:46–21:44:53 抓完（`[bilibili] 动态 …` 逐个成功、`直播场次入库 feed`），
  第二轮同样正常，**全程没有 `bound to a different event loop`**。
  （旧代码在第二轮必炸 —— 这正是用户日志里的形态。）

## 七、遗留

- `_last` 只按平台记时刻，进程重启即清零（首轮不会有间隔）—— 与原实现一致，可接受。
- 综合档"每轮一个新事件循环"这个结构本身没动（它带来的隔离也有好处：一轮的
  连接/会话全部随循环释放）。**代价是：模块级对象一律不得持有 asyncio 原语** ——
  这条已写进 §五的结构判据注释；新增调度原语时请照此检查。
- 日志文件没有轮转（5.2MB / 33k 行，跨数月）：排查时得先按天切。若要做"日志查看"功能，
  顺手加个 `RotatingFileHandler` 更合适（未做，记在这里）。
