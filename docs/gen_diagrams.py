# -*- coding: utf-8 -*-
"""为 ddtoolkit 项目分析报告生成 SVG 架构图。"""
import html
from pathlib import Path

OUT = Path(__file__).parent / "diagrams"
OUT.mkdir(exist_ok=True)

FONT = "'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif"
MARK = '''<defs>
<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2F6FAD"/></marker>
<marker id="arrG" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8A8A8A"/></marker>
<marker id="arrO" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#C05621"/></marker>
<marker id="arrG2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2E9E5B"/></marker>
</defs>'''


def esc(s):
    return html.escape(str(s), quote=False)


def svg(w, h, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
            f'viewBox="0 0 {w} {h}" font-family="{FONT}">{MARK}{body}</svg>')


def rect(x, y, w, h, fill="#FFFFFF", stroke="#3A6EA5", sw=1.5, rx=8, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="{sw}"{d}/>')


def text(x, y, s, size=13, fill="#1F2937", anchor="start", weight=400, family=None):
    fam = f' font-family="{family}"' if family else ""
    return (f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" '
            f'text-anchor="{anchor}" font-weight="{weight}"{fam}>{esc(s)}</text>')


def line(x1, y1, x2, y2, color="#5B6B7C", sw=1.6, dash=None, marker=None):
    m = f' marker-end="url(#{marker})"' if marker else ""
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{sw}"{d}{m}/>'


def path(d, color="#5B6B7C", sw=1.6, dash=None, marker=None):
    m = f' marker-end="url(#{marker})"' if marker else ""
    ds = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{ds}{m}/>'


def box(x, y, w, h, title, lines=None, fill="#EEF4FB", stroke="#3A6EA5",
        tcolor="#1F3A5F", tsize=13, bsize=12, bcolor="#334155", title_dy=20, bold_title=True):
    """标题居中（可含 \n 多行），正文左对齐列表。"""
    parts = [rect(x, y, w, h, fill=fill, stroke=stroke)]
    tlines = title.split("\n")
    ty = y + title_dy
    for tl in tlines:
        parts.append(text(x + w / 2, ty, tl, size=tsize, anchor="middle",
                          fill=tcolor, weight=600 if bold_title else 400))
        ty += tsize + 4
    if lines:
        yy = ty + 6
        for ln in lines:
            parts.append(text(x + 12, yy, ln, size=bsize, fill=bcolor))
            yy += bsize + 6
    return "".join(parts)


def band_caption(x, y, s, color):
    return text(x, y, s, size=12, fill=color, weight=700)


def save(name, content):
    p = OUT / name
    p.write_text(content, encoding="utf-8")
    print(f"written {p} ({len(content)} bytes)")


# ─────────────────────────────────────────────────────────────────────
# 图 1：系统整体分层架构
# ─────────────────────────────────────────────────────────────────────
def d1():
    body = []
    # ① 客户端层 y=30..130
    body.append(band_caption(60, 24, "① 客户端层", "#C05621"))
    body.append(box(60, 46, 380, 60, "scripts/discover_vtubers.py — 独立发现脚本（仅依赖 httpx）",
                    ["从 vtbs.moe 拉名单 → 取粉丝数 → 写 vtubers.csv"], fill="#FDF2E9", stroke="#E67E22", tcolor="#9C4A0B", tsize=12.5))
    body.append(box(560, 46, 300, 60, "浏览器 / curl — REST API 调用",
                    ["Swagger 文档 /docs 可直接调试"], fill="#FDF2E9", stroke="#E67E22", tcolor="#9C4A0B"))
    body.append(box(940, 46, 300, 60, "vtbs.moe（外部）\nvdb.vtbs.moe/json/list.json",
                    ["3000+ VTuber 名单库"], fill="#FDF2E9", stroke="#E67E22", tcolor="#9C4A0B"))
    # ② 接口层 y=150..274
    body.append(band_caption(60, 144, "② 接口层 — FastAPI（app/main.py 组装 · CORS 全开放 · /static 静态挂载）", "#2F6FAD"))
    body.append(box(60, 150, 1120, 124, "app/routers/vtuber.py — 16 个端点",
                    None, fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    body.append(box(80, 196, 250, 62, "VTuber CRUD（5）", ["GET/POST/PUT/DELETE\n/vtuber*"], fill="#F7FBFE", stroke="#7FB3D5", tsize=12))
    body.append(box(345, 196, 250, 62, "Account CRUD（4）", ["/vtuber/{id}/accounts\n/account/{id}"], fill="#F7FBFE", stroke="#7FB3D5", tsize=12))
    body.append(box(610, 196, 250, 62, "Post CRUD（4）", ["/posts/{platform}/{uid}\n/post/{id}"], fill="#F7FBFE", stroke="#7FB3D5", tsize=12))
    body.append(box(875, 196, 285, 62, "抓取触发（3）", ["GET|POST /vtuber/fetch\n/fetch-posts · /fetch-all-posts"], fill="#F7FBFE", stroke="#7FB3D5", tsize=12))
    # ③ 服务层 y=310..470
    body.append(band_caption(60, 300, "③ 服务层 — 业务逻辑（455+677+443 行）", "#2E9E5B"))
    body.append(box(60, 330, 200, 140, "importer.py", ["CSV 导入\nflag=1 行\n(platform,uid) 去重\nVTuber+Account 落库"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(box(280, 330, 200, 140, "scheduler.py", ["APScheduler 定时\n手动抓取锁\n风控冷却编排\n帖子抓取编排"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(box(500, 330, 200, 140, "fetcher.py", ["B 站 API 客户端\ntenacity 重试\n风控检测\n动态类型映射"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(box(720, 330, 200, 140, "auth.py", ["BilibiliAuth 单例\n心跳 / 续期 / 扫码\nCookie 写回 .env\n30 分钟维护循环"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(box(940, 330, 200, 140, "wbi.py", ["WBI 签名算法\n置换表混钥\nMD5 w_rid\n密钥缓存 30min"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    # ④ 外部系统带 y=520..610
    body.append(band_caption(60, 510, "④ 外部系统 — Bilibili Web API（网络 I/O）", "#C0392B"))
    body.append(box(500, 520, 640, 100, "Bilibili Web API",
                    ["空间 acc/info · 粉丝 relation/stat · 投稿 arc/search · 动态 feed/space",
                     "动态详情 detail · 专栏 article/view · 视频 web-interface/view",
                     "认证 nav · cookie/refresh · cookie/info · qrcode/*"],
                    fill="#FDF0EF", stroke="#C0392B", tcolor="#7B241C", bsize=12))
    # ⑤ 核心支撑层 y=650..770
    body.append(band_caption(60, 640, "⑤ 核心支撑层 — 配置 / ORM / 仓储", "#8E44AD"))
    body.append(box(60, 650, 212, 120, "core/config.py", ["Settings 类\n.env 凭证\n调度/限流参数"], fill="#F5EEF8", stroke="#8E44AD", tcolor="#5B2C6F"))
    body.append(box(282, 650, 212, 120, "core/database.py", ["create_engine\nSessionLocal\nBase · get_db"], fill="#F5EEF8", stroke="#8E44AD", tcolor="#5B2C6F"))
    body.append(box(504, 650, 212, 120, "models/vtuber.py", ["VTuber\nAccount · Post\n三模型 + 约束"], fill="#F5EEF8", stroke="#8E44AD", tcolor="#5B2C6F"))
    body.append(box(726, 650, 212, 120, "schemas/vtuber.py", ["Pydantic v2\nOut/Create/Update\n响应序列化"], fill="#F5EEF8", stroke="#8E44AD", tcolor="#5B2C6F"))
    body.append(box(948, 650, 212, 120, "repositories/", ["VTuberRepo\nAccountRepo\nPostRepo CRUD"], fill="#F5EEF8", stroke="#8E44AD", tcolor="#5B2C6F"))
    # ⑥ 数据层 y=810..940
    body.append(band_caption(60, 800, "⑥ 数据层 — 本地持久化", "#B7950B"))
    body.append(box(60, 815, 270, 100, "SQLite — vtuber.db", ["vtubers(4) · accounts(4)\nposts(11,055)\nalembic_version=c002"], fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(box(345, 815, 270, 100, "static/avatars/ — 头像缓存", ["718 张本地头像\n{uid}.jpg|png\n经 /static 对外服务"], fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(box(630, 815, 270, 100, "logs/app.log — 运行日志", ["FileHandler + 控制台\n（v0.3.2 已修复：正常写入）"], fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(box(915, 815, 270, 100, "vtubers.csv — 名单源文件", ["9,482 行（4 个 flag=1）\n由发现脚本生成"], fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    # 箭头
    body.append(line(710, 106, 710, 148, marker="arr"))                       # A1 → API
    body.append(line(440, 76, 938, 76, marker="arr"))                          # 脚本 → vtbs.moe
    body.append(path("M1090,106 V110 H1240 V860 H1183", marker="arrG"))        # vtbs → CSV
    body.append(path("M620,274 V300 H600 V328", marker="arr"))                 # API → fetcher
    body.append(line(480, 390, 498, 390, marker="arr"))                        # scheduler → fetcher
    body.append(text(489, 382, "调用", size=11, fill="#5B6B7C", anchor="middle"))
    body.append(line(700, 400, 718, 400, marker="arr"))                        # fetcher → auth
    body.append(text(709, 392, "Cookie 头", size=11, fill="#5B6B7C", anchor="middle"))
    body.append(line(938, 420, 922, 420, dash="4 3", color="#8E44AD"))         # wbi ⇢ auth
    body.append(text(930, 412, "依赖", size=11, fill="#8E44AD", anchor="middle"))
    body.append(line(600, 470, 600, 518, marker="arr"))                        # fetcher → B站
    body.append(text(612, 500, "空间/粉丝/帖子接口", size=11, fill="#C0392B"))
    body.append(line(820, 470, 820, 518, marker="arr"))                        # auth → B站
    body.append(text(832, 500, "nav·refresh·qrcode", size=11, fill="#C0392B"))
    body.append(line(1040, 470, 1040, 518, marker="arr"))                      # wbi → B站
    body.append(text(1052, 500, "nav 取 WBI 密钥", size=11, fill="#C0392B"))
    body.append(path("M160,470 V648", marker="arr"))                           # importer → config/DB
    body.append(path("M300,470 V490 H300 V648", marker="arr"))                 # scheduler → database
    body.append(path("M380,470 V490 H36 V860 H343", marker="arrG2"))           # scheduler → avatars
    body.append(text(60, 846, "头像下载", size=11, fill="#2E9E5B"))
    body.append(path("M630,770 V790 H195 V813", marker="arr"))                 # 核心层 → SQLite
    body.append(text(350, 786, "ORM 读写", size=11, fill="#5B6B7C"))
    save("01_system_architecture.svg", svg(1280, 980, "".join(body)))


# ─────────────────────────────────────────────────────────────────────
# 图 2：数据模型 ER 图
# ─────────────────────────────────────────────────────────────────────
def table_box(x, y, w, title, rows, fill, stroke, tcolor, unique_note=None):
    parts = [rect(x, y, w, 40 + len(rows) * 20 + (28 if unique_note else 0), fill=fill, stroke=stroke)]
    parts.append(text(x + w / 2, y + 24, title, size=13.5, anchor="middle", fill=tcolor, weight=700))
    yy = y + 48
    for r in rows:
        parts.append(text(x + 14, yy, r, size=12, fill="#334155"))
        yy += 20
    if unique_note:
        parts.append(rect(x + 8, yy + 2, w - 16, 18, fill="#FEF5E7", stroke="#F0B429", sw=1))
        parts.append(text(x + w / 2, yy + 14.5, unique_note, size=11, anchor="middle", fill="#9C5A0B", weight=600))
    return "".join(parts), yy + (28 if unique_note else 8)


def d2():
    body = [text(60, 52, "SQLite 三表数据模型（SQLAlchemy ORM · 平台无关设计）", size=18, fill="#1F3A5F", weight=700)]
    body.append(text(60, 76, "posts 表刻意不带外键：以 (platform, platform_uid) 与 accounts 逻辑关联，联合投稿视频在每个 VTuber 下各存一份", size=12, fill="#5B6B7C"))
    tb1, _ = table_box(60, 110, 330, "vtubers — 虚拟主播本体",
                       ["id · INTEGER 主键 索引", "name · 名字（索引）", "birthday · 生日 MM-DD",
                        "debut_date · 出道日", "setting · 角色设定 TEXT", "avatar · 默认头像 URL",
                        "notes · 备注", "created_at · UTC", "updated_at · 自动更新"],
                       "#EAF2FB", "#2E86C1", "#1B4F8A")
    body.append(tb1)
    tb2, y2 = table_box(560, 96, 360, "accounts — 各平台账号",
                        ["id · INTEGER 主键", "vtuber_id · FK→vtubers.id（级联删除）", "platform · 平台名（bilibili…）",
                         "platform_uid · 平台侧 UID", "display_name · 平台昵称", "avatar_url · CDN 头像",
                         "avatar_path · 本地缓存路径", "sign · 签名", "url · 主页链接",
                         "followers_count · 粉丝数", "room_id · 直播间 ID", "live_status · 0 离线 / 1 直播",
                         "live_title · 直播标题", "live_url · 直播链接", "last_fetched_at · 上次抓取"],
                        "#EAF7EF", "#27AE60", "#1E6B3C",
                        unique_note="UNIQUE(platform, platform_uid)")
    body.append(tb2)
    tb3, _ = table_box(1050, 96, 300, "posts — 动态 / 投稿",
                       ["id · INTEGER 主键", "platform · 平台（索引）", "platform_uid · UID（索引）",
                        "platform_post_id · 帖子 ID", "type · video/image/article/…", "title · 标题",
                        "summary · 前 200 字", "cover_url · 封面", "permalink · 原始链接",
                        "body_json · 类型差异数据", "stats_json · 播放/赞/评论", "published_at · 发布时间",
                        "raw_json · 原始兜底", "is_archived · 归档标记", "created_at · UTC"],
                        "#F5EEF8", "#8E44AD", "#5B2C6F",
                        unique_note="UNIQUE(platform, uid, pid)")
    body.append(tb3)
    body.append(line(390, 250, 558, 250, marker="arr", color="#2F6FAD", sw=2))
    body.append(text(474, 240, "1 : N  accounts", size=12, anchor="middle", fill="#2F6FAD", weight=600))
    body.append(text(474, 272, "cascade=\"all, delete-orphan\"", size=11, anchor="middle", fill="#5B6B7C"))
    body.append(text(378, 265, "1", size=13, fill="#2F6FAD", weight=700))
    body.append(text(568, 265, "N", size=13, fill="#2F6FAD", weight=700))
    body.append(line(920, 270, 1048, 270, marker="arr", color="#8E44AD", sw=2, dash="6 4"))
    body.append(text(984, 260, "逻辑关联（无 FK）", size=12, anchor="middle", fill="#8E44AD", weight=600))
    body.append(text(984, 292, "platform + platform_uid 匹配", size=11, anchor="middle", fill="#5B6B7C"))
    note_y = max(y2, 96 + 40 + 15 * 20 + 28) + 30
    body.append(rect(60, note_y, 1290, 64, fill="#FDFAF3", stroke="#D0C9B0"))
    body.append(text(80, note_y + 24, "去重策略：", size=12.5, fill="#7D6608", weight=700))
    body.append(text(200, note_y + 24, "accounts 按 (platform, platform_uid) 唯一 —— 一个主播在同一平台只有一个账号；", size=12, fill="#4A4A4A"))
    body.append(text(80, note_y + 46, "posts 按 (platform, platform_uid, platform_post_id) 唯一 —— 同一帖子在单个账号下只存一条；SQLite 改约束需重建表（迁移 c002）。", size=12, fill="#4A4A4A"))
    save("02_er_diagram.svg", svg(1400, note_y + 90, "".join(body)))


# ─────────────────────────────────────────────────────────────────────
# 图 3：应用启动与生命周期（lifespan）
# ─────────────────────────────────────────────────────────────────────
def step3(x, y, w, h, title, lines=None, fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A", hlines=None):
    return box(x, y, w, h, title, lines, fill=fill, stroke=stroke, tcolor=tcolor)


def d3():
    body = [text(60, 44, "FastAPI lifespan 生命周期（app/main.py）", size=18, fill="#1F3A5F", weight=700)]
    x, w = 180, 560
    ys = [70, 128, 186, 244, 302, 360, 418, 476]
    steps = [
        ("uvicorn 启动 · app.main:app", ["模块加载：路由 / CORS / 静态目录注册"], "#FDF2E9", "#E67E22", "#9C4A0B"),
        ("logging.basicConfig — 双通道日志", ["FileHandler(logs/app.log) + StreamHandler"], "#FDF2E9", "#E67E22", "#9C4A0B"),
        ("Base.metadata.create_all(engine)", ["按 ORM 模型自动建表（与 Alembic 双轨并存）"], "#EAF2FB", "#2E86C1", "#1B4F8A"),
        ("import_from_file() — CSV 导入", ["读 vtubers.csv · flag=1 行 · 按 (platform,uid) 去重"], "#EAF2FB", "#2E86C1", "#1B4F8A"),
        ("start_scheduler() — 定时任务", ["APScheduler BackgroundScheduler · 每 5 分钟 ±30s · max_instances=1"], "#EAF7EF", "#27AE60", "#1E6B3C"),
        ("auth_task = create_task(run_maintenance())", ["B 站登录态维护循环 · 每 30 分钟一次（后台 asyncio 任务）"], "#EAF7EF", "#27AE60", "#1E6B3C"),
        ("新增 VTuber > 0 ？", ["新名单 → 5 秒后自动触发一次全量抓取"], "#FEF9E7", "#B7950B", "#7D6608"),
        ("yield — 服务就绪", ["Web 服务 + 定时抓取 + 认证循环三者并行"], "#F5EEF8", "#8E44AD", "#5B2C6F"),
    ]
    for i, (t, lines, f, s, tc) in enumerate(steps):
        body.append(step3(x, ys[i], w, 52, t, None, f, s, tc))
        if lines:
            body.append(text(x + 14, ys[i] + 34, lines[0], size=11, fill="#5B6B7C"))
    # 右分支：延迟抓取
    body.append(box(830, 418, 330, 52, "_delayed_fetch(5s)", ["asyncio.sleep(5) → async_fetch_and_update()"], fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(text(1000, 496, "yes", size=12, fill="#7D6608", weight=700))
    body.append(text(530, 496, "no", size=12, fill="#7D6608", weight=700))
    # 关停阶段
    y2 = [534, 592, 650, 708]
    steps2 = [
        ("收到关闭信号 → lifespan 恢复执行", None, "#FDF0EF", "#C0392B", "#7B241C"),
        ("auth_task.cancel() — 停止认证维护循环", None, "#FDF0EF", "#C0392B", "#7B241C"),
        ("shutdown_scheduler() — 安全关闭 APScheduler", ["wait=False · 防止挂起任务阻塞退出"], "#FDF0EF", "#C0392B", "#7B241C"),
        ("进程退出 · 数据库连接释放", None, "#FDF0EF", "#C0392B", "#7B241C"),
    ]
    for i, (t, lines, f, s, tc) in enumerate(steps2):
        body.append(step3(x, y2[i], w, 52, t, None, f, s, tc))
        if lines:
            body.append(text(x + 14, y2[i] + 34, lines[0], size=11, fill="#5B6B7C"))
    # 箭头
    for i in range(7):
        body.append(line(460, ys[i] + 52, 460, ys[i + 1], marker="arr"))
    body.append(line(740, 444, 828, 444, marker="arr"))
    body.append(path("M830,444 V506 H460 V532", marker="arr"))
    body.append(line(460, 528, 460, 534, marker="arr"))
    for i in range(3):
        body.append(line(460, y2[i] + 52, 460, y2[i + 1], marker="arr"))
    # 侧注
    body.append(rect(40, 244, 120, 160, fill="#FFF", stroke="#D0C9B0", dash="4 3"))
    body.append(text(52, 270, "同步阻塞", size=11, fill="#7D6608", weight=700))
    body.append(text(52, 288, "建表 + 导入", size=11, fill="#7D6608"))
    body.append(text(52, 306, "在事件循环", size=11, fill="#7D6608"))
    body.append(text(52, 324, "内同步执行", size=11, fill="#7D6608"))
    body.append(text(52, 342, "（SQLite 本地", size=11, fill="#7D6608"))
    body.append(text(52, 360, "开销小）", size=11, fill="#7D6608"))
    body.append(line(160, 300, 178, 300, marker="arrG", dash="4 3"))
    body.append(rect(830, 560, 330, 96, fill="#FFF", stroke="#D0C9B0", dash="4 3"))
    body.append(text(848, 582, "常驻后台活动 × 3：", size=11, fill="#5B2C6F", weight=700))
    body.append(text(848, 600, "① Web 请求处理（uvicorn）", size=11, fill="#5B2C6F"))
    body.append(text(848, 618, "② APScheduler 抓取线程", size=11, fill="#5B2C6F"))
    body.append(text(848, 636, "③ Auth 维护 asyncio 任务", size=11, fill="#5B2C6F"))
    body.append(line(830, 590, 742, 590, marker="arrG", dash="4 3"))
    save("03_lifespan.svg", svg(1180, 800, "".join(body)))


# ─────────────────────────────────────────────────────────────────────
# 图 4：定时抓取与风控流程
# ─────────────────────────────────────────────────────────────────────
def d4():
    body = [text(120, 44, "定时抓取流程 — scheduler.async_fetch_and_update()（风控自愈）", size=18, fill="#1F3A5F", weight=700)]
    cx = 400  # 主列中心
    body.append(box(140, 70, 520, 56, "APScheduler 触发 — 每 5 分钟 ±30s 抖动", ["BackgroundScheduler · job id=fetch_vtubers · max_instances=1"], fill="#FDF2E9", stroke="#E67E22", tcolor="#9C4A0B"))
    body.append(line(cx, 126, cx, 154, marker="arr"))
    body.append(box(140, 154, 520, 52, "fetch_and_update_vtubers()", ["同步包装函数 → asyncio.run() 桥接进事件循环"], fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    body.append(line(cx, 206, cx, 234, marker="arr"))
    body.append(box(200, 234, 400, 52, "尝试获取 _fetch_lock（非阻塞）？", None, fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(text(608, 260, "失败", size=12, fill="#C0392B", weight=700))
    body.append(text(cx, 262, "成功", size=12, fill="#2E9E5B", weight=700))
    body.append(box(60, 234, 130, 64, "本次触发结束", ["防重叠：", "返回 skipped"], fill="#FDF0EF", stroke="#C0392B", tcolor="#7B241C"))
    body.append(line(200, 266, 192, 266, marker="arr"))
    body.append(line(cx, 286, cx, 314, marker="arr"))
    body.append(box(140, 314, 520, 52, "读取全部 Account（platform_uid 非空）", ["SessionLocal() 独立会话 · 供循环遍历"], fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    # 循环框
    loop_x, loop_y, loop_w, loop_h = 100, 390, 620, 480
    body.append(rect(loop_x, loop_y, loop_w, loop_h, fill="#FBFDFB", stroke="#7FB3D5", dash="6 4"))
    body.append(text(loop_x + 14, loop_y + 22, "for 循环 · 每个 Account（idx / batch_count 计数）", size=12, fill="#2E86C1", weight=700))
    body.append(line(cx, 366, cx, 388, marker="arr"))
    body.append(box(140, 402, 520, 52, "① fetch_bilibili_user_info(mid)", ["WBI 签名 · tenacity 重试≤3 · 昵称/签名/头像/直播状态"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(line(cx, 454, cx, 482, marker="arr"))
    body.append(box(140, 482, 520, 52, "② 头像 URL 变化？→ _download_avatar()", ["异步下载到 static/avatars/{uid}.jpg · 失败仅 warning"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(line(cx, 534, cx, 562, marker="arr"))
    body.append(box(200, 562, 400, 52, "③ was_rate_limited() ？", None, fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(text(608, 588, "触发", size=12, fill="#C0392B", weight=700))
    body.append(text(cx, 588, "正常", size=12, fill="#2E9E5B", weight=700))
    body.append(line(cx, 614, cx, 642, marker="arr"))
    body.append(box(140, 642, 520, 52, "④ fetch_bilibili_user_stat(mid)", ["粉丝数/关注数 · 同样带重试与风控检测"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(line(cx, 694, cx, 722, marker="arr"))
    body.append(box(200, 722, 400, 52, "⑤ was_rate_limited() ？", None, fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(text(608, 748, "触发", size=12, fill="#C0392B", weight=700))
    body.append(text(cx, 748, "正常", size=12, fill="#2E9E5B", weight=700))
    body.append(line(cx, 774, cx, 802, marker="arr"))
    body.append(box(140, 802, 520, 52, "⑥ 随机等待 3~5s → db.commit() → 计数", ["batch_count ≥ 10 → 额外休息 60s"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    # 风控分支（右侧）
    body.append(box(760, 570, 300, 190, "风控分支（自愈）", [
        "HTTP 412 / code -509,-412,-799 / 含\"频繁\"",
        "① commit 已更新数据 · close()",
        "② clear_rate_limit()",
        "③ await sleep(600s) 冷却",
        "④ 重建 Session · 重读 accounts",
        "⑤ continue — 从原 idx 继续"],
        fill="#FDF0EF", stroke="#C0392B", tcolor="#7B241C"))
    body.append(line(600, 588, 758, 630, marker="arr"))
    body.append(line(600, 748, 758, 700, marker="arr"))
    body.append(path("M910,760 V856 H480 V868", marker="arrG", dash="5 4"))
    body.append(text(640, 848, "冷却结束 → 回到循环（idx 不变）", size=11, fill="#C0392B"))
    # 循环出口
    body.append(line(cx, 870, cx, 908, marker="arr"))
    body.append(box(140, 908, 520, 62, "遍历完成 — 汇总返回", ["FetchResult{success, failed, skipped, details} · 释放锁 · is_fetch_running=False"], fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    body.append(line(cx, 970, cx, 998, marker="arr"))
    body.append(box(200, 998, 400, 52, "定时任务结束 / 手动触发响应返回", None, fill="#FDF2E9", stroke="#E67E22", tcolor="#9C4A0B"))
    save("04_fetch_flow.svg", svg(1120, 1085, "".join(body)))


# ─────────────────────────────────────────────────────────────────────
# 图 5：帖子抓取链路
# ─────────────────────────────────────────────────────────────────────
def d5():
    body = [text(120, 42, "帖子抓取链路 — scheduler.async_fetch_posts() / async_fetch_all_posts()", size=18, fill="#1F3A5F", weight=700)]
    body.append(box(120, 62, 1000, 52, "入口：POST /vtuber/fetch-posts（按名字模糊匹配 · video_pages / dynamics_pages，-1=全量）｜ POST /vtuber/fetch-all-posts",
                    None, fill="#FDF2E9", stroke="#E67E22", tcolor="#9C4A0B"))
    body.append(line(620, 114, 620, 142, marker="arr"))
    body.append(box(320, 142, 600, 52, "_fetch_posts_core(mid, video_pages, dynamics_pages)", ["_post_fetch_lock 防并发 · 独立 Session · PostFetchResult 汇总"], fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    body.append(line(620, 194, 620, 222, marker="arr"))
    body.append(box(320, 222, 600, 52, "预读 existing_ids — 本账号已存 platform_post_id 集合", ["内存去重 · 命中即 skipped，不发起详情请求"], fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    # 左列：视频
    body.append(line(420, 274, 240, 300, marker="arr"))
    body.append(line(1020, 274, 1020, 300, marker="arr"))
    body.append(box(80, 300, 400, 90, "视频投稿分支", ["fetch_bilibili_videos(mid, page)",
        "/x/space/wbi/arc/search · WBI 签名",
        "ps=30 · order=pubdate · 映射为 type=video"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(box(820, 300, 400, 90, "动态分支", ["fetch_bilibili_dynamics(mid, offset)",
        "/x/polymer/web-dynamic/v1/feed/space",
        "major.type: OPUS/DRAW/ARTICLE/ARCHIVE/LIVE/COMMON"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(path("M80,480 V344", marker="arrG2", dash="4 3"))
    body.append(text(96, 412, "page += 1 · 空页即止", size=11, fill="#2E9E5B"))
    body.append(path("M1220,480 V344", marker="arrG2", dash="4 3"))
    body.append(text(1036, 412, "offset = next_offset · has_more=false", size=11, fill="#2E9E5B"))
    body.append(line(280, 390, 280, 452, marker="arr"))
    body.append(box(80, 452, 400, 56, "逐条映射 → Post 行（去重判断前置）", ["bvid→permalink · play/comment→stats_json"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(line(1020, 390, 1020, 452, marker="arr"))
    body.append(box(820, 452, 400, 56, "逐条映射 → Post 行（六类动态 → type）", ["文字/多图/专栏/视频/转发/直播"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(line(280, 508, 340, 560, marker="arr"))
    body.append(line(1020, 508, 862, 560, marker="arr"))
    # 决策
    body.append(box(320, 560, 560, 56, "platform_post_id ∈ existing_ids ？", None, fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(text(302, 578, "是", size=13, fill="#C0392B", weight=700))
    body.append(text(612, 634, "否", size=13, fill="#2E9E5B", weight=700))
    body.append(box(80, 560, 200, 56, "skipped += 1", ["已存在，跳过"], fill="#FDF0EF", stroke="#C0392B", tcolor="#7B241C"))
    body.append(line(318, 588, 282, 588, marker="arr"))
    body.append(line(600, 616, 600, 648, marker="arr"))
    # 富化
    body.append(box(280, 648, 680, 150, "类型化详情补全（feed → 完整数据）", [
        "text / image → fetch_dynamic_detail() — OPUS 格式完整数据（正文/图片/统计）",
        "article → fetch_article_detail(cv_id) — 专栏全文 HTML + 阅读统计",
        "video（动态内视频）→ fetch_video_detail(bvid) — 完整简介 · 分P · 播放/弹幕统计",
        "每次详情调用后随机 sleep 0.5~2s · 详情失败 → warning + 回退 feed 数据"],
        fill="#F5EEF8", stroke="#8E44AD", tcolor="#5B2C6F"))
    body.append(line(600, 798, 600, 826, marker="arr"))
    body.append(box(280, 826, 680, 72, "_safe_store_post() — 落库", [
        "PostRepo.create · IntegrityError（唯一约束兜底）→ rollback 跳过",
        "db.commit() · 汇总 stored / skipped · PostFetchResult{videos, dynamics, stored, skipped, rate_limited}"],
        fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    body.append(line(600, 898, 600, 926, marker="arr"))
    body.append(box(320, 926, 560, 52, "返回汇总 → /fetch-posts 汇总到 total ｜ /fetch-all-posts 逐个账号全量拉取", None, fill="#FDF2E9", stroke="#E67E22", tcolor="#9C4A0B"))
    # 风控注记 + 节奏注记（右侧，避开右列）
    body.append(rect(1240, 300, 100, 110, fill="#FFF", stroke="#D0C9B0", dash="4 3"))
    body.append(text(1252, 324, "节奏：", size=11.5, fill="#7D6608", weight=700))
    body.append(text(1252, 344, "视频页后", size=11, fill="#7D6608"))
    body.append(text(1252, 362, "sleep 1s", size=11, fill="#7D6608"))
    body.append(text(1252, 380, "动态页后", size=11, fill="#7D6608"))
    body.append(text(1252, 398, "sleep 20s", size=11, fill="#7D6608"))
    body.append(line(1220, 340, 1238, 340, marker="arrG", dash="4 3"))
    body.append(rect(1240, 560, 100, 130, fill="#FFF", stroke="#D0C9B0", dash="4 3"))
    body.append(text(1252, 584, "风控：", size=11.5, fill="#C0392B", weight=700))
    body.append(text(1252, 604, "任一列表", size=11, fill="#C0392B"))
    body.append(text(1252, 622, "调用触发", size=11, fill="#C0392B"))
    body.append(text(1252, 640, "→ 中断", size=11, fill="#C0392B"))
    body.append(text(1252, 658, "→ 上报", size=11, fill="#C0392B"))
    body.append(text(1252, 676, "→ 冷却", size=11, fill="#C0392B"))
    body.append(path("M1220,480 H1240 V600", marker="arrG", dash="4 3"))
    save("05_post_fetch_flow.svg", svg(1380, 1010, "".join(body)))


# ─────────────────────────────────────────────────────────────────────
# 图 6：认证维护状态机
# ─────────────────────────────────────────────────────────────────────
def d6():
    body = [text(120, 44, "B 站登录态维护 — auth.BilibiliAuth.run_maintenance()（30 分钟循环）", size=18, fill="#1F3A5F", weight=700)]
    body.append(box(320, 70, 560, 52, "维护循环启动（lifespan 创建的后台 asyncio 任务）", None, fill="#FDF2E9", stroke="#E67E22", tcolor="#9C4A0B"))
    body.append(line(600, 122, 600, 150, marker="arr"))
    body.append(box(160, 150, 440, 56, "阶段 1 · check_session()", ["GET /x/web-interface/nav → isLogin 校验"], fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    body.append(line(600, 206, 600, 234, marker="arr"))
    body.append(box(260, 234, 240, 52, "会话有效？", None, fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(text(508, 260, "是", size=13, fill="#2E9E5B", weight=700))
    body.append(text(600, 260, "否", size=13, fill="#C0392B", weight=700))
    body.append(box(680, 176, 440, 52, "顺手刷新 refresh_token", ["GET /x/passport-login/web/cookie/info"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(line(500, 200, 678, 200, marker="arr"))
    body.append(line(600, 286, 600, 314, marker="arr"))
    body.append(box(160, 314, 440, 56, "阶段 2 · try_refresh()", ["POST /x/passport-login/web/cookie/refresh（csrf + refresh_token）"], fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    body.append(line(600, 370, 600, 398, marker="arr"))
    body.append(box(260, 398, 240, 52, "续期成功？", None, fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(text(508, 424, "是", size=13, fill="#2E9E5B", weight=700))
    body.append(text(600, 424, "否", size=13, fill="#C0392B", weight=700))
    body.append(box(680, 340, 440, 52, "解析 Set-Cookie → 更新内存 + 写回 .env", ["新 SESSDATA / bili_jct / refresh_token"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(line(500, 366, 678, 366, marker="arr"))
    body.append(line(600, 450, 600, 478, marker="arr"))
    body.append(box(160, 478, 440, 72, "阶段 3 · qr_login() — 扫码兜底", ["生成二维码（终端 ASCII 打印）→ poll 每 2s 轮询",
        "最长 3 分钟 · 状态：等待/已扫/过期(86038)/成功(code=0)"], fill="#EAF2FB", stroke="#2E86C1", tcolor="#1B4F8A"))
    body.append(line(600, 550, 600, 578, marker="arr"))
    body.append(box(260, 578, 240, 52, "登录成功？", None, fill="#FEF9E7", stroke="#B7950B", tcolor="#7D6608"))
    body.append(text(508, 604, "是", size=13, fill="#2E9E5B", weight=700))
    body.append(text(600, 604, "否", size=13, fill="#C0392B", weight=700))
    body.append(box(680, 520, 440, 56, "回调 data.url 种 Cookie → nav 验证", ["提取 SESSDATA / bili_jct / uid → 写 .env"], fill="#EAF7EF", stroke="#27AE60", tcolor="#1E6B3C"))
    body.append(line(500, 548, 678, 548, marker="arr"))
    body.append(box(680, 596, 440, 52, "全部失败", ["30 分钟后重试"], fill="#FDF0EF", stroke="#C0392B", tcolor="#7B241C"))
    body.append(line(500, 622, 678, 622, marker="arr"))
    # 汇总到睡眠
    body.append(box(400, 690, 400, 52, "await asyncio.sleep(1800)", ["30 分钟后进入下一轮"], fill="#F5EEF8", stroke="#8E44AD", tcolor="#5B2C6F"))
    body.append(path("M900,228 H1130 V676 H700 V688", marker="arr"))
    body.append(path("M900,392 H1130 V676 H700 V688", marker="arr"))
    body.append(path("M900,576 H1130 V676 H700 V688", marker="arr"))
    body.append(path("M900,648 H1130 V676 H700 V688", marker="arr"))
    body.append(path("M600,742 V772 H620 V122", marker="arr"))
    # WBI 注记（右下角空白区）
    body.append(rect(1010, 700, 140, 100, fill="#FFF", stroke="#D0C9B0", dash="4 3"))
    body.append(text(1024, 724, "登录成功附带：", size=11, fill="#8E44AD", weight=700))
    body.append(text(1024, 742, "清除 WBI 密钥", size=11, fill="#8E44AD"))
    body.append(text(1024, 760, "缓存（登录态", size=11, fill="#8E44AD"))
    body.append(text(1024, 778, "变化 → 强制", size=11, fill="#8E44AD"))
    body.append(text(1024, 796, "换新密钥）", size=11, fill="#8E44AD"))
    body.append(path("M1120,548 H1160 V750 H1012", marker="arrG", dash="4 3"))
    save("06_auth_flow.svg", svg(1180, 810, "".join(body)))


# ─────────────────────────────────────────────────────────────────────
# 图 7：手动抓取时序图
# ─────────────────────────────────────────────────────────────────────
def d7():
    body = []
    names = [("客户端", 160, "#C05621", "#FDF2E9"), ("Router", 380, "#2F6FAD", "#EAF2FB"),
             ("scheduler", 620, "#2E9E5B", "#EAF7EF"), ("fetcher", 860, "#2E9E5B", "#EAF7EF"),
             ("B 站 API", 1120, "#C0392B", "#FDF0EF"), ("SQLite", 1340, "#B7950B", "#FEF9E7")]
    for name, cx, sc, fc in names:
        body.append(rect(cx - 85, 30, 170, 52, fill=fc, stroke=sc, sw=1.5))
        body.append(text(cx, 61, name, size=13, anchor="middle", fill="#1F2937", weight=700))
        body.append(line(cx, 82, cx, 730, color="#B8C2CC", dash="5 4", sw=1.2))
    msg = [
        (160, 380, 130, "POST /vtuber/fetch", "#C05621", False),
        (380, 620, 180, "is_fetch_running() → false", "#2F6FAD", False),
        (380, 620, 230, "await async_fetch_and_update()", "#2F6FAD", False),
        (620, 860, 300, "fetch_bilibili_user_info(mid) · tenacity 重试≤3", "#2E9E5B", False),
        (860, 1120, 350, "GET /x/space/wbi/acc/info（WBI 签名）", "#C0392B", False),
        (1120, 860, 400, "name / sign / face / live_room", "#8A8A8A", True),
        (620, 860, 455, "fetch_bilibili_user_stat(mid)", "#2E9E5B", False),
        (860, 1120, 505, "GET /x/relation/stat?vmid=mid", "#C0392B", False),
        (1120, 860, 555, "follower / following", "#8A8A8A", True),
        (620, 1340, 615, "更新 account 字段（头像变更 → 下载缓存）", "#B7950B", False),
        (620, 1340, 655, "commit()", "#B7950B", False),
        (620, 380, 700, "FetchResult{success, failed, skipped, details}", "#8A8A8A", True),
        (380, 160, 745, "200 {status:'done', message, result}", "#8A8A8A", True),
    ]
    for x1, x2, y, label, color, dashed in msg:
        body.append(line(x1, y, x2, y, color=color, dash="6 4" if dashed else None, marker=None if dashed else "arr"))
        body.append(text((x1 + x2) / 2, y - 6, label, size=11.5, anchor="middle", fill=color, weight=600 if not dashed else 400))
    # 循环框
    body.append(rect(600, 268, 560, 300, fill="none", stroke="#2E9E5B", dash="6 4", sw=1.4))
    body.append(text(614, 290, "循环：每个 Account · 请求间隔 3~5s · 每 10 个休息 60s · 风控冷却 600s 后自愈", size=11.5, fill="#2E9E5B", weight=700))
    save("07_sequence.svg", svg(1480, 780, "".join(body)))


# ─────────────────────────────────────────────────────────────────────
# 图 8：版本演进时间线
# ─────────────────────────────────────────────────────────────────────
def d8():
    body = [text(60, 44, "版本演进时间线（2026-08-04 → 2026-08-06 · devlog 001~012）", size=18, fill="#1F3A5F", weight=700)]
    body.append(text(60, 76, "三天内 12 个版本：单表 Demo → 带认证/风控的后端 → 三表多平台架构", size=12.5, fill="#5B6B7C"))
    ver = [
        ("v0.1.0", "08-04", "项目初始化", "单表+WBI+定时", "#2E86C1"),
        ("v0.1.1", "08-04", "问题修复", "配置/日志/测试", "#2E86C1"),
        ("v0.1.2", "08-04", "Cookie 续期", "+ 扫码登录", "#2E86C1"),
        ("v0.1.3", "08-04", "手动触发抓取", "/vtuber/fetch", "#2E86C1"),
        ("v0.1.4", "08-04", "移除 Flet", "专注后端 API", "#2E86C1"),
        ("v0.2.0", "08-04", "扩展字段", "变动/稳定策略", "#E67E22"),
        ("v0.2.1", "08-04", "文件导入", "vtubers.txt 去重", "#E67E22"),
        ("v0.2.2", "08-04", "头像持久化", "本地缓存", "#E67E22"),
        ("v0.2.3", "08-04", "直播区发现", "（后移除）", "#E67E22"),
        ("v0.2.4", "08-04", "拆分发现脚本", "精简服务器", "#E67E22"),
        ("v0.3.0", "08-05", "三表重构", "vtubers/accounts/posts", "#27AE60"),
        ("v0.3.1", "08-06", "帖子链路优化", "详情/全量/归档", "#27AE60"),
    ]
    y_line = 320
    n = len(ver)
    xs = [70 + i * 100 for i in range(n)]
    body.append(line(70, y_line, xs[-1] + 10, y_line, color="#9AA5B1", sw=2))
    for i, (v, d, s1, s2, c) in enumerate(ver):
        x = xs[i]
        above = i % 2 == 0
        body.append(f'<circle cx="{x}" cy="{y_line}" r="7" fill="{c}" stroke="#FFFFFF" stroke-width="2"/>')
        body.append(text(x, y_line + 24, v, size=13.5, anchor="middle", fill=c, weight=700))
        body.append(text(x, y_line + 42, d, size=10.5, anchor="middle", fill="#8A8A8A"))
        if above:
            body.append(text(x, y_line - 34, s1, size=11.5, anchor="middle", fill="#334155", weight=600))
            body.append(text(x, y_line - 18, s2, size=11.5, anchor="middle", fill="#5B6B7C"))
            body.append(line(x, y_line - 12, x, y_line - 7, color=c, sw=1.4))
        else:
            body.append(text(x, y_line + 64, s1, size=11.5, anchor="middle", fill="#334155", weight=600))
            body.append(text(x, y_line + 80, s2, size=11.5, anchor="middle", fill="#5B6B7C"))
            body.append(line(x, y_line + 7, x, y_line + 52, color=c, sw=1.4))
    # 图例
    body.append(rect(70, 430, 1140, 52, fill="#FBFDFB", stroke="#D0C9B0"))
    body.append(text(90, 462, "阶段划分：", size=12, fill="#1F2937", weight=700))
    body.append(text(190, 462, "v0.1.x 基础搭建（FastAPI + WBI + 定时 + 认证 + 手动触发）　·　v0.2.x 数据增强（字段/导入/头像/发现脚本）　·　v0.3.x 三表重构（多平台 + 帖子抓取链路）", size=12, fill="#4A4A4A"))
    save("08_evolution_timeline.svg", svg(1260, 520, "".join(body)))


if __name__ == "__main__":
    d1(); d2(); d3(); d4(); d5(); d6(); d7(); d8()
    print("done")
