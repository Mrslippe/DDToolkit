"""post tombstone — 删除检测（墓碑机制，v0.5.1）

Revision ID: e002
Revises: e001
Create Date: 2026-09-05

背景：动态从平台消失后，库里只是"数据不再更新"，没有任何标记证明它被删了、
何时发现被删。争议取证时无法区分"还在只是没翻到"和"已被删除"。

新增：
- posts.last_seen_at         最近一次确认仍在线的时间（每次扫描把「本轮所见」批量刷新）
- posts.deleted_detected_at  墓碑：连续两次缺席判定的删除时刻
- accounts.posts_last_scan_at 帖子扫描上一轮完成时间（两击判定的比较基准）
- ix_posts_deleted_detected  墓碑筛选索引

一次性回填：已入库的未归档帖 last_seen_at = 迁移时刻（读作为"上线即存活"
基线；真正已删的旧帖将在迁移后两轮缺席中被墓碑标记——两击规则依然成立）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e002'
down_revision: Union[str, Sequence[str], None] = 'e001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('posts', sa.Column('last_seen_at', sa.DateTime(), nullable=True))
    op.add_column('posts', sa.Column('deleted_detected_at', sa.DateTime(), nullable=True))
    op.add_column('accounts', sa.Column('posts_last_scan_at', sa.DateTime(), nullable=True))
    op.create_index('ix_posts_deleted_detected', 'posts', ['deleted_detected_at'])
    # 回填基线：未归档帖视作「迁移时刻仍存活」
    # （SQLite CURRENT_TIMESTAMP 即 UTC，与库内 naive-UTC 约定一致）
    op.execute(
        "UPDATE posts SET last_seen_at = CURRENT_TIMESTAMP "
        "WHERE is_archived = 0 AND last_seen_at IS NULL"
    )


def downgrade() -> None:
    op.drop_index('ix_posts_deleted_detected', table_name='posts')
    op.drop_column('accounts', 'posts_last_scan_at')
    op.drop_column('posts', 'deleted_detected_at')
    op.drop_column('posts', 'last_seen_at')
