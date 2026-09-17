# 145-20260917-R37-P3a大事记卡：把 vtuber_events 接上（扩展点的真示例）

> R37 的第三批（P3）拆两半。本批是 **P3a**：把档案视图的第三张内置卡做出来 —— 数据是
> `vtuber_events` 表（**P7 就建好了，`GET /vtuber/{id}/events` 端点也一直在，UI 一直没接**，
> devlog/137 受理时就点出过这条"表在、没界面"）。
> 它同时是**扩展点的真示例**：加这张卡**视图一行没改**。

---

## 一、为什么拿"大事记"当扩展点的第一个实证

P1 就把扩展点做成了**前端卡片注册表**（`registerCardKind`，devlog/141）。但"注册表能用"
这件事，光靠注册表自己的单测证明不了 —— 得真加一张卡走一遍。选大事记的三个理由：

1. **数据现成**：`vtuber_events` 表 + 三个端点（GET/POST/DELETE）从 P7 起就在，一直没人用；
2. **口径不平凡**：日期是 `YYYY-MM-DD` 字符串，要算"还有几天"、要分未来/已过 —— 值得单测；
3. **不引入新结构**：不需要迁移、不需要新接口，纯粹是"写一个模块 + 注册一行"。

## 二、加这张卡实际动了什么（就是扩展点的成本）

| 文件 | 内容 |
|---|---|
| `components/profile/events.ts`（新） | 纯口径：`eventItems`（未来在前、近的优先；`YYYY-MM-DD` **按本地日期解析**；脏数据跳过）/ `eventHint`（"几条将至 · 几条已过"）—— **10 条单测** |
| `components/profile/cards/EventsCard.tsx`（新） | 卡片自己取数（`api.listVtuberEvents`）+ 骨架（同尺寸，沿用 R36 口径）+ 行式渲染 |
| `cards/index.tsx` | **一行** `registerCardKind({kind:'events', …})` |
| `api/types.ts` / `api/api.ts` | `VtuberEvent` 类型 + 三个封装（R37-P3b 的增删会用上后两个） |
| `styles/profile-board.css` | `.evt-*` 样式（行式：日期 / 标题 / 还有几天） |

**视图（`ProfileBoardView.tsx`）一行没改** —— 这正是"支持拓展"该有的样子。
顺带修掉 UI-MAP 里一句过期注释（原来写着 `api.listVtuberEvents/...` 是"未接线封装（死代码）"，
实际上那几个封装早就没了；现在如实写成"P3a 起已接线 / 增删留 P3b"）。

## 三、口径里的两个坑（都写进注释与单测）

1. **`YYYY-MM-DD` 不能用 `new Date(s)` 解析**：那会按 **UTC** 解析，东八区会退一天
   （`liveCalendarFmt.dayKeyIso` 早就踩过同一个坑）。单测里有一条专门盯它：
   `eventItems([ev('2026-09-17')], TODAY=2026-09-17)[0].days === 0`。
2. **未来优先**：大事记卡是"接下来要发生什么"的提醒位（演唱会 / 周年庆），已过去的只在
   没有未来条目时起回顾作用 ⇒ 排序是"未来升序 → 过去降序"。空态与"全是过去"分别有文案
   （「还没有记录大事记」/「N 条已过 · 都是回顾」），不让"没有"与"坏掉"看起来一样。

## 四、护栏

- **单测**：`events.test.ts` **10 条**（排序 / 今天 / 过去 / limit / 本地解析 / 脏数据 / 空态 / 三种 hint）。
- **探针**：默认三档的 `_assert_board` 卡片数断言 **2 → 3**、kind 集合加 `events`，
  并要求这张卡"要么有行、要么有一句明说的空态"（沿用优质投稿那条静默失败判据）；
  `--board` 的拖拽用例顺带覆盖它 —— 实跑里被拖的那张把**两张**邻居都推下去了：

```
[probe] board @1440
    anniversary: (1,1) → (3,2) 高 276→276
    top-posts:   (6,1) → (6,5) 高 276→276      ← 被推开
    events:      (1,4) → (1,8) 高 276→276      ← 也被推开（推开口径对多张同时生效）
  后端已存：[('anniversary', 2, 1, 5, 3), ('top-posts', 5, 4, 7, 3), ('events', 0, 7, 6, 3)]
```

## 五、P3b 待做（自定义卡片）

「用户自己加卡片」：`+ 添加卡片`（列出已注册但不在板上的 kind）+ 编辑态删除（×）+
`config_json` 载体（「自定义文字 / 外链」卡）。接口已经够用（整版 PUT 天然支持多一张/少一张），
所以 P3b 是纯前端。探针计划扩一格：加一张卡 → 落库 → 刷新后还在；删掉 → 库里也没了。

## 六、同步与门禁

- 代码：`components/profile/events.ts` + `.test.ts`（新）· `cards/EventsCard.tsx`（新）·
  `cards/index.tsx`（注册一行）· `api/types.ts` + `api/api.ts` · `styles/profile-board.css` ·
  `dev/probe.ts` + `scripts/ui_probe.py`（卡片数/种类/内容采样跟上）。
- 文档：`UI-MAP.md` B1.4（第三张卡 + 修掉过期注释）· `README.md`（功能表：三张卡 + 可拖拽）·
  `GLOSSARY.md`（大事记一行）· `TODO.md` §0/§1.1 · `ROADMAP-DONE.md`（索引 145）。
- 门禁：vitest **361 → 371** · tsc 0 · eslint 0 · pytest 546（未动后端）·
  探针默认三档 + `--board` 通过 · `doc_check` 0 FAIL。