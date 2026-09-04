"""externals — 第三方数据源（P4 添加数据源并分离抓取逻辑）

Revision ID: e004
Revises: e003
Create Date: 2026-09-05

新增（外部已固定化数据的本地存储，采集逻辑见 app/services/externals/）：
- account_stat_snapshots.source  数据来源（self=直采 / zeroroku=第三方回填）
- live_gift_days                  直播礼物日聚合（zeroroku 公开端点实测日粒度）
- thirdparty_vtubers              第三方 VTuber 索引（danmakus vup-list /
                                  透传 laplace vup-slim.json：企划/公会/房间号）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e004'
down_revision: Union[str, Sequence[str], None] = 'e003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'account_stat_snapshots',
        sa.Column('source', sa.String(), nullable=False, server_default='self'),
    )
    op.create_table(
        'live_gift_days',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('account_id', sa.Integer(), sa.ForeignKey('accounts.id'), nullable=False),
        sa.Column('source', sa.String(), nullable=False, server_default='zeroroku'),
        sa.Column('gift_date', sa.String(), nullable=False),
        sa.Column('gift_amount', sa.String(), nullable=True),
        sa.Column('guard_amount', sa.String(), nullable=True),
        sa.Column('sc_amount', sa.String(), nullable=True),
        sa.Column('total_amount', sa.String(), nullable=True),
        sa.Column('room_id', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.UniqueConstraint('account_id', 'source', 'gift_date', name='uq_live_gift_day'),
    )
    op.create_index('ix_live_gift_days_account_date', 'live_gift_days',
                    ['account_id', 'gift_date'])
    op.create_table(
        'thirdparty_vtubers',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('platform', sa.String(), nullable=False, server_default='bilibili'),
        sa.Column('platform_uid', sa.String(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('type', sa.String(), nullable=True),
        sa.Column('room_id', sa.String(), nullable=True),
        sa.Column('group_name', sa.String(), nullable=True),
        sa.Column('source', sa.String(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.UniqueConstraint('source', 'platform_uid', name='uq_thirdparty_vtuber'),
    )
    op.create_index('ix_thirdparty_vtubers_platform_uid', 'thirdparty_vtubers',
                    ['platform_uid'])


def downgrade() -> None:
    op.drop_index('ix_thirdparty_vtubers_platform_uid', table_name='thirdparty_vtubers')
    op.drop_table('thirdparty_vtubers')
    op.drop_index('ix_live_gift_days_account_date', table_name='live_gift_days')
    op.drop_table('live_gift_days')
    op.drop_column('account_stat_snapshots', 'source')
