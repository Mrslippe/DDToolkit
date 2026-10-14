---
doc: plans/live-type-label-set
class: plan
scope: T2 的人工标注集（固定种子 20261012 抽样；用户逐个给真值 ⇒ 形成回归集）
not-scope: 规则本身（改规则是 T3）；这份文件只装「人给的真值」
expires: 2027-03-31
---

# 场次类型：人工标注集（T2 尺子）

> 用途：给类型规则一个**能证伪的尺子**。规则已经改过两轮（`devlog/468` 健身→助眠、
> `devlog/469` 加 `3d` + watch 扩边界），但**没有基线** ⇒ 现在只能说「换了口径」，
> 不能说「更准」。这份真值就是那个基线（方案 §5：基础规则 + 人工标注相结合）。
>
> **怎么填**：看每一行的**标题 + 分区**，在最后一节的 `key-N = 类型` 里写一个类型 key。
> - **拿不准就写 `?`** —— 那本身有用（说明人眼也判不出来，规则判不出不算错），
>   评测时不计入吻合率、但会单独报出来；
> - ⚠️「现有判断」栏是**今天规则给出的答案**，不是提示 —— 觉得错就照实写你的；
> - **不用全填**，每层填十几条就够当尺子（但 `3d` 那层建议认真填，它是新类）。
>
> ⚠️ **它与"类型落库"那批的关系**（T1–T4 已落地：`devlog/467`/`468`/`471`/`472`；那份执行方案
> 已按规范删除）：落库改的是**存储与口径**，规则本身的"更准"**还没开始** —— 它要等这份真值
> 填完才有基线可打（现状 `fallback` 打掉 31.7%、`area` 命中 47.9%，两个数都只是"换了口径"）。

## 类型 key（现在的 11 类）

| key | 标签 | 判定边界 |
|---|---|---|
| `chat` | 杂谈 | 聊天/陪伴/杂谈/谢 SC/看弹幕互动 —— **没有明确内容主体**的那种 |
| `game` | 游戏 | 主体是打游戏（含联机、练枪、通关、看游戏实况一起吐槽） |
| `watch` | 观影 | 一起看番/剧/电影/综艺/特摄，**或者视频、投稿等以观看视频为主体**的 |
| `upload` | 投稿 | 主体是**放自己的**新作/预告/剪辑（「看别人的投稿」归 `watch`） |
| `song` | 歌回 | 唱歌/歌回/练歌/演唱会/音乐向 |
| `radio` | 电台 | 电台/谈心/深夜陪聊/**在电台区开播**（与 `chat` 的边界：有「节目感」的算电台） |
| `collab` | 联动 | 与人联动/嘉宾/连麦/合唱 |
| `special` | 特殊 | 生日/周年/出道纪念/毕业/跨年等**一次性事件** |
| `sleep` | 助眠 | 助眠/哄睡/白噪音/ASMR 这类**明确的助眠内容**（真机上今天 0 场） |
| `3d` | 3D | **3D 形式**呈现的直播（口径：**内容类优先** ⇒ `3d歌回` 算歌回、只有判不出内容的才归 3D） |
| `live` | 直播 | 中性兜底（**判不出来时选它**） |

## 抽样与口径

- 来源：真机库只读副本（7237 场合并场次），**固定种子 20261012** ⇒ 可复现；
- 分层：按**现有判定档位**取（`fallback` 未定出来 / `area` 靠分区 / `title` 靠标题）＋**单独一层 `3d`**（新类，按标题含 3D 取，已排除「晕3d」这类误命中）；
- 每层取了一批，**不用全填**；


## 第一层：标题含 3D（新类的现场）（20 条）

| # | 标题 | 分区 | 现有判断 | 你的判断 |
|---|---|---|---|---|
| 3d-1 | 【3D】新年新计划！ | 虚拟日常 | `special`（title） |  |
| 3d-2 | 【3D】成为更了解彼此的我们 | 虚拟Gamer | `game`（area） |  |
| 3d-3 | 【3D】第九届星斯卡！ | 虚拟日常 | `3d`（title） |  |
| 3d-4 | 【3D】阔别221天！ | TopStar/虚拟主播 | `3d`（title） |  |
| 3d-5 | 【3D】柚恩蜜新衣采购会 | TopStar/虚拟主播 | `3d`（title） |  |
| 3d-6 | 【3D】到你家做客 | 虚拟日常 | `chat`（area） |  |
| 3d-7 | 恬豆3D生日会 ！！！ | 虚拟日常 | `special`（title） |  |
| 3d-8 | 【3D】花生什么事~ | — | `3d`（title） |  |
| 3d-9 | 【3D】旗袍的万种风情 | 虚拟主播/虚拟日常 | `chat`（area） |  |
| 3d-10 | 【3D】当然要拍照记录啦 | 虚拟主播/虚拟日常 | `chat`（area） |  |
| 3d-11 | 全身3D锻炼 | 3D虚拟主播/虚拟主播 | `3d`（title） |  |
| 3d-12 | 【3D】E!5!偶像运动会 | 虚拟主播 | `3d`（title） |  |
| 3d-13 | 【3D】即兴表演！ | 虚拟日常 | `chat`（area） |  |
| 3d-14 | 【3D】一起过七夕吧 | — | `3d`（title） |  |
| 3d-15 | 【3D】EOE录音棚欢乐多 | 虚拟主播 | `3d`（title） |  |
| 3d-16 | 【3D】向恬豆许愿吧！ | — | `3d`（title） |  |
| 3d-17 | 【3D】露早大评级！ | 虚拟日常 | `chat`（area） |  |
| 3d-18 | 【3D】我坐小孩那桌 | TopStar/虚拟主播 | `3d`（title） |  |
| 3d-19 | 【3D】柚柚的视频来电 | 虚拟主播 | `3d`（title） |  |
| 3d-20 | 【3D】柚柚小课堂 | TopStar/虚拟主播 | `3d`（title） |  |

## 第二层：未定出来（今天的 `live` 兜底）（20 条）

| # | 标题 | 分区 | 现有判断 | 你的判断 |
|---|---|---|---|---|
| fallback-1 | 【视频】当毒师的下场……！ | — | `live`（fallback） |  |
| fallback-2 | 大表哥好玩喵 | — | `live`（fallback） |  |
| fallback-3 | 健健健康生活！ | — | `live`（fallback） |  |
| fallback-4 | 康康！ | — | `live`（fallback） |  |
| fallback-5 | 今晚继续！底特律变人~ | 虚拟主播 | `live`（fallback） |  |
| fallback-6 | 粉丝做的I WANNA喵 | — | `live`（fallback） |  |
| fallback-7 | 抓到你了~ | — | `live`（fallback） |  |
| fallback-8 | 宿命回响和看了好多（追凶者也、十二怒汉） | 虚拟主播 | `live`（fallback） |  |
| fallback-9 | 堂堂复活！ | TopStar/虚拟主播 | `live`（fallback） |  |
| fallback-10 | 我是糖人 | 虚拟主播 | `live`（fallback） |  |
| fallback-11 | 今天要死了 | — | `live`（fallback） |  |
| fallback-12 | 我 看 大 时 代 | — | `live`（fallback） |  |
| fallback-13 | 【2D】新衣服发布会！ | — | `live`（fallback） |  |
| fallback-14 | 儿童偶像 | — | `live`（fallback） |  |
| fallback-15 | chicken feet | 虚拟主播 | `live`（fallback） |  |
| fallback-16 | 多谢款待by菜菜子 茶冷 悠亚 | — | `live`（fallback） |  |
| fallback-17 | 想玩Ib重置版 | — | `live`（fallback） |  |
| fallback-18 | 2023第一天 | 虚拟主播 | `live`（fallback） |  |
| fallback-19 | 底特律连续剧！ | 虚拟主播 | `live`（fallback） |  |
| fallback-20 | 原一只 | 虚拟主播 | `live`（fallback） |  |

## 第三层：靠房间分区定的（20 条）

| # | 标题 | 分区 | 现有判断 | 你的判断 |
|---|---|---|---|---|
| area-1 | 【WOW】打团咯 | 网游/魔兽世界 | `game`（area） |  |
| area-2 | 真是最后亿斗！ | 虚拟日常 | `chat`（area） |  |
| area-3 | 唔哇是虚度杂 | 虚拟日常 | `chat`（area） |  |
| area-4 | 恐~怖~歌~影~回~ | 虚拟日常 | `chat`（area） |  |
| area-5 | 给鬼拍照 零~月蚀之假面~ | 虚拟Gamer/虚拟主播 | `game`（area） |  |
| area-6 | 今天到扛米了 | 虚拟Gamer | `game`（area） |  |
| area-7 | 【DS2】下午的送快递 | 虚拟Gamer | `game`（area） |  |
| area-8 | 偷偷滴 | 虚拟Gamer | `game`（area） |  |
| area-9 | 谢礼物吧应该只有谢礼物 | 电台/聊天电台 | `radio`（area） |  |
| area-10 | 小样，迷倒你了吧 | 虚拟日常 | `chat`（area） |  |
| area-11 | 看闪闪后半⭐ | 虚拟主播/虚拟日常 | `chat`（area） |  |
| area-12 | 妆都没卸就来直播！ | 虚拟主播/虚拟Gamer | `game`（area） |  |
| area-13 | 聊聊 | 虚拟日常 | `chat`（area） |  |
| area-14 | 小小虚度一下⭐ | 虚拟主播/虚拟日常 | `chat`（area） |  |
| area-15 | 【梨氏厨房】美少女亲手做一道美味的地三鲜 | 虚拟日常 | `chat`（area） |  |
| area-16 | 偷偷滴2 | 虚拟主播/虚拟Gamer | `game`（area） |  |
| area-17 | 听听你说的是啥 | 虚拟日常 | `chat`（area） |  |
| area-18 | 【突击】继续终末地！ | 虚拟主播/虚拟日常 | `chat`（area） |  |
| area-19 | 狼之牙 | 虚拟主播/虚拟日常 | `chat`（area） |  |
| area-20 | 小小梦魇2 | 虚拟日常 | `chat`（area） |  |

## 第四层：靠标题关键词定的（20 条）

| # | 标题 | 分区 | 现有判断 | 你的判断 |
|---|---|---|---|---|
| title-1 | 【游戏】弹丸(_　_)。 | — | `game`（title） |  |
| title-2 | 新年第一唱！ | 虚拟日常 | `special`（title） |  |
| title-3 | 【电台】血！压！上！升！ | — | `radio`（title） |  |
| title-4 | 今天155岁生日喵！ | 虚拟Gamer/虚拟主播 | `special`（title） |  |
| title-5 | 【鸣潮】2.4 | 虚拟主播/虚拟Gamer | `game`（title） |  |
| title-6 | 【2D】黑神话第三章 | 虚拟主播/虚拟Gamer | `game`（title） |  |
| title-7 | 【杂谈】随便聊点！ | 虚拟主播 | `chat`（title） |  |
| title-8 | 主播在线滚 22:00看电影喵 | — | `watch`（title） |  |
| title-9 | 【电台】陪我吃饭～ | — | `radio`（title） |  |
| title-10 | 晚上也是可以唱歌的 | 虚拟主播/虚拟日常 | `song`（title） |  |
| title-11 | 晚安提问箱喵 | 虚拟Gamer/虚拟主播 | `radio`（title） |  |
| title-12 | 【游戏】进橘子之路 | — | `game`（title） |  |
| title-13 | 梦游塞尔达 | 虚拟主播 | `game`（title） |  |
| title-14 | 【团播】四禧茶话会！ | — | `chat`（title） |  |
| title-15 | 菜王杯·新春欢乐斗地主大赛！！ | 虚拟日常 | `special`（title） |  |
| title-16 | 补sc ，开游戏 | 虚拟主播/虚拟日常 | `game`（title） |  |
| title-17 | 开踢威电台 | 电台/聊天电台 | `radio`（title） |  |
| title-18 | 【游戏】糖！ | — | `game`（title） |  |
| title-19 | 【电台】在云南，中午好！ | 虚拟主播/虚拟日常 | `radio`（title） |  |
| title-20 | 第二次玩人狼村之谜（二周目） | 虚拟主播 | `game`（title） |  |

## 我（用户）的判断

> 按 `fallback-1 = game` 这种形状写在下面（前缀就是表格里那个 ID 的前半段：
> `3d-` / `fallback-` / `area-` / `title-`）。
> 不填的条目会被跳过；写 `?` = 人眼也判不出。

```
# 3D 层（新类，建议认真填）
3d-3 = special
3d-13 = 3d
3d-17 = 3d


# 未定出来那层
fallback-1 = watch
fallback-2 = game
fallback-4 = watch
fallback-5 = game
fallback-6 = game
fallback-8 = watch
fallback-12 = watch
fallback-13 = special
fallback-16 = collab
fallback-17 = game
fallback-19 = game

# 分区层
area-18 = game
area-20 = game


# 标题层
title-2 = song



```

## 附：这张表怎么被用掉

1. 你的判断 → 一份固定回归集（**跟着本文件留档**），由脚本落档：
   `python scripts/make_label_set.py --collect`（读下面那段、写 `live-type-truth.json`）；
2. T3 每改一次规则都跑 `python scripts/make_label_set.py --ruler` ⇒ 输出
   **吻合率 + 按档拆解 + 判错清单**（哪些原来对的变错了）；
3. 另配两个连续指标（`fallback` 率、人工校正率）—— ⚠️ 它们**单独不够**：
   区分不了「更准」与「把错换了个错法」，必须配这份固定集。
4. ⚠️ 标 `?` 的条目不进吻合率（人眼也判不出），但会单独报出来；
   库里已不存在的场次会被跳过并说明 —— **不静默少算**（少算会让吻合率看起来更好）。


