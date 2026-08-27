"""account_stat_snapshots — 账号统计快照历史表（P0，v0.5.0）

Revision ID: e001
Revises: d002
Create Date: 2026-08-26

背景：粉丝数/直播状态此前只在 accounts 表原地覆盖，历史曲线不可回补。
每次账号信息抓取成功后追加一行快照，为涨粉趋势可视化积累数据。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e001'
down_revision: Union[str, Sequence[str], None] = 'd002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'account_stat_snapshots',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('account_id', sa.Integer(), sa.ForeignKey('accounts.id'), nullable=False),
        sa.Column('followers_count', sa.Integer(), nullable=True),
        sa.Column('live_status', sa.Integer(), nullable=True),
        sa.Column('live_title', sa.String(), nullable=True),
        sa.Column('captured_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_account_stat_snapshots_account_id',
                    'account_stat_snapshots', ['account_id'])
    op.create_index('ix_account_stat_snapshots_captured_at',
                    'account_stat_snapshots', ['captured_at'])


def downgrade() -> None:
    op.drop_index('ix_account_stat_snapshots_captured_at', table_name='account_stat_snapshots')
    op.drop_index('ix_account_stat_snapshots_account_id', table_name='account_stat_snapshots')
    op.drop_table('account_stat_snapshots')
