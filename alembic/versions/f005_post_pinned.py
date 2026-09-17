"""置顶动态（R35，用户 2026-09-17 口径）

Revision ID: f005
Revises: f004
Create Date: 2026-09-17

用户原话：「有些 v 会将动态置顶来展示周表或舰礼相关的内容，所以将抓取到的置顶动态
同样置顶，并且每日的动态轮询都覆盖它，保证修改及时被捕捉到」。

背景：置顶帖在抓取侧**一直被特殊对待**（不参与增量停止判定，见 ARCHITECTURE §6.12 /
devlog/045），但只活在单轮内存里 —— `pinned_ids` 用完即弃，库里没有任何痕迹：

1. 列表里置顶帖按 `published_at` 混在时间线中，与上游展示顺序不一致；
2. 更严重的是**内容永远不会更新**：`_safe_store_post` 对唯一约束冲突只
   rollback + 跳过（不更新），作者改周表/舰礼图之后，库里还是首次抓到的版本。

本迁移落两个字段：

- `posts.is_pinned`            Boolean NOT NULL DEFAULT 0 —— 当前是否置顶
- `posts.pinned_refreshed_at`  DateTime NULL —— 置顶帖最近一次走详情接口刷正文的时刻
  （刷新节流用，窗口见 `settings.PINNED_DETAIL_REFRESH_HOURS`）

外加索引 `ix_posts_platform_uid_pinned`：列表热路径
`WHERE platform=? AND platform_uid=? ORDER BY is_pinned DESC, published_at DESC`。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f005'
down_revision: Union[str, Sequence[str], None] = 'f004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('posts', sa.Column('is_pinned', sa.Boolean(), nullable=False,
                                     server_default='0'))
    op.add_column('posts', sa.Column('pinned_refreshed_at', sa.DateTime(),
                                     nullable=True))
    op.create_index('ix_posts_platform_uid_pinned', 'posts',
                    ['platform', 'platform_uid', 'is_pinned'])


def downgrade() -> None:
    op.drop_index('ix_posts_platform_uid_pinned', table_name='posts')
    with op.batch_alter_table('posts') as batch:
        batch.drop_column('pinned_refreshed_at')
        batch.drop_column('is_pinned')
