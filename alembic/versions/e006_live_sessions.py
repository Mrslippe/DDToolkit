"""live_sessions — 直播场次表（v0.9.x 内容管道 M1，danmakus 固定化场次）

Revision ID: e006
Revises: e005
Create Date: 2026-09-07

背景：直播日历内容改造（M1 后端底座）：
- 历史场次（标题/起止/分区/收益）主源 = danmakus 公开端点
  /api/v2/channel?uId=&includeLive=true（免登录，实测 2021-10 起全量）；
- self 快照推导场次不落本表（读取时按 ±90min 窗口合并，见 LiveSessionRepo.merged）；
- M3 将解锁 B站 live_rcmd（type='live' 场次）也写入本表（source='feed'）；
- live_id 为平台级场次唯一键（danmakus uuid / B站 live_id）；
- raw_json 保留原始数据（档案保真定位）。

新增：
- live_sessions  直播场次（danmakus/feed 源），(account_id, live_id) 唯一
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e006'
down_revision: Union[str, Sequence[str], None] = 'e005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'live_sessions',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('account_id', sa.Integer(), sa.ForeignKey('accounts.id'), nullable=False),
        sa.Column('platform', sa.String(), nullable=False, server_default='bilibili'),
        sa.Column('source', sa.String(), nullable=False, server_default='danmakus'),
        sa.Column('live_id', sa.String(), nullable=True),
        sa.Column('title', sa.String(), nullable=True),
        sa.Column('room_id', sa.String(), nullable=True),
        sa.Column('start_at', sa.DateTime(), nullable=False),
        sa.Column('end_at', sa.DateTime(), nullable=True),
        sa.Column('parent_area_name', sa.String(), nullable=True),
        sa.Column('area_name', sa.String(), nullable=True),
        sa.Column('cover_url', sa.String(), nullable=True),
        sa.Column('total_income', sa.Float(), nullable=True),
        sa.Column('max_online_count', sa.Integer(), nullable=True),
        sa.Column('danmakus_count', sa.Integer(), nullable=True),
        sa.Column('raw_json', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        # SQLite 不支持后置 ALTER 加约束 → UniqueConstraint 内联（batch 模式不必）
        sa.UniqueConstraint('account_id', 'live_id', name='uq_live_sessions_account_live'),
    )
    op.create_index('ix_live_sessions_account_start', 'live_sessions',
                    ['account_id', 'start_at'])


def downgrade() -> None:
    op.drop_index('ix_live_sessions_account_start', table_name='live_sessions')
    op.drop_table('live_sessions')
