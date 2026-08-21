"""init_v2 — VTuber + Account tables

Revision ID: a001
Revises:
Create Date: 2026-08-05

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'a001'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('vtubers',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('birthday', sa.String(), nullable=True),
        sa.Column('debut_date', sa.String(), nullable=True),
        sa.Column('setting', sa.Text(), nullable=True),
        sa.Column('avatar', sa.String(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_vtubers_id', 'vtubers', ['id'])
    op.create_index('ix_vtubers_name', 'vtubers', ['name'])

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


def downgrade() -> None:
    op.drop_table('accounts')
    op.drop_table('vtubers')
