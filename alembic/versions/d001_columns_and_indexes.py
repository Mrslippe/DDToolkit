"""columns_and_indexes — vtubers.faction 列 + 热路径索引

Revision ID: d001
Revises: c002
Create Date: 2026-08-24

背景：v0.5 起模型新增 vtubers.faction（阵营，手动维护），但运行时靠
app/main.py 里的 _migrate()（裸 sqlite3 ALTER）补齐，alembic 链从未收录，
autogenerate 永远把 faction 当作漂移。本迁移补齐正式版本，并顺带把
create_all 时代缺失的热路径索引纳入迁移链：

- ix_posts_platform_uid_published：(platform, platform_uid, published_at)
  覆盖 vtuber_repo.paginated 的分页查询（WHERE platform=? AND platform_uid=? ORDER BY published_at DESC）
- ix_posts_published_at：覆盖归档规则（is_archived=0 AND published_at < cutoff）
- ix_accounts_vtuber_id：覆盖 AccountRepo.by_vtuber（按 VTuber 查账号）

注意：create_all 生成的旧库（无 alembic_version 表）由 app/main.py 的
_sync_legacy_schema() 在启动时补齐这些列/索引后 stamp head，本迁移只面向
全新库与后续升级。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd001'
down_revision: Union[str, Sequence[str], None] = 'c002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('faction', sa.String(), nullable=True))

    op.create_index('ix_posts_platform_uid_published', 'posts',
                    ['platform', 'platform_uid', 'published_at'])
    op.create_index('ix_posts_published_at', 'posts', ['published_at'])
    op.create_index('ix_accounts_vtuber_id', 'accounts', ['vtuber_id'])


def downgrade() -> None:
    op.drop_index('ix_accounts_vtuber_id', table_name='accounts')
    op.drop_index('ix_posts_published_at', table_name='posts')
    op.drop_index('ix_posts_platform_uid_published', table_name='posts')
    op.drop_column('vtubers', 'faction')