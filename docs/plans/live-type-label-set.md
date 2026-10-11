---
doc: plans/live-type-label-set
class: plan
scope: T2 的人工标注集（固定种子 20261012 抽样；用户逐个给真值 ⇒ 形成回归集）
not-scope: 规则本身（T3 才改）；这份文件只装「人给的真值」
expires: 2027-03-31
---

# 场次类型：人工标注集（T2 尺子）

> 用途：T3 要改类型规则（健身→助眠 + 打那 31.7% 未定出来的场次）。**没有这份真值，
> 规则怎么改都只能叫「换个口味」，不能叫「更准」**（方案 §5）。
>
> 怎么填：看每一行的**标题 + 分区**，在「你的判断」里写一个类型 key（写在最后面那张表里）。
> **拿不准就写 `?`** —— 那本身就是有用的信息（说明这一场人眼也判不出来，
> 规则判不出来不算错）。

## 类型 key（沿用现有 10 类）

| key | 标签 | 大致的判定边界 |
|---|---|---|
| `chat` | 杂谈 | 聊天/陪伴/杂谈/谢 SC/看弹幕互动（**没有明确内容主体**的那种） |
| `game` | 游戏 | 主体是打游戏（含联机、练枪、通关、看游戏实况一起吐槽？→ 见说明） |
| `watch` | 观影 | 一起看番/剧/电影/综艺/特摄（**看的不是游戏**） |
| `upload` | 投稿 | 主体是看投稿/切片/评论自己的二创 |
| `song` | 歌回 | 唱歌/歌回/练歌/演唱会/音乐向 |
| `radio` | 电台 | 电台/谈心/深夜陪聊/ASMR/哄睡（**与 `chat` 的边界：有「节目感」的算电台**） |
| `collab` | 联动 | 与人联动/嘉宾/连麦/合唱 |
| `special` | 特殊 | 生日/周年/出道纪念/毕业/跨年等**一次性事件** |
| `fitness` | 健身 | ⚠️ **本批要换成「助眠」** —— 见到健身类请照旧标 `fitness`，我会在 T3 一起处理 |
| `live` | 直播 | 中性兜底（**判不出来时选它**） |

## 抽样与口径

- 来源：真机库只读副本（7232 场合并场次），**固定种子 20261012** ⇒ 可复现；
- 分层：按**现有判定档位**取（`fallback` 未定出来 / `area` 靠分区 / `title` 靠标题等）；
- 每层取了若干条，**不用全填**（填 30–40 条就够当尺子）；
- ⚠️ 「现有判断」栏是**今天规则给出的答案**，不是提示 —— 觉得它错了请照实写你的判断。

## 第一层：未定出来（今天的 `live` 兜底）（20 条）

| # | 标题 | 分区 | 现有判断 | 你的判断 |
|---|---|---|---|---|
| fall-1 | 神之天平儿 | TopStar/虚拟主播 | `live`（fallback） |  |
| fall-2 | data0隐藏真结局 | — | `live`（fallback） |  |
| fall-3 | 昏睡FF16 | TopStar/虚拟主播 | `live`（fallback） |  |
| fall-4 | 【3D】我是你的xx | TopStar/虚拟主播 | `live`（fallback） |  |
| fall-5 | 小小的突击 | 虚拟主播 | `live`（fallback） |  |
| fall-6 | 【3D】重回牡丹境 | — | `live`（fallback） |  |
| fall-7 | 出过门的植物人一枚呀 | 虚拟主播 | `live`（fallback） |  |
| fall-8 | 晚 | — | `live`（fallback） |  |
| fall-9 | 【投稿杂谈】梦境之花 | 虚拟主播 | `live`（fallback） |  |
| fall-10 | 【2D】枪火重生美女双排！ | — | `live`（fallback） |  |
| fall-11 | 谢SC | — | `live`（fallback） |  |
| fall-12 | 兔兔的作图傀儡 | — | `live`（fallback） |  |
| fall-13 | 【上舰有礼】奥比岛…奥比岛！！！ | — | `live`（fallback） |  |
| fall-14 | 在这么冷的天~ | — | `live`（fallback） |  |
| fall-15 | 【家用3D】一起来玩呀！ | — | `live`（fallback） |  |
| fall-16 | 看动画 | TopStar/虚拟主播 | `live`（fallback） |  |
| fall-17 | 【3D】约饭！4=你 | 3D虚拟主播/虚拟主播 | `live`（fallback） |  |
| fall-18 | 去你家吃饭好吗？ | 虚拟主播 | `live`（fallback） |  |
| fall-19 | 【3D】和ONLY丸度过的第一个中秋 | 虚拟主播 | `live`（fallback） |  |
| fall-20 | 仁一小会喵 | — | `live`（fallback） |  |

## 第二层：靠房间分区定的（20 条）

| # | 标题 | 分区 | 现有判断 | 你的判断 |
|---|---|---|---|---|
| area-1 | 君死（3）/名侦探Q娃（7） | 单机游戏/独立游戏 | `game`（area） |  |
| area-2 | ！ | 单机游戏/主机游戏 | `game`（area） |  |
| area-3 | 【2D】《江山北望》初见！！！ | 虚拟Gamer | `game`（area） |  |
| area-4 | 重新职业规划！ | 虚拟日常 | `chat`（area） |  |
| area-5 | 【2D】御姐看新三国吐槽 | 虚拟主播/虚拟日常 | `chat`（area） |  |
| area-6 | 人森喵 | 单机游戏/其他单机 | `game`（area） |  |
| area-7 | 审判之眼续续续 | 虚拟日常/虚拟主播 | `chat`（area） |  |
| area-8 | 我是谁 | 虚拟日常 | `chat`（area） |  |
| area-9 | 试试就逝逝！ | 虚拟日常 | `chat`（area） |  |
| area-10 | 【3D】不怕不怕啦！ | 虚拟主播/虚拟日常 | `chat`（area） |  |
| area-11 | 哪里有小女孩我看看！ | 虚拟日常 | `chat`（area） |  |
| area-12 | 早上好(*╹▽╹*)⭐ | 虚拟主播/虚拟日常 | `chat`（area） |  |
| area-13 | 走，去ktv | 虚拟日常 | `chat`（area） |  |
| area-14 | 【越狱模拟器】真的能逃出去吗！！！ | 虚拟日常 | `chat`（area） |  |
| area-15 | 【2D】K杂。 | 虚拟Singer | `song`（area） |  |
| area-16 | 我DRAW你GUESS | 虚拟Singer | `song`（area） |  |
| area-17 | 【3D】二次元偶像宅驾到 | 虚拟主播/虚拟日常 | `chat`（area） |  |
| area-18 | 杖剑传说5/超级变色龙/桌面探索者喵1 | 单机游戏/其他单机 | `game`（area） |  |
| area-19 | 天才FPS少女！清纯女大战斗运输船！！ | 虚拟日常 | `chat`（area） |  |
| area-20 | 铸剑模拟器/fx战士久留美2/寻找伪牛全结局 | 单机游戏/其他单机 | `game`（area） |  |

## 第三层：靠标题关键词定的（20 条）

| # | 标题 | 分区 | 现有判断 | 你的判断 |
|---|---|---|---|---|
| titl-1 | 电台呢 | — | `radio`（title） |  |
| titl-2 | 读读黑神话影神图 | — | `game`（title） |  |
| titl-3 | 唱歌的来咯⭐ | 虚拟主播/虚拟日常 | `song`（title） |  |
| titl-4 | 【电台】冬夜小播 | 聊天电台/电台 | `radio`（title） |  |
| titl-5 | 【百日纪念直播】想把我唱给你听，一直 | — | `special`（title） |  |
| titl-6 | 【3D生日会】Miracle | 虚拟日常 | `special`（title） |  |
| titl-7 | 【电台】哇哦 | 电台/聊天电台 | `radio`（title） |  |
| titl-8 | 【游戏】试试王国之泪 | 虚拟日常/虚拟主播 | `game`（title） |  |
| titl-9 | 酥酥又土味水友歌会！ | 虚拟主播 | `song`（title） |  |
| titl-10 | 水友歌回2 | 虚拟主播/虚拟日常 | `song`（title） |  |
| titl-11 | 【2D】午间歌杂 | 虚拟Singer | `song`（title） |  |
| titl-12 | 一起看吧~ | 虚拟日常 | `watch`（title） |  |
| titl-13 | 【电台】生活中的那些小光芒 | — | `radio`（title） |  |
| titl-14 | 鸣潮3.3下 | 虚拟主播/虚拟Gamer | `game`（title） |  |
| titl-15 | 联动后日谈谢礼物！ | 虚拟主播/虚拟日常 | `collab`（title） |  |
| titl-16 | 啊呜唱歌可以吗 | 虚拟日常 | `song`（title） |  |
| titl-17 | 唱唱歌早睡 | 虚拟主播/虚拟日常 | `song`（title） |  |
| titl-18 | 一起看小米发布会！ | 虚拟主播/虚拟日常 | `watch`（title） |  |
| titl-19 | 一起看综艺《月曜夜未央》 | 虚拟主播 | `watch`（title） |  |
| titl-20 | 泽音Melody一周年3D回3日后谈 | 虚拟主播/虚拟日常 | `special`（title） |  |

## 我（用户）的判断

> 把这部分回给我即可：`fallback-1 = game`、`area-3 = ?` 这样写就行。

```
# fallback 层

# area 层

# title 层

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
