import time
import hashlib
import urllib.parse
from typing import Tuple, Optional
import httpx
import logging

from app.core.http import new_async_client
from app.services.auth import auth_manager

logger = logging.getLogger(__name__)

# WBI 密钥置换表
MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

# WBI 密钥缓存（30 分钟有效期，与 auth 心跳同频）
_cached_keys: Optional[Tuple[str, str]] = None
_cached_at: float = 0
CACHE_TTL = 1800  # 30 分钟

# 密钥是从哪来的（给「能力矩阵」用）：None = 还没取过
#   True = **匿名** nav 给的（未登录也能取，2026-09-15 实测）· False = 已登录 nav 给的
_keys_were_anonymous: Optional[bool] = None


def clear_wbi_cache():
    """清除 WBI 密钥缓存，强制下次 get_wbi_keys 重新请求"""
    global _cached_keys, _cached_at, _keys_were_anonymous
    _cached_keys = None
    _cached_at = 0
    _keys_were_anonymous = None
    logger.info("WBI 密钥缓存已清除")


def wbi_status() -> dict:
    """密钥状态快照（能力矩阵/诊断用）：`{cached, anonymous}`。"""
    cached = bool(_cached_keys) and (time.time() - _cached_at) < CACHE_TTL
    return {"cached": cached, "anonymous": _keys_were_anonymous if cached else None}


async def get_wbi_keys(allow_anonymous: bool = False) -> Tuple[str, str]:
    """从 B站导航接口获取最新的 img_key 和 sub_key。

    ⚠️ **`nav` 对未登录用户返回 `code=-101 账号未登录`，但同一个响应里照样带着
    `data.wbi_img`**（WBI 密钥不随登录态变，2026-09-15 用原始回包实测）。
    所以"未登录就用不了 WBI 签名"是**我们自己的**判据，不是平台限制：
    `allow_anonymous=True` 时按匿名可用处理 —— 只给**检索类**路径用；
    空间内容接口（投稿/动态）匿名会被平台 `412 request was banned`，
    见 `services/capabilities.py` 的实测矩阵。
    """
    global _cached_keys, _cached_at, _keys_were_anonymous

    if _cached_keys and (time.time() - _cached_at) < CACHE_TTL:
        return _cached_keys

    url = "https://api.bilibili.com/x/web-interface/nav"
    async with new_async_client() as client:
        resp = await client.get(url, headers=auth_manager.build_headers())
        data = resp.json()

        wbi_img = (data.get("data") or {}).get("wbi_img") or {}
        logged_in = data.get("code") in (0, "0")
        if not logged_in:
            if not (allow_anonymous and wbi_img.get("img_url")):
                raise Exception(f"获取WBI密钥失败: {data.get('message')}")
            logger.info("WBI 密钥来自**匿名** nav（未登录；平台照样下发 wbi_img）")

        if not wbi_img.get("img_url"):
            raise Exception("获取WBI密钥失败: nav 未返回 wbi_img")

        img_key = wbi_img["img_url"].split("/")[-1].split(".")[0]
        sub_key = wbi_img["sub_url"].split("/")[-1].split(".")[0]

        _cached_keys = (img_key, sub_key)
        _cached_at = time.time()
        _keys_were_anonymous = not logged_in
        logger.info("WBI 密钥已更新" + ("（匿名）" if not logged_in else ""))
        return _cached_keys


def get_mixin_key(img_key: str, sub_key: str) -> str:
    raw_key = img_key + sub_key
    return "".join(raw_key[idx] for idx in MIXIN_KEY_ENC_TAB)[:32]


def encrypt_wbi(params: dict, mixin_key: str) -> str:
    params = {**params, "wts": int(time.time())}
    sorted_params = sorted(params.items())
    query_str = urllib.parse.urlencode(sorted_params)
    return hashlib.md5((query_str + mixin_key).encode("utf-8")).hexdigest()


async def sign_params(params: dict, allow_anonymous: bool = False) -> dict:
    """签名 `params`。`allow_anonymous=True` 时未登录也能签（见 `get_wbi_keys`）。"""
    img_key, sub_key = await get_wbi_keys(allow_anonymous=allow_anonymous)
    mixin_key = get_mixin_key(img_key, sub_key)
    w_rid = encrypt_wbi(params, mixin_key)
    return {**params, "w_rid": w_rid, "wts": int(time.time())}
