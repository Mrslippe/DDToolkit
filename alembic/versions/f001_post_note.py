"""posts.note — 「投稿动态」附言合并到投稿帖（P9-3，v0.9.6）

Revision ID: f001
Revises: e007
Create Date: 2026-09-10

背景：B 站同一条视频有两个来源 —— `arc/search` 投稿列表（type=video，
platform_post_id=bvid）与动态流里的投稿动态（type=video_dynamic，
platform_post_id=动态 id，body_json.bvid 指向同一 bvid）。本地实测 322 个 bvid
同时存在两条记录，列表里同一条视频出现两次。

合并口径（2026-09-10 用户定案）：**只保留 video 一条**，动态里的附言文本
（body_json.text，实测 369 条动态里 47 条有附言）写进 `posts.note`；
抓取侧遇到「bvid 已作为 video 入库」就不再插入 video_dynamic，
历史数据由 `scripts/merge_video_dynamics.py` 一次性归并。

编号说明：P8/P9 计划表里曾把本迁移写作 f002、把 accounts 排序/锁定写作 f001，
但 alembic 链是线性的、必须按**实际实施顺序**编号（本批先落地）——因此本迁移取
f001，P8-B 的 accounts.sort_order + locked_fields 顺延为 f002、P9-B 的 app_meta 为 f003。

新增：
- posts.note  Text NULL
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f001'
down_revision: Union[str, Sequence[str], None] = 'e007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('posts', sa.Column('note', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('posts') as batch:
        batch.drop_column('note')
