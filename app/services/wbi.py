import time
import hashlib
import urllib.parse
from typing import Tuple, Optional
import httpx
import logging

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


def clear_wbi_cache():
    """清除 WBI 密钥缓存，强制下次 get_wbi_keys 重新请求"""
    global _cached_keys, _cached_at
    _cached_keys = None
    _cached_at = 0
    logger.info("WBI 密钥缓存已清除")


async def get_wbi_keys() -> Tuple[str, str]:
    """从 B站导航接口获取最新的 img_key 和 sub_key"""
    global _cached_keys, _cached_at

    if _cached_keys and (time.time() - _cached_at) < CACHE_TTL:
        return _cached_keys

    url = "https://api.bilibili.com/x/web-interface/nav"
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers=auth_manager.build_headers())
        data = resp.json()

        if data.get("code") not in (0, "0"):
            raise Exception(f"获取WBI密钥失败: {data.get('message')}")

        wbi_img = data["data"]["wbi_img"]
        img_url = wbi_img["img_url"]
        sub_url = wbi_img["sub_url"]

        img_key = img_url.split("/")[-1].split(".")[0]
        sub_key = sub_url.split("/")[-1].split(".")[0]

        _cached_keys = (img_key, sub_key)
        _cached_at = time.time()
        logger.info("WBI 密钥已更新")
        return _cached_keys


def get_mixin_key(img_key: str, sub_key: str) -> str:
    raw_key = img_key + sub_key
    return "".join(raw_key[idx] for idx in MIXIN_KEY_ENC_TAB)[:32]


def encrypt_wbi(params: dict, mixin_key: str) -> str:
    params = {**params, "wts": int(time.time())}
    sorted_params = sorted(params.items())
    query_str = urllib.parse.urlencode(sorted_params)
    return hashlib.md5((query_str + mixin_key).encode("utf-8")).hexdigest()


async def sign_params(params: dict) -> dict:
    img_key, sub_key = await get_wbi_keys()
    mixin_key = get_mixin_key(img_key, sub_key)
    w_rid = encrypt_wbi(params, mixin_key)
    return {**params, "w_rid": w_rid, "wts": int(time.time())}
