# 抖音签名器（vendored，Apache-2.0）

本目录的三个 `.py` 来自 [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)
（下称 DTK），commit `4f0bed8483c35a980315d9c7b3a1d4a1119ad2b2`（2026-10-02 快照）：

| 文件 | 上游路径 | 上游 git blob | 本仓 sha256 | 改动 |
|---|---|---|---|---|
| `abogus.py` | `src/dtk/signing/native/abogus.py` | `25a081e7…` | `549b0070…` | **1 行**：`from dtk.signing.native.sm3 …` → 本包的绝对路径（见下）|
| `sm3.py` | `src/dtk/signing/native/sm3.py` | `86284ef0…` | `6ad3947e…` | 无 |
| `websign.py` | `src/dtk/signing/native/websign.py` | `0232355d…` | `b31e1809…` | 无 |

上游 blob 用 `git hash-object` 逐个比对过（2026-10-04，`devlog/333`）；本仓 sha256 由
`tests/test_platform_douyin.py` 钉住 —— **改动会红**，改完必须回来更新这张表。

**为什么只动了那一行**：`abogus.py` 里原本是绝对导入 `from dtk.signing.native.sm3 import …`，
要求 `dtk` 是**顶层**包（上游仓库里它就是）。搬进 `app/` 之后顶层没有 `dtk`，除非再往
`sys.path` 里塞一个目录 —— 那比改一行更脏。所以只把这一行的模块路径改成本包的绝对路径，
其余一个字节没动；`sm3.py` / `websign.py` 逐字节相同。

## 许可

Apache License 2.0：全文见 `LICENSE-Apache-2.0.txt`，上游 NOTICE 原文见 `UPSTREAM-NOTICE.txt`
（DTK 的版权行：`Copyright 2021-2026 Evil0ctal and contributors`）。
本仓整体是 MIT（见根 `LICENSE`）—— Apache-2.0 的部分**保留其原许可**，两者不冲突。

## ⚠️ 维护负担（写在这里，别等它咬人）

`a_bogus` 是**字节码 VM 的复刻**：抖音改版即失效，且失效的样子是
**HTTP 200 + 0 字节空体**（不是 403，见 `devlog/333` 与 `docs/design/xhs-douyin-research.md` §3.6）。
升级路线：换上游 commit 重跑这张表 → 用 `structure_error()` 先确认格式自洽 →
再发一发真机请求确认平台认。

⚠️ **`structure_error()` 有已知误报**（2026-10-04 实测，`devlog/334`）：对我们**自己刚签出来的**
签名，约 **1/300** 会报 `declared lengths overrun the frame` —— 那是解码器的歧义
（噪声展开在末尾补的一组字节与真实数据不可区分，本文件上游注释里的 "give or take the two bytes"
说的就是它），**不是签名坏了**。所以调用方（`signing.py::DouyinSigner`）按
`is_decode_problem()` **分级**：那三类（字母表/长度/payload 太短）才是"这根本不是签名"，
其余只重签几次、仍不行就照发 + warning。改这一层时别把它退回成硬闸门。
