"""DTK 的抖音签名实现（vendored，Apache-2.0）—— **不要在这里加业务逻辑**。

来源、改动面与许可见同目录 `NOTICE.md`；本文件只做转出（re-export），让调用方
（`app/services/platforms/signing.py::DouyinSigner`）不必知道上游的包结构。

- `ABogus`：算 `a_bogus`（构造参数 `user_agent` + `browser_info`）；
- `browser_info_from_screen`：由屏幕尺寸推那串九字段几何（**自洽但不知道窗口自身大小**：
  能拿到真机那串时优先用真机的，见 `douyin.py` 的 `IDENTITY_DEFAULTS`）；
- `structure_error` / `decode`：把任何一条 `a_bogus`（**包括浏览器造的**）拆开做结构校验 ——
  这是"签名悄悄失效"能被看见的那只眼睛（`signing.py` 的影子比对用它）；
- `is_decode_problem`：把"**这根本不是一条 a_bogus**"（字母表/长度/payload 长度）与
  "内容不符预期"（解码器的已知歧义）分开 —— 前者才值得硬停，后者只值得重签一次。
"""
from __future__ import annotations

from app.services.platforms.vendor.dtksign.abogus import (ABogus, browser_info_from_screen,
                                                          decode, is_decode_problem,
                                                          structure_error)
from app.services.platforms.vendor.dtksign.websign import (SALT, SIGNATURE_PARAM,
                                                           UIFID_COOKIE_NAMES, VERIFY_FP_COOKIE,
                                                           encode_pairs, pick_uifid, sign)

__all__ = [
    "ABogus",
    "SALT",
    "SIGNATURE_PARAM",
    "UIFID_COOKIE_NAMES",
    "VERIFY_FP_COOKIE",
    "browser_info_from_screen",
    "decode",
    "encode_pairs",
    "is_decode_problem",
    "pick_uifid",
    "sign",
    "structure_error",
]
