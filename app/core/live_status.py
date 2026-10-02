"""直播状态**三态**（`live_status` 的口径，2026-10-02，devlog/276）。

`live_status` 不是布尔量 —— B 站 `get_status_info_by_uids` 给的是 **0 / 1 / 2**：

| 值 | 含义 | 算"开播"吗 |
|---|---|---|
| 0 | 未开播 | 否 |
| 1 | 直播中 | **是 —— 唯一的"开播"** |
| 2 | 轮播（房间里循环放录像） | 否：人没在播，只是房间在放录像 |

原先有几处把它当布尔用（`bool(acc.live_status)`），于是"房间转入轮播"被算成"开播了"：
实测 2026-10-02 恬豆发芽了的两次 `0 → 2` 边沿各推了一条「开播了」通知，顶栏状态胶囊
就一直挂着一条从未发生的开播（用户报障：「实际上这两者都没有开播」）。

同一个坑还有第二处：自观测场次推导原先只认 `0` 收场 ⇒ `1 → 2 → 1`
（下播后房间转轮播、隔天再开播）会被并成**一场**（实测明前奶绿 10-01 那场被拉长到跨天）。

**所以判"是不是在播"只认 1**；轮播既不触发开播通知，也代表上一场已经结束。
前端 `utils/accountHistory.ts::liveStatusLabel` 用同一套口径（那边是 TS 的镜像）。
"""

LIVE_STATUS_OFF = 0
LIVE_STATUS_LIVE = 1
LIVE_STATUS_ROUND = 2

# 展示用（与前端 liveStatusLabel 的文案一致）
LABELS: dict[int, str] = {
    LIVE_STATUS_OFF: "未开播",
    LIVE_STATUS_LIVE: "直播中",
    LIVE_STATUS_ROUND: "轮播中",
}


def is_live(status: int | None) -> bool:
    """在播吗 —— **只有 1 是**（0 离线、2 轮播都不是；None = 未记录也不当在播）。"""
    return status == LIVE_STATUS_LIVE
