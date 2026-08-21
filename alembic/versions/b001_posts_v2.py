"""posts_v2 — posts 独立于 account，platform+pid 去重，结构化内容字段

Revision ID: b001
Revises: a001
Create Date: 2026-08-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b001'
down_revision: Union[str, Sequence[str], None] = 'a001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # drop old posts + accounts if exists, then recreate both
    op.execute("DROP TABLE IF EXISTS posts")
    op.execute("DROP TABLE IF EXISTS accounts")
    op.create_table('accounts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('vtuber_id', sa.Integer(), sa.ForeignKey('vtubers.id'), nullable=False),
        sa.Column('platform', sa.String(), nullable=False),
        sa.Column('platform_uid', sa.String(), nullable=False),
        sa.Column('display_name', sa.String(), nullable=True),
        sa.Column('avatar_url', sa.String(), nullable=True),
        sa.Column('avatar_path', sa.String(), nullable=True),
        sa.Column('sign', sa.String(), nullable=True),
        sa.Column('url', sa.String(), nullable=True),
        sa.Column('followers_count', sa.Integer(), server_default='0'),
        sa.Column('room_id', sa.String(), nullable=True),
        sa.Column('live_status', sa.Integer(), server_default='0'),
        sa.Column('live_title', sa.String(), nullable=True),
        sa.Column('live_url', sa.String(), nullable=True),
        sa.Column('last_fetched_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('platform', 'platform_uid', name='uq_account_platform_uid'),
    )
    op.create_index('ix_accounts_id', 'accounts', ['id'])
    op.create_table('posts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('platform', sa.String(), nullable=False),
        sa.Column('platform_uid', sa.String(), nullable=False),
        sa.Column('platform_post_id', sa.String(), nullable=False),
        sa.Column('type', sa.String(), nullable=False, server_default='text'),
        sa.Column('title', sa.String(), nullable=True),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('cover_url', sa.String(), nullable=True),
        sa.Column('permalink', sa.String(), nullable=True),
        sa.Column('body_json', sa.Text(), nullable=True),
        sa.Column('stats_json', sa.Text(), nullable=True),
        sa.Column('published_at', sa.DateTime(), nullable=True),
        sa.Column('raw_json', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('platform', 'platform_post_id', name='uq_post_platform_pid'),
    )
    op.create_index('ix_posts_id', 'posts', ['id'])
    op.create_index('ix_posts_platform', 'posts', ['platform'])
    op.create_index('ix_posts_platform_uid', 'posts', ['platform_uid'])


def downgrade() -> None:
    op.drop_table('posts')
    op.drop_table('accounts')
