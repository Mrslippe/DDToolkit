"""posts_per_uid_dedup — 唯一约束改为 (platform, platform_uid, platform_post_id)

Revision ID: c002
Revises: c001
Create Date: 2026-08-06

联合投稿的视频/动态会出现在多个 V 的列表里，全局去重会导致第二个 V 抓取时
违反唯一约束。改为按 UID 去重，每个 V 的帖子列表完整。

SQLite 不支持直接修改约束，需要重建表。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c002'
down_revision: Union[str, Sequence[str], None] = 'c001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE posts RENAME TO posts_old")

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
        sa.Column('is_archived', sa.Boolean(), server_default='0'),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('platform', 'platform_uid', 'platform_post_id', name='uq_post_platform_uid_pid'),
    )

    # SQLite 重命名表后旧索引名仍被占用，需先删掉再建新索引
    op.execute("DROP INDEX IF EXISTS ix_posts_id")
    op.execute("DROP INDEX IF EXISTS ix_posts_platform")
    op.execute("DROP INDEX IF EXISTS ix_posts_platform_uid")

    op.create_index('ix_posts_id', 'posts', ['id'])
    op.create_index('ix_posts_platform', 'posts', ['platform'])
    op.create_index('ix_posts_platform_uid', 'posts', ['platform_uid'])

    op.execute("""
        INSERT INTO posts (id, platform, platform_uid, platform_post_id, type, title, summary,
                           cover_url, permalink, body_json, stats_json, published_at,
                           raw_json, is_archived, created_at)
        SELECT id, platform, platform_uid, platform_post_id, type, title, summary,
               cover_url, permalink, body_json, stats_json, published_at,
               raw_json, is_archived, created_at
        FROM posts_old
    """)

    op.drop_table('posts_old')


def downgrade() -> None:
    op.execute("ALTER TABLE posts RENAME TO posts_new")

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
        sa.Column('is_archived', sa.Boolean(), server_default='0'),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('platform', 'platform_post_id', name='uq_post_platform_pid'),
    )

    op.execute("DROP INDEX IF EXISTS ix_posts_id")
    op.execute("DROP INDEX IF EXISTS ix_posts_platform")
    op.execute("DROP INDEX IF EXISTS ix_posts_platform_uid")

    op.create_index('ix_posts_id', 'posts', ['id'])
    op.create_index('ix_posts_platform', 'posts', ['platform'])
    op.create_index('ix_posts_platform_uid', 'posts', ['platform_uid'])

    # 回滚到全局唯一约束，跨 uid 重复的 (platform, platform_post_id) 只保留最小 id 的一条
    op.execute("""
        INSERT INTO posts (id, platform, platform_uid, platform_post_id, type, title, summary,
                           cover_url, permalink, body_json, stats_json, published_at,
                           raw_json, is_archived, created_at)
        SELECT id, platform, platform_uid, platform_post_id, type, title, summary,
               cover_url, permalink, body_json, stats_json, published_at,
               raw_json, is_archived, created_at
        FROM posts_new
        WHERE id IN (
            SELECT MIN(id) FROM posts_new GROUP BY platform, platform_post_id
        )
    """)

    op.drop_table('posts_new')
