# 496-20261014 danmakus API 索引（两份 swagger 其实是同一份）

## 为什么做

分析页要开工，第一步是查清"danmakus 到底给什么"。用户给了两份 swagger
（`/swagger/v2/`、`/swagger/v3/`），要求合并成一份可查文档。

## 查出来的四件事（都有实测）

1. **两份是同一份文档**：字节数相同（261,239）、路径集合 86 个全等、schema 集合 209 个全等，
   差异只有 `info.version` 那一行字符串。`/swagger/combined/` 是 12 字节的 `{}` 空壳。
   ⇒ "合并"这个动作本身没有对象，要做的是**建索引**。
2. **身份一直是有的，只是我们没读**：`DanmakuFrameV3.actors[]` + `record.actorId`（**下标**）。
   实测 `actors` 812 条 / actorId 0–811 / 覆盖 99.9% ⇒ `actors[actorId].uid` 就是真 uid。
   本仓 `iter_texts_from_records` 只取 `payload`，把这半个响应丢了。
   ⚠️ 我上一轮评估里写"没有稳定身份 ⇒ 粉丝构成做不了"，**这条是错的**，原因就是只看 records。
3. **观众侧数据是公开的**：`/api/v2/channel/audience-leaderboard`（发言/到播/活跃天/三档消费额）、
   `/api/v3/users/{uid}/bootstrap`（跨主播足迹 + 昵称史）、`POST /api/v3/user-analysis-jobs`
   （词云/复读指数/节奏矩阵/49 个频道的 `loyaltyScore`）。逐端点探测：**90 个操作，44 个公开 200、
   22 个 401**（401 的全是"我自己的账号侧"）。
4. **v3 有一批是 msgpack**：`/lives/{id}/full`、`/meta/index-background`、
   `/user-analysis-jobs/{id}/result` —— `Content-Type: application/x-msgpack`，
   `r.json()` 直接抛 `UnicodeDecodeError`。spec 里 schema 名带 `Mp` 后缀的就是它们。

## 落地了什么

- `docs/backend/DANMAKUS-API.md`：**按"要什么数据"组织的索引**（主索引表 / 三个易错口径 /
  鉴权实测矩阵 / 观众榜+足迹+画像三组端点字段 / 限制与坑 / 传输格式 / 全端点清单 / 合并结论）。
  头块 `verify` 指向 `tests/test_fetch_danmakus_spec.py`。
- `scripts/fetch_danmakus_spec.py`：抓 + **修坏 JSON** + 存档 + `--check` 比对。
  ⚠️ 修是必需的：上游两份各有 11 处 `"kindValue": ,`（.NET 空枚举），不修没法 parse。
  存档也已刷新（`docs/reference/danmakus-api-{v2,v3}-swagger.json` + `-fetch.log`）。
- `tests/test_fetch_danmakus_spec.py` 6 条：修复幂等 / 不误伤合法 JSON / 字符串里出现该模式
  （**钉住现状**，不是宣称它对）/ 摘要计数口径 / 坏响应不抛错 / `{}` 空壳。
- 活文档：`.dsh/skills/ddtoolkit-docs-devlog/references/doc-map.md` 加一行（这份索引的更新时机）。

## 顺手改的 TODO 口径

`docs/TODO.md` §2 两条的**理由变了**（不是状态变了）：

- "原始弹幕明细库"原先挂着"没身份就没法做粉丝分析" → **理由不成立**，现在只剩
  "跨 30 天上限的长期趋势"与"上游覆盖有洞时留档"两条；
- "词云词字下钻"原先写"依赖明细存储" → 上游 `danmaku/search` 本来就能做（有积分额度）。

## 沙箱记一笔（方法论）

`pytest` 在本会话的沙箱里**起不来 `tmp_path`**（`PermissionError: WinError 5`，
`_test_tmp/pytest-of-zx` 连列目录都被拒）——与本次改动无关（存量用例同样红）。
本轮用"直调测试函数"跑通那 6 条断言。**真机/CI 上应正常**，下次在正常会话里复核一次。
