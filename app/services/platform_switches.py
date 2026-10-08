"""每平台一颗「抓取总开关」（需求 9，2026-10-08 用户口径，`devlog/451`）。

## 口径（用户拍板）

- 开关放在「**设置 → 数据源 → 平台抓取**」；
- **关掉 ≈ 该平台完全不抓**：自动档与手动档都拦；
- **手动触发时要给提示**（不是静默什么都不发生）—— 提示走既有的 toast 通道，
  后端把原因写在 403 的 detail 里（`_require_content_fetch` 那条路）；
- **只影响"是否抓取"**：已抓到的帖子/统计照常浏览。

## 为什么单独一个模块

这条闸门要被**多处**问同一件事：手动端点（`routers/vtuber.py::_require_content_fetch`
→ `capabilities.content_fetch_allowed`）、能力矩阵（`capabilities.snapshot` 的
`disabled` 态）、自动档（`scheduler.platform_accounts_of`）。各处各写一份
`runtime_settings.get(...)` 就是下一次"某个平台漏了一路"的来源 —— 抖音当年只有
适配器里那一份，于是**其它路照样会发请求**。

⚠️ **默认值按平台不同**：抖音默认**关**（协议明文禁止自动化采集，`devlog/335`），
其余三家默认**开**（它们是既有行为；默认关等于把用户已有的功能关掉）。
⚠️ 读设置失败时退回**该平台的默认值**（不是一律 False）—— 否则一次读设置异常会把
四个平台全停掉。
"""
import logging

logger = logging.getLogger(__name__)

#: 有开关的平台（顺序 = 界面上「平台抓取」那一组的展示顺序）
PLATFORMS: tuple[str, ...] = ("bilibili", "weibo", "xiaohongshu", "douyin")

#: 平台 → `runtime_settings` 的键（键名不要改：改了就丢用户已保存的值）
SWITCH_KEYS: dict[str, str] = {
    "bilibili": "BILIBILI_ENABLED",
    "weibo": "WEIBO_ENABLED",
    "xiaohongshu": "XIAOHONGSHU_ENABLED",
    "douyin": "DOUYIN_ENABLED",
}

#: 平台 → 默认值（抖音默认关，见文件头）
DEFAULTS: dict[str, bool] = {
    "bilibili": True,
    "weibo": True,
    "xiaohongshu": True,
    "douyin": False,
}

#: 平台 → 给用户看的名字（提示文案里用）
LABELS: dict[str, str] = {
    "bilibili": "B 站",
    "weibo": "微博",
    "xiaohongshu": "小红书",
    "douyin": "抖音",
}

#: 开关在界面上的位置**由设置声明推出来**（不写第二份字面量 —— 分组改名时它自动跟上，
#: 而提示里的指路永远不会指向一个不存在的地方）。见 `settings_path()`。


def settings_path() -> str:
    """开关在界面上的路径，例如「设置 → 数据源 → 平台抓取」。

    ⚠️ 从 `runtime_settings.spec(...)` 的 `group`/`section` 拼 —— 这是"只有一份真源"的做法：
    当年那句「设置 → 抓取设置 → 平台抓取」散在 5 个文件里，改分组就得靠人肉全找一遍。
    """
    from app.core import runtime_settings

    s = runtime_settings.spec(SWITCH_KEYS["bilibili"])
    return f"设置 → {s.group} → {s.section}"


def enabled(platform: str) -> bool:
    """这个平台的抓取开关开着吗（未知平台按**开** —— 不因为没登记的平台把功能停掉）。"""
    key = SWITCH_KEYS.get(platform)
    if key is None:
        return True
    from app.core import runtime_settings

    try:
        return bool(runtime_settings.get(key))
    except Exception as e:  # 读设置失败：退回该平台的默认值（不是一律 False）
        logger.warning("读 %s 失败（按默认值 %s 处理）: %s", key, DEFAULTS[platform], e)
        return DEFAULTS[platform]


def disabled_reason(platform: str | None) -> str | None:
    """被总开关关掉时给一句"去哪打开"；开着（或未知平台）⇒ `None`。

    ⚠️ 状态要给「已关闭」而不是「需要登录」—— 用户看到"需要登录"会去重新粘 Cookie，
    而真正该做的是打开开关（`devlog/338` 的真实反馈）。
    """
    if platform is None or platform not in SWITCH_KEYS:
        return None
    if enabled(platform):
        return None
    label = LABELS.get(platform, platform)
    # ⚠️ 默认关的平台要说清"**默认**关闭"（devlog/338 的真实反馈：用户看到"关着"会以为坏了，
    #    而它其实是设计如此 —— 得让他知道"打开就行，不是出故障了"）。
    hint = "（默认关闭）" if DEFAULTS.get(platform) is False else ""
    return (f"「{label}」的抓取已关闭{hint}（到「{settings_path()}」里打开）—— "
            f"关着时一个请求都不发")


def states() -> dict[str, dict]:
    """四个开关的当前状态（给探针/诊断读；键与 `SWITCH_KEYS` 一致）。"""
    return {
        p: {"key": SWITCH_KEYS[p], "label": LABELS[p],
            "enabled": enabled(p), "default": DEFAULTS[p]}
        for p in PLATFORMS
    }
