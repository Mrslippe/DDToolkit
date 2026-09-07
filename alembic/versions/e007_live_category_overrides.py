"""live_category_overrides — 直播分类用户校正表（v0.9.x 类型引擎 v2）

Revision ID: e007
Revises: e006
Create Date: 2026-09-07

背景：v2 多信号带权评分（user 2026-09-07 决策：标题多词评分 + 系列聚类 +
用户校正闭环）。校正结果 (account_id, live_id) → category：
- 推断第一优先级（override 源，见 app/services/live_type.py）；
- 反哺账号词库（被校正标题词条 → learned 源，其余场次同词条生效）；
- 仅表内场次（danmakus/feed）可校正；self 快照虚拟场次无 live_id。

新增：
- live_category_overrides  分类用户校正，(account_id, live_id) 唯一
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e007'
down_revision: Union[str, Sequence[str], None] = 'e006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'live_category_overrides',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('account_id', sa.Integer(), sa.ForeignKey('accounts.id'), nullable=False),
        sa.Column('live_id', sa.String(), nullable=False),
        sa.Column('category', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        # SQLite 不支持后置 ALTER 加约束 → UniqueConstraint 内联
        sa.UniqueConstraint('account_id', 'live_id',
                            name='uq_live_category_overrides_account_live'),
    )
    op.create_index('ix_live_category_overrides_account', 'live_category_overrides',
                    ['account_id'])


def downgrade() -> None:
    op.drop_index('ix_live_category_overrides_account', table_name='live_category_overrides')
    op.drop_table('live_category_overrides')
