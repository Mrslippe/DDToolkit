"""vtubers 背景**视频**的取景 — 需求 9 的补丁（v1.2.0）

Revision ID: f012
Revises: f011
Create Date: 2026-10-07

用户口径（2026-10-07）：「视频的取景和图片的取景**分开**，用一个按钮切换，预览用视频首帧」。

为什么**另开一列**而不是把 `background_focus` 改成嵌套 JSON：
- 嵌套（`{"image":…,"video":…}`）会让**已经存下来的**那批值突然换个读法 ——
  旧值是 `{"x","y","scale"}`，新代码得靠"有没有顶层 x"来猜它是谁的，猜错就是静默换构图；
- 而"一个东西一列"在本表已有先例：`background_path` / `background_video_path` 就是这么分的
  （`f011`），取景跟着这个形状走，契约与文档都不用写"兼容分支"。

新增：
- vtubers.background_video_focus  TEXT NULL —— **视频**的取景，JSON `{"x":0..1,"y":0..1,"scale":1..3}`，
  形状与 `background_focus`（图片那份）**逐字相同**，语义也一样（图片锚点，见 `devlog/420`）。
  NULL = 视频原样铺。⚠️ 两份**互不相干**：清视频的取景不许碰图片那份，反之亦然。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f012'
down_revision: Union[str, Sequence[str], None] = 'f011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('background_video_focus', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('vtubers') as batch:
        batch.drop_column('background_video_focus')
