"""平台请求**签名器**的接口（第 4 阶段 ④，devlog/230、232）。

调研结论（`docs/platforms-xhs-douyin-research.md` §1.1、§2.3）：两家的签名都**已被开源纯 Python
复刻**，所以本地签、浏览器只在"身份过期/被风控"时兜底 —— 但**两家的签名策略不该共用**：

- **小红书**：mnsv2（`x-s` / `x-t` / `x-s-common`），依赖 MIT 的 [`xhshow`](https://github.com/Cloxl/xhshow)
  （**已进 `pyproject.toml` + `uv.lock`**，devlog/232）。签名里打包了**行为计数器**
  （点击/停留时长），纯协议爬虫计数器恒定即被识别 —— 这是这套方案**固有的**风险，不是实现 bug。
- **抖音**：`a_bogus`（bdms 字节码 VM 复刻）+ `x-secsdk-web-signature`（一个 md5）+ `x-tt-argus`，
  且**只有 14 条白名单路径**要平台级签名 ⇒ 其余路径用 `NullSigner` 即可（**尚未接入**）。

⚠️ **签名器不在（或平台改版）时必须"响亮地失败"**：静默发一个没签名的请求会被风控记一笔，
而且线上查不出来（这正是调研 §1.1 说的"签名悄悄失效、数据静默变空"）。所以这里定义了
`SignerUnavailable`，由调用方转成**结构化失败**（调研 §1.3 第 4 条）。

## 接口形状：`uri` + 结构化参数（不是拼好的 query 串）

`xhshow` 的 `sign_headers_get(uri, cookies, params=…)` 收的是 **path + 参数字典**
（2026-09-27 实测签名，v0.2.0），所以本协议照它的形状定义 —— 拼 query 是**调用方**的事
（且必须与签名时同一组键值，见 `xiaohongshu.py` 里"逗号不编码"那条）。
"""
from __future__ import annotations

from typing import Any, Optional, Protocol


class SignerUnavailable(RuntimeError):
    """签名器不可用（库没装 / 版本不兼容 / 平台改版）—— **不许静默降级**。"""


class Signer(Protocol):
    """把「方法 + 路径 + 参数 + 身份」变成一组要附上的请求头。"""

    platform: str

    def headers(
        self,
        *,
        method: str,
        uri: str,
        params: Optional[dict[str, Any]] = None,
        payload: Optional[dict[str, Any]] = None,
        cookies: str = "",
    ) -> dict[str, str]:
        ...


class NullSigner:
    """不签名（抖音的**非白名单**路径用；测试里当替身）。"""

    platform = "*"

    def headers(self, *, method: str, uri: str, params: Optional[dict[str, Any]] = None,
                payload: Optional[dict[str, Any]] = None,
                cookies: str = "") -> dict[str, str]:
        return {}


class XhsSigner:
    """小红书签名器：`xhshow`（**已进锁文件**）。

    ⚠️ 这是全仓**唯一一个"平台改版即失效"的依赖**。失效时的表现是
    `SignerUnavailable`（响亮失败）—— 升级依赖，或按调研 §1.1 的兜底路线
    （浏览器只铸/签一次）处理；**不要**改成"没签名也发"。
    """

    platform = "xiaohongshu"

    def __init__(self) -> None:
        self._sign = None  # 懒加载后缓存（构造时不 import，避免拖慢启动）

    def _load(self):
        if self._sign is not None:
            return self._sign
        try:
            from xhshow import Xhshow  # type: ignore[import-not-found]
        except Exception as e:  # noqa: BLE001 —— 任何导入失败都算"不可用"
            raise SignerUnavailable(
                "小红书签名器不可用：`xhshow` 没装上（它已在 uv.lock 里，跑 `uv sync` 即可）。"
                "⚠️ 不要退回未签名的请求 —— 那会被风控记一笔且线上查不出来。"
            ) from e
        self._sign = Xhshow()
        return self._sign

    def headers(self, *, method: str, uri: str, params: Optional[dict[str, Any]] = None,
                payload: Optional[dict[str, Any]] = None,
                cookies: str = "") -> dict[str, str]:
        signer = self._load()
        try:
            if method.upper() == "GET":
                out: Any = signer.sign_headers_get(uri, cookies, params=dict(params or {}))
            else:
                out = signer.sign_headers_post(uri, cookies, payload=dict(payload or {}))
        except Exception as e:  # noqa: BLE001 —— 库内部炸了同样算不可用
            raise SignerUnavailable(f"小红书签名失败（xhshow 内部错误）：{e}") from e
        return {k: str(v) for k, v in dict(out or {}).items()}
