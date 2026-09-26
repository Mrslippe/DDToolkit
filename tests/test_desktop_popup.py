# -*- coding: utf-8 -*-
"""自绘提示窗（品牌色卡片，R50，devlog/219）测试：

- **纯几何**（不碰 Win32）：DPI 缩放、正文行数 → 高度、各块矩形不重叠、无链接时不排提示行；
- **窗口行为**（仅 Windows）：建窗/展示、点击路由（调 on_click + 立刻收起）、
  到点自动收起、消息泵有上限、**圆角抗锯齿**（逐像素 alpha）。

配色不提"断言值"：它是品牌常量，改配色时不该让测试红 —— 但**是否真的按 DPI 缩放**、
**点击是否真的触发**、**是否到点收起**、**圆角有没有抗锯齿**这几条必须钉住。
"""
import time
import struct
import zlib

import pytest

from app.core import runtime_settings as rs
from app.core.config import settings
from app.services import desktop_popup


@pytest.fixture(autouse=True)
def _unit_scale():
    """几何类断言先固定整体缩放为 1.0 —— 这样"DPI 缩放"与"用户缩放"两件事互不干扰。
    用户缩放另有专门用例（`test_font_scale_enlarges_text_geometry_but_not_width`）。

    ⚠️ 两条坑：
    ① 用 `Settings` 的**实例属性后门**（覆盖层挡不住它，见 `config.__getattribute__`）——
       设置界面的合法范围是 80~200%，而用例要用 100% 这个中性值量"纯 DPI 缩放"；
    ② **收尾必须 `del` 掉实例属性，不能用 `monkeypatch.setattr`** —— monkeypatch 的撤销
       逻辑是"有旧值就 setattr 回去"，而 SPECS 键**永远有旧值**（类属性），于是它会把
       实例属性永久留在 `settings.__dict__` 里，后面任何 `rs.apply()` 都改不动这些键
       （实测踩过：全量跑时 `test_master_switch_blocks_everything` 被这条污染而假红）。
    """
    settings.NOTIFY_FONT_PCT = 100
    rs.clear()
    yield
    settings.__dict__.pop("NOTIFY_FONT_PCT", None)
    rs.clear()


# ── 纯几何 ────────────────────────────────────────────────────────────

def test_layout_scales_with_dpi():
    """150% 缩放下宽度与内距都要放大，不能变成"小字模式"。"""
    base = desktop_popup.compute_layout(96, title_h=20, body_h=34, hint_h=17, width_dip=380)
    big = desktop_popup.compute_layout(144, title_h=30, body_h=51, hint_h=26, width_dip=380)
    assert base.width == 380
    assert big.width == round(380 * 1.5)
    assert big.pad > base.pad and big.radius > base.radius
    assert big.height > base.height
    assert desktop_popup.text_width(144) > desktop_popup.text_width(96)


def test_layout_blocks_do_not_overlap_and_hint_is_last():
    lay = desktop_popup.compute_layout(96, title_h=20, body_h=34, hint_h=17)
    assert lay.title[3] <= lay.body[1]        # 标题下沿 ≤ 正文上沿
    assert lay.body[3] <= lay.hint[1]         # 正文下沿 ≤ 提示上沿
    assert lay.hint[3] <= lay.height          # 提示不越界
    assert lay.title[0] > lay.bar[2]          # 文字在左侧强调条右侧
    assert lay.bar[3] <= lay.height - lay.pad + 1
    assert lay.title[2] == lay.body[2] == lay.hint[2] == lay.width - lay.pad


def test_layout_without_hint_is_shorter_and_has_no_hint_row():
    with_hint = desktop_popup.compute_layout(96, title_h=20, body_h=34, hint_h=17)
    without = desktop_popup.compute_layout(96, title_h=20, body_h=34, hint_h=17,
                                           has_hint=False)
    assert without.height < with_hint.height
    assert without.has_hint is False
    assert without.hint[3] == without.hint[1]      # 空行


def test_more_body_lines_make_a_taller_card():
    one = desktop_popup.compute_layout(96, title_h=20, body_h=17, hint_h=17)
    three = desktop_popup.compute_layout(96, title_h=20, body_h=51, hint_h=17)
    assert three.height - one.height == 34          # 多两行正文 = 高 2×17


def test_popup_settings_are_wired(monkeypatch):
    assert isinstance(desktop_popup.popup_enabled(), bool)
    assert desktop_popup.popup_seconds() > 0
    settings.NOTIFY_ENABLED = False
    try:
        assert desktop_popup.popup_enabled() is False   # 总开关：只有这一个通道，关掉就是关掉
    finally:
        # 见 `_unit_scale` 的第 ② 条：实例属性必须显式删掉，不能用 monkeypatch 收尾
        del settings.__dict__["NOTIFY_ENABLED"]


def test_font_scale_enlarges_text_geometry_but_not_width():
    """**字号**与**弹窗大小**分开：字号只管文字侧（内距/圆角/图标），宽度不跟它变。"""
    # ⚠️ 字号走**实例属性**（上面的夹具已经把默认缩放钉在 100%，实例属性优先于覆盖层）；
    #    宽度走覆盖层（没人钉它，走设置系统那条真路）。
    rs.apply({"NOTIFY_POPUP_WIDTH": 380})
    settings.NOTIFY_FONT_PCT = 100
    small = desktop_popup.compute_layout(96, title_h=20, body_h=17, hint_h=17, icon_px=30)
    assert small.width == 380

    settings.NOTIFY_FONT_PCT = 150
    big = desktop_popup.compute_layout(96, title_h=30, body_h=26, hint_h=26, icon_px=45)
    assert big.pad > small.pad and big.radius > small.radius
    assert big.width == small.width                                  # 宽度不受字号影响
    assert desktop_popup.popup_scale() == 1.5

    rs.apply({"NOTIFY_POPUP_WIDTH": 600})                             # 只改"弹窗大小"
    wider = desktop_popup.compute_layout(96, title_h=30, body_h=26, hint_h=26, icon_px=45)
    assert wider.width == 600 and wider.pad == big.pad               # 宽度变了、字号侧没变

    # 界面上改不到的范围由**后端**拒绝（400 + 中文原因），绘制层再兜一道夹取：
    # 两道都要在 —— 少了前者界面会显示"已保存"但没生效；少了后者，一个脏值就能把卡片画爆。
    with pytest.raises(ValueError):
        rs.apply({"NOTIFY_FONT_PCT": 500})
    with pytest.raises(ValueError):
        rs.apply({"NOTIFY_FONT_PCT": 10})
    settings.NOTIFY_FONT_PCT = 500
    try:
        assert desktop_popup.popup_scale() == 2.0                     # 上限
    finally:
        del settings.__dict__["NOTIFY_FONT_PCT"]
    settings.NOTIFY_FONT_PCT = 10
    try:
        assert desktop_popup.popup_scale() == 0.8                     # 下限（再小就没法读了）
    finally:
        del settings.__dict__["NOTIFY_FONT_PCT"]


def test_default_popup_scale_is_enlarged():
    """默认值：字号 120%、弹窗大小 450 DIP（用户 2026-09-26 定的那套，原样搬过来）。"""
    # 去掉上面那个"单位缩放"夹具设的实例属性，读回 `Settings` 类上的真实默认值
    settings.__dict__.pop("NOTIFY_FONT_PCT", None)
    rs.clear()
    assert abs(desktop_popup.popup_scale() - 1.20) < 1e-9
    assert desktop_popup._px(15, 96) == 18          # 标题 15 → 18
    assert desktop_popup._px(12, 96) == 14          # 正文 12 → 14
    assert desktop_popup.popup_width_dip() == 450   # 卡片宽度默认 450
    assert desktop_popup.width_px(96) == 450


def test_layout_with_icon_reserves_room_left_of_title():
    without = desktop_popup.compute_layout(96, title_h=20, body_h=34, hint_h=17)
    with_icon = desktop_popup.compute_layout(96, title_h=20, body_h=34, hint_h=17, icon_px=30)
    assert without.icon is None
    assert with_icon.icon is not None
    icon = with_icon.icon
    assert icon[2] - icon[0] == 30 and icon[3] - icon[1] == 30     # 正方形
    assert with_icon.title[0] > icon[2]                            # 标题在图标右侧
    assert icon[0] == with_icon.body[0]                            # 与正文左对齐
    assert with_icon.height > without.height                       # 图标把首行撑高了
    assert icon[3] <= with_icon.body[1]                            # 图标不与正文重叠


def test_icon_sizes_follow_dpi_roles():
    """按用途取对的尺寸：托盘 16 档、气泡 32 档，随 DPI 放大 —— 不拉伸才不糊。"""
    def px(base: int, dpi: int) -> int:
        s = max(1.0, dpi / 96.0)
        return max(base, round(base * s))

    assert (px(16, 96), px(32, 96)) == (16, 32)
    assert (px(16, 144), px(32, 144)) == (24, 48)     # 150% 缩放：命中 ico 里的 24/48 档
    assert (px(16, 192), px(32, 192)) == (32, 64)     # 200%


def test_popup_duration_setting_and_bounds():
    """弹窗时长：设置里可改，最短 5 秒、最长 2 分钟（用户 2026-09-26 口径）。"""
    rs.apply({"NOTIFY_POPUP_SECONDS": 30})
    assert desktop_popup.popup_seconds() == 30
    with pytest.raises(ValueError):
        rs.apply({"NOTIFY_POPUP_SECONDS": 1})          # 后端拒绝（下限 5 秒）
    with pytest.raises(ValueError):
        rs.apply({"NOTIFY_POPUP_SECONDS": 9999})       # 上限 2 分钟
    settings.NOTIFY_POPUP_SECONDS = 1
    try:
        assert desktop_popup.popup_seconds() == 5      # 绘制层再兜一道
    finally:
        del settings.__dict__["NOTIFY_POPUP_SECONDS"]
    settings.NOTIFY_POPUP_SECONDS = 9999
    try:
        assert desktop_popup.popup_seconds() == 120
    finally:
        del settings.__dict__["NOTIFY_POPUP_SECONDS"]


def test_stack_layout_grows_upward_and_shifts_main_card():
    """折叠显示：层数越多窗口越高，主卡片整体下移（给后面几层的"露头"让位）。"""
    one = desktop_popup.compute_layout(96, title_h=20, body_h=34, hint_h=17, stack=1)
    three = desktop_popup.compute_layout(96, title_h=20, body_h=34, hint_h=17, stack=3)
    assert three.width == one.width                       # 折叠只加高、不加宽
    assert three.height > one.height
    assert three.title[1] > one.title[1]                  # 主卡片文字整体下移
    assert 0 < three.title[3] - three.title[1] == one.title[3] - one.title[1]


# ── 折叠行为（仅 Windows：需要真实窗口来 push/peek）─────────────────────

def _push(popup, title: str, url: str | None = None) -> None:
    popup.show(title=title, body=f"{title} 的正文", url=url,
               hint="点击打开 ›" if url else "", seconds=60)


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_stack_pushes_up_to_ten_and_drops_oldest():
    """一摞最多 10 层（用户口径）：第 11 条进来时挤掉**最旧**那条，新的更重要。"""
    popup = desktop_popup.PopupWindow()
    try:
        _push(popup, "第 1 条")
        assert popup.stack == 1 and popup.visible
        for i in range(2, 12):          # 再叠 10 条（共 11 条）
            _push(popup, f"第 {i} 条")
        assert popup.stack == desktop_popup.STACK_MAX == 10
        assert popup._texts["title"] == "第 11 条"          # 卡面是最新那条
        # 一层层收光：应该收 10 次，且最旧的"第 1 条"已被挤掉（收到最后是"第 2 条"）
        seen = []
        while popup.visible:
            seen.append(popup._texts["title"])
            popup._dismiss_top()
        assert len(seen) == 10
        assert seen[0] == "第 11 条" and seen[-1] == "第 2 条"
        assert "第 1 条" not in seen
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_dismiss_top_reveals_next_layer():
    """点击/悬停**只收走最顶上一层**，下面那层立刻露出来（文案与链接都换过去）。"""
    popup = desktop_popup.PopupWindow()
    try:
        _push(popup, "下面那条", url="https://example.com/below")
        _push(popup, "最顶上那条", url="https://example.com/top")
        assert popup.stack == 2 and popup._texts["title"] == "最顶上那条"
        assert popup._url == "https://example.com/top"

        popup._dismiss_top()
        assert popup.visible is True                    # 还有下层：窗口不关
        assert popup.stack == 1
        assert popup._texts["title"] == "下面那条"       # 露出下一条
        assert popup._url == "https://example.com/below"

        popup._dismiss_top()
        assert popup.visible is False                   # 收光了才隐藏
        assert popup.stack == 0
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_click_dismisses_only_top_layer_and_opens_its_link():
    clicked: list[str] = []
    popup = desktop_popup.PopupWindow(on_click=clicked.append)
    try:
        _push(popup, "下面那条", url="https://example.com/below")
        _push(popup, "最顶上那条", url="https://example.com/top")
        popup._on_message(popup._hwnd, popup.WM_LBUTTONUP, 0, 0)
        assert clicked == ["https://example.com/top"]   # 打开的是顶层那条
        assert popup.visible is True and popup.stack == 1
        assert popup._texts["title"] == "下面那条"
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_hover_dismisses_only_one_layer_at_a_time():
    popup = desktop_popup.PopupWindow()
    try:
        _push(popup, "一层")
        _push(popup, "二层")
        _push(popup, "三层")
        assert popup.stack == 3

        popup._set_hover(True)
        popup._hover_since -= desktop_popup.HOVER_DISMISS_SECONDS + 0.05
        popup.tick()
        assert popup.visible is True and popup.stack == 2       # 只少一层

        popup._hover_since = time.monotonic() - desktop_popup.HOVER_DISMISS_SECONDS - 0.05
        popup.tick()
        assert popup.stack == 1
    finally:
        popup.close()


def test_popup_alpha_is_clamped_semi_transparent():
    """界面上的不透明度是**百分数**（默认 91%），绘制层要 0~255 —— 换算与夹取都在这一处。"""
    assert desktop_popup.popup_alpha() == 232                  # 91% → 232（默认值）
    settings.NOTIFY_POPUP_ALPHA_PCT = 10                       # 太透会看不清字
    try:
        assert desktop_popup.popup_alpha() == 80
    finally:
        del settings.__dict__["NOTIFY_POPUP_ALPHA_PCT"]
    settings.NOTIFY_POPUP_ALPHA_PCT = 300
    try:
        assert desktop_popup.popup_alpha() == 255
    finally:
        del settings.__dict__["NOTIFY_POPUP_ALPHA_PCT"]


def test_app_icon_path_resolves_to_repo_icon():
    path = desktop_popup.app_icon_path()
    assert path is not None and path.name == "icon.ico" and path.exists()


def _write_png(path, size: int = 8) -> None:
    """写一张纯色 PNG（测试用，零依赖）—— 冒充"主播头像文件"。"""
    raw = b"".join(b"\x00" + b"\xff\x80\x90\xff" * size for _ in range(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="头像转图标走 GDI+，仅 Windows")
def test_image_file_to_hicon_loads_and_scales(tmp_path):
    """主播头像是 jpg/png 这类位图，必须能转成 HICON（`LoadImageW` 只认 .ico/.bmp）。"""
    png = tmp_path / "avatar.png"
    _write_png(png)
    hicon = desktop_popup.image_file_to_hicon(png, 32)
    try:
        assert hicon != 0, "头像转 HICON 失败"
    finally:
        desktop_popup.destroy_icon(hicon)

    # 缺失文件 / 空路径：返回 0（调用方据此退回 App 图标，通知照常弹）
    assert desktop_popup.image_file_to_hicon(tmp_path / "missing.jpg", 32) == 0
    assert desktop_popup.image_file_to_hicon(None, 32) == 0


# ── 圆角抗锯齿（逐像素 alpha 渲染管线，devlog/090 §五点十二）───────────────
# 用户口径：「最底层弹窗的角像素有点糊」→「角还是有点糊」。
# 判据不能是"看着还行"，得是**像素值**：圆角弧上必须出现"半透明过渡像素"，
# 而老画法（1 位窗口 Region + GDI RoundRect）只会给出 0 或 255 两种值，没有中间态。
# 取证走离屏画布 —— 和窗口贴图是**同一段绘制代码**，所以量到的就是屏幕上看到的。

_SAMPLE_TEXTS = {"title": "明前奶绿 开播了", "body": "B站直播间｜看日剧喵",
                 "hint": "点击进入直播间 ›"}


def _sample_card(dpi: int = 144, behind: int = 0):
    """离屏渲染一张卡片，返回 `(surface, layout)`（GDI+ 不可用时 surface 为 None）。"""
    painter = desktop_popup.CardPainter()
    try:
        tw = desktop_popup.text_width(dpi, 450)
        title_h = painter.measure(_SAMPLE_TEXTS["title"], desktop_popup.BASE_TITLE_SIZE,
                                  desktop_popup.FONT_WEIGHT_SEMIBOLD, tw, wrap=False, dpi=dpi)
        body_h = painter.measure(_SAMPLE_TEXTS["body"], desktop_popup.BASE_BODY_SIZE,
                                 desktop_popup.FONT_WEIGHT_NORMAL, tw, wrap=True, dpi=dpi)
        hint_h = painter.measure(_SAMPLE_TEXTS["hint"], desktop_popup.BASE_HINT_SIZE,
                                 desktop_popup.FONT_WEIGHT_SEMIBOLD, tw, wrap=False, dpi=dpi)
    finally:
        painter.close()
    rects = desktop_popup.compute_layout(
        dpi, title_h=title_h, body_h=body_h, hint_h=hint_h, width_dip=450,
        has_hint=True, icon_px=desktop_popup._px(desktop_popup.BASE_ICON, dpi),
        stack=behind + 1)
    return desktop_popup.render_card_surface(rects, dpi=dpi, texts=_SAMPLE_TEXTS,
                                             behind=behind), rects


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_desktop_popup_corners_are_antialiased():
    """圆角弧上必须有半透明过渡像素；圆角外必须完全透明（用户："角还是有点糊"）。"""
    surface, rects = _sample_card()
    if surface is None:
        pytest.skip("GDI+ 不可用（本机没有 GDI+ 就退回 GDI 画法）")
    try:
        r = rects.radius
        partial = sum(1 for y in range(r + 2) for x in range(r + 2)
                      if 16 <= surface.pixel(x, y)[0] <= 239)
        assert partial >= 8, (
            f"左上角只有 {partial} 个半透明像素 —— 还是 1 位硬边（抗锯齿没生效）")
        for x, y in [(0, 0), (1, 0), (0, 1),
                     (rects.width - 1, 0), (0, rects.height - 1),
                     (rects.width - 1, rects.height - 1)]:
            assert surface.pixel(x, y)[0] < 40, f"圆角外 ({x},{y}) 竟然是不透明的"
        assert surface.pixel(rects.width // 2, rects.height // 2)[0] == 255
    finally:
        surface.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_desktop_popup_stacked_layers_keep_smooth_corners():
    """折叠多层时，「露头」那一层的角同样要抗锯齿（用户点名的"最底层弹窗的角"）。"""
    surface, rects = _sample_card(behind=3)
    if surface is None:
        pytest.skip("GDI+ 不可用")
    try:
        partial = sum(1 for y in range(rects.radius + 2) for x in range(rects.radius + 2)
                      if 16 <= surface.pixel(x, y)[0] <= 239)
        assert partial >= 8
        assert surface.pixel(0, 0)[0] < 40
        assert surface.pixel(rects.width - 1, 0)[0] < 40
    finally:
        surface.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_popup_falls_back_to_gdi_when_gdiplus_missing(monkeypatch):
    """GDI+ 不可用时**必须还能弹**（退回老的 Region + GDI 画法）：通知能不能弹是硬要求。"""
    monkeypatch.setattr(desktop_popup, "_gdiplus", lambda: None)
    popup = desktop_popup.PopupWindow()
    try:
        assert popup.show(title="T", body="B", url="https://example.com",
                          hint="点击打开 ›", seconds=30) is True
        assert popup._layered is False
        assert popup._rects is not None
        for _ in range(10):          # 让 WM_PAINT 走完（同时覆盖 GDI 绘制路径）
            popup.pump()
            time.sleep(0.01)
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_popup_is_layered_semi_transparent():
    """窗口必须是 WS_EX_LAYERED，且贴上去的**不透明度就是设置里的值**（"粉色半透"的判据）。

    2026-09-26 起改走 `UpdateLayeredWindow`（逐像素 alpha，圆角才不糊），
    不透明度由 `BLENDFUNCTION.SourceConstantAlpha` 带上去，而不是
    `SetLayeredWindowAttributes`（两者在同一个窗口上互斥，不能混用）。
    """
    import ctypes

    popup = desktop_popup.PopupWindow()
    try:
        assert popup.show(title="T", body="B", url=None, seconds=30) is True
        user32 = popup._user32
        user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
        user32.GetWindowLongW.restype = ctypes.c_long
        ex = user32.GetWindowLongW(ctypes.c_void_p(popup._hwnd), -20)   # GWL_EXSTYLE
        assert ex & 0x00080000, "窗口没有 WS_EX_LAYERED"
        assert popup._present_alpha == desktop_popup.popup_alpha()
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_opacity_change_applies_to_next_show():
    """**改完设置再弹，就要按新透明度显示** —— 窗口是复用的，若把 alpha 只在建窗时设一次，
    用户改滑杆后得重启进程才生效（实测踩过：用户反馈"不透明度没有生效"）。
    """
    popup = desktop_popup.PopupWindow()
    try:
        rs.apply({"NOTIFY_POPUP_ALPHA_PCT": 94})          # 94% → 240
        popup.show(title="T", body="B", url=None, seconds=30)
        assert popup._present_alpha == 240

        rs.apply({"NOTIFY_POPUP_ALPHA_PCT": 47})          # 用户在设置里把滑杆拉低（47% → 120）
        popup.show(title="T", body="B", url=None, seconds=30)
        assert popup._present_alpha == 120               # 下一次展示就用新值
    finally:
        popup.close()


# ── 窗口行为（仅 Windows）──────────────────────────────────────────────

@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_popup_shows_measures_and_paints():
    clicked: list[str] = []
    popup = desktop_popup.PopupWindow(on_click=clicked.append)
    try:
        assert popup.show(title="明前奶绿 开播了", body="B站直播间｜看日剧喵",
                          url="https://live.bilibili.com/1", hint="点击进入直播间 ›",
                          seconds=30) is True
        assert popup._visible is True
        rects = popup._rects
        assert rects is not None and rects.width == desktop_popup.width_px(popup._dpi)
        assert rects.has_hint
        for _ in range(10):          # 让 WM_PAINT 走完（同时覆盖绘制路径）
            popup.pump()
            time.sleep(0.01)
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_popup_click_opens_url_and_hides():
    clicked: list[str] = []
    popup = desktop_popup.PopupWindow(on_click=clicked.append)
    try:
        popup.show(title="T", body="B", url="https://example.com/x", hint="点击打开 ›",
                   seconds=30)
        popup._on_message(popup._hwnd, popup.WM_LBUTTONUP, 0, 0)
        assert clicked == ["https://example.com/x"]
        assert popup._visible is False          # 点完立刻收
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_popup_without_url_closes_without_opening():
    clicked: list[str] = []
    popup = desktop_popup.PopupWindow(on_click=clicked.append)
    try:
        popup.show(title="T", body="B", url=None, hint="", seconds=30)
        popup._on_message(popup._hwnd, popup.WM_LBUTTONUP, 0, 0)
        assert clicked == [] and popup._visible is False
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_popup_tick_hides_after_timeout():
    popup = desktop_popup.PopupWindow()
    try:
        popup.show(title="T", body="B", url=None, seconds=0.05)
        assert popup._visible is True
        time.sleep(0.08)
        popup.tick()
        assert popup._visible is False
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_hover_three_seconds_dismisses_card():
    """鼠标停在卡片上**满 3 秒**即消除（不必等"弹窗时长"走完）；移开则计时清零。"""
    popup = desktop_popup.PopupWindow()
    try:
        popup.show(title="T", body="B", url=None, seconds=60)      # 时长故意设长
        assert popup.visible is True

        popup._set_hover(True)                    # 鼠标进入
        popup.tick()
        assert popup.visible is True              # 刚进去，还没满 3 秒

        popup._hover_since -= desktop_popup.HOVER_DISMISS_SECONDS + 0.05
        popup.tick()                              # 等价于"已经停了 3 秒"
        assert popup.visible is False

        popup.show(title="T", body="B", url=None, seconds=60)
        popup._set_hover(True)
        popup._set_hover(False)                   # 移开
        assert popup._hover_since == 0.0          # 计时清零，不会被"攒起来"
        popup._hover_since = time.monotonic() - 10
        popup.tick()
        assert popup.visible is True              # 移开后不该再被误消
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_popup_duration_setting_controls_auto_close():
    """停留时长读设置：设成 5 秒就 5 秒收（最短档），设成 120 秒就长留。"""
    popup = desktop_popup.PopupWindow()
    try:
        rs.apply({"NOTIFY_POPUP_SECONDS": 5})
        popup.show(title="T", body="B", url=None)          # 不给 seconds → 用设置
        assert popup._seconds == 5
        popup._shown_at -= 5.1
        popup.tick()
        assert popup.visible is False
    finally:
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_font_scale_change_rebuilds_all_fonts():
    """改「字号」后，**标题 / 正文 / 提示三行都要跟着变**。

    曾经的 bug：字体按 (role, DIP, weight, DPI) 缓存 —— 缓存键里没有"最终像素高度"，
    于是第一条通知建好字体后，改字号不会重建，要**重启应用**才生效。
    用户实测原话："字号变化只有顶上标题会变，下面的内容不会变"
    （本质是标题在重启那次用新字号建过字体，正文没赶上）。
    """
    popup = desktop_popup.PopupWindow()
    try:
        settings.NOTIFY_FONT_PCT = 100
        popup.show(title="标题", body="正文一行", url="https://example.com/x",
                   hint="点击打开 ›", seconds=30)
        small = popup._rects
        assert small is not None

        settings.NOTIFY_FONT_PCT = 160
        popup.show(title="标题", body="正文一行", url="https://example.com/x",
                   hint="点击打开 ›", seconds=30)
        big = popup._rects
        assert big is not None

        for name in ("title", "body", "hint"):
            before = small.__getattribute__(name)
            after = big.__getattribute__(name)
            assert (after[3] - after[1]) > (before[3] - before[1]), (
                f"{name} 没跟着字号变大（{before} → {after}）—— 字体缓存键又漏了缩放？")
    finally:
        settings.__dict__.pop("NOTIFY_FONT_PCT", None)   # 收尾删实例属性（见 `_unit_scale`）
        popup.close()


@pytest.mark.skipif(not desktop_popup.IS_WINDOWS, reason="自绘窗仅 Windows 有定义")
def test_popup_pump_is_budgeted(monkeypatch):
    """消息刷屏时 pump 也必须返回（notifier 在真实桌面上踩过这个坑）。"""
    popup = desktop_popup.PopupWindow()
    calls = {"peek": 0, "dispatch": 0}

    class _AlwaysBusy:
        def PeekMessageW(self, *a):
            calls["peek"] += 1
            return 1

        def TranslateMessage(self, *a):
            return 1

        def DispatchMessageW(self, *a):
            calls["dispatch"] += 1
            return 0

    try:
        monkeypatch.setattr(popup, "_user32", _AlwaysBusy())
        assert popup.pump(budget=5) == 5
        assert calls == {"peek": 5, "dispatch": 5}
    finally:
        popup.close()
