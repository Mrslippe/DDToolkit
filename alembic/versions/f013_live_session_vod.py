"""手动记录的场次 + 录播地址（B2）— 需求 2 / 2.1（v1.2.x）

Revision ID: f013
Revises: f012
Create Date: 2026-10-08

用户口径（2026-10-08）：「日历上能手动补一场（时间/标题），并且给场次存**录播地址**」
（需求 2 + 2.1；2.2 弹幕录制 / 2.3 自研播放器是后续批次，不在本迁移里）。

新增：
- live_sessions.vod_url  TEXT NULL —— 场次的录播地址，**唯一入库形态**
  `https://www.bilibili.com/video/<BV号>[?p=N]`（规范化在 `app/domain/live_manual.py`：
  裸 BV 号 / 带参数的分享链接 / 移动端域名都收敛到这一种；`b23.tv` 短链与 http 明确拒绝
  —— 壳的外链白名单只放行 https + 精确主机，**存下来就要点得开**）。

为什么**不新增列**表示"这一场是手动记的"：
`live_sessions.source` 已经是「这一行谁写的」那一列（`danmakus`/`feed`/`self`），
手动记录就是它的第四个取值 `manual`（合并后为 `feed+manual` 这样的组合串，
判据见 `app/domain/live_manual.py::is_manual_source`）。
再加一个 `is_manual` 布尔列会出现**两个真相**：`source` 说 danmakus、布尔说手动时谁对？
（同 `f012` 不在 `background_focus` 里塞嵌套 JSON 的理由：一个东西一列，语义不叠。）

⚠️ `vod_url` **不参与多源合并的字段覆盖**：`LiveSessionRepo._row_dict` 把它带进合并组，
但 `_apply_group_merge`/`_merge_row_into_group` 的低优补缺不碰它 —— 手动填的地址
不该被一次 danmakus 回填冲掉（`_upsert` 只写它拿到的键，天然不会写 `vod_url`）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f013'
down_revision: Union[str, Sequence[str], None] = 'f012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('live_sessions', sa.Column('vod_url', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('live_sessions') as batch:
        batch.drop_column('vod_url')
