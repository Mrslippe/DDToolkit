# 238-20260927-BasePlatform 的 cursor 语义（收口过渡实现）

第 4 阶段 ⑥：把 `BasePlatform.fetch_post_page(uid, page)` 换成**不透明 cursor**。
这是 `EXECUTION.md` §1.4 既定顺序里的最后一项 —— 先落平台（小红书，devlog/230）、
再用它反推接口该长什么样。

## 一、改之前是什么形状，为什么必须改

小红书是 **cursor** 平台（服务端给下一串），而接口是**页码**语义 ⇒ 当年只能写一个过渡实现：
**把 cursor 藏进适配器的一张按 uid 的字典**（`self._cursor[uid]`）。

那意味着**分页状态住进了适配器**：

- 换账号 / 重抓 / 并发重入都可能串台（"这一页是谁的"靠一张字典去猜）；
- 核心循环**看不见**真实的翻页位置（日志与 `page_limit` 都是编的页码）；
- 每接一个 cursor 平台都要再写一遍这套字典。

## 二、新契约（写在 `platforms/base.py` 的 docstring 里）

```python
page = await pf.fetch_post_page(uid, cursor)   # cursor=None = 从头开始
# → {"items": [...], "has_more": bool, "next_cursor": str | None}
```

- **页码平台**（微博）把页码当 cursor 用：`weibo._page_of_cursor()` 一行换算
  （`None → 1`、坏值**不抛异常**、退回第 1 页并记日志）；返回 `str(page + 1)`。
- **cursor 平台**（小红书）原样透传服务端给的串，**适配器不再持有任何分页状态**。
- ⚠️ **核心不解析游标**：它只做"原样带回去 / 判空"。想拿它做算术或拼 URL，
  就说明语义又漏回核心了 —— 有 AST 判据盯着（见下）。
- `has_more=True` 却没给 `next_cursor` ⇒ 核心**当到底处理**（留一条 warning），
  **不报成故障**：报成 `network_error` 会让整个平台看起来在故障，而实际只是这页到头了。

核心侧另外两处：`page` 变成"我们自己数出来的请求次数"（`pages` 上限、日志、"是不是第一页"
都用它）；`first_page` 布尔量代替 `page == 1`（置顶集合同步只发生在第一页）。

## 三、判据（8 条新增）

| 判据 | 在哪个文件 |
|---|---|
| 游标**原样**带回去（`[None, "opaque-A", "opaque-B"]`） | `test_posts_core_platform.py` |
| `has_more` 但没游标 ⇒ 自然结束、**不是**故障、不拿空游标再问一次 | 同上 |
| `pages` 上限仍按**请求次数**算（pages=1 ⇒ 只发一发） | 同上 |
| **结构判据**：核心里不许对 cursor 做算术 / `int()` / 调方法（AST） | 同上 |
| 适配器**无状态**：cursor 原样进 query、`next_cursor` 原样出、再问一次仍从头 | `test_platform_xiaohongshu.py` |
| `has_more=False` 时不给游标 | 同上 |
| 微博：`_page_of_cursor` 四种输入 + `next_cursor="2"` | `test_weibo.py` |
| 微博：坏游标退回第 1 页（不抛异常） | 同上 |

反向验证 **6/6 全红**：游标没带回去 / 缺游标被报成上游故障 / 核心转数字 / `pages` 差一位 /
微博适配器抛异常 / 小红书不交回游标。

## 四、⚠️ 这一批踩到的新坑：**变异把脚本自己挂死了**

"游标没带回去"这条变异让核心**永远重抓第一页**（去重挡住入库，但循环不推进）
⇒ 反向验证脚本挂死 10 分钟被超时杀掉，而且**`finally` 里的逐字节恢复没跑到** ——
工作区里留着一个变异版本（`cursor = None`），下次跑门禁会以"莫名其妙的行为"出现。
（已当场修回；`git diff` 与 `pytest` 都复核过。）

两条防线，已写进 `DEV-LOOP` §0.7 与测试替身：

1. **给 subprocess 加 `timeout=`**，超时当作"红"但必须打印出来（不能默默算过）；
2. **给测试替身加硬闸**：`_CursorPF` 里"同一个游标最多服务 3 次，之后返回空页" ⇒
   "不推进"变成一条失败的断言，而不是死循环。

> 顺带一条同源教训：这类"循环推进"的变异**天生危险**，做之前先问一句
> "如果它真的坏了，会不会不终止？"

## 五、门禁与同步

A 档 8 步；`pytest` **788 passed**（+6 → 含 1 条打真上游的用例时 skip）。
同步：`ARCHITECTURE` §3.2（三个方法那条补 cursor 口径）、`GLOSSARY`（平台适配器行）、
`platforms-extension-guide`（新平台骨架的 `fetch_post_page` 签名 + 注释）、
`DEV-LOOP` §0.7（变异必须能终止）、`TODO` §1.1 / §6.2。

## 六、还剩什么

平台框架的剩余工程项（TODO §1.1）：B 站要不要切到身份级那一层、`IMG_PROXY_ALLOWED_HOSTS`
逐条用例、`fetch_bilibili_live_batch` 绕过 registry、端点熔断窗口要不要落库、抖音未接。
