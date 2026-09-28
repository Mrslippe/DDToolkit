"""头像多版本保留（R47，devlog/249）

Revision ID: f008
Revises: f007
Create Date: 2026-09-28

用户口径（2026-09-28）：「发现账号更换了头像，新抓取下来的**不要直接覆盖以前的**，
而是把这些都作为**可选项**保留下来，标记当前用的是哪个就行」。

新建一张 `vtuber_avatar_history`（而不是往 `vtubers` 上挂一个 JSON 列）：
粒度是**一次"首次见到这张图"**，要按 V 查、按时间排、要能封顶淘汰 ——
一版本一行才能索引；而且它与 `vtuber_field_history`（f004，曾用名/曾用签名）
是同一类账本，放两张表里同一个套路更好认。

- 唯一键 `(vtuber_id, avatar_url)`：同一 V 的同一 URL 只留一行（抓取侧幂等 upsert，
  每次只 touch `last_seen_at`，不会把历史刷成噪声）；
- `account_id` 可空：账号被解除订阅后这一行仍要能说明"曾经有过这张脸"
  （展示用的 `platform` 另存一份，账号没了也标得出平台）；
- `avatar_path` 可空：下载失败/延后下载时先落 URL，文件到位后再补。

⚠️ 本表挂 `vtubers.id` / `accounts.id` **两个外键** ⇒ **删除 V / 解除订阅必须走
`app/services/purge.py`**（posts 那次事故的教训：漏清一张子表，`DELETE FROM vtubers`
被外键挡下、整次回滚 → 接口 500）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f008'
down_revision: Union[str, Sequence[str], None] = 'f007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'vtuber_avatar_history',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('vtuber_id', sa.Integer(), sa.ForeignKey('vtubers.id'), nullable=False),
        sa.Column('account_id', sa.Integer(), sa.ForeignKey('accounts.id'), nullable=True),
        sa.Column('platform', sa.String(), nullable=True),
        sa.Column('avatar_url', sa.Text(), nullable=False),
        sa.Column('avatar_path', sa.String(), nullable=True),
        sa.Column('first_seen_at', sa.DateTime(), nullable=False),
        sa.Column('last_seen_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('vtuber_id', 'avatar_url', name='uq_vtuber_avatar_url'),
    )
    op.create_index('ix_vtuber_avatar_history_id', 'vtuber_avatar_history', ['id'])
    op.create_index('ix_vtuber_avatar_history_vtuber', 'vtuber_avatar_history',
                    ['vtuber_id', 'first_seen_at'])


def downgrade() -> None:
    op.drop_index('ix_vtuber_avatar_history_vtuber', table_name='vtuber_avatar_history')
    op.drop_index('ix_vtuber_avatar_history_id', table_name='vtuber_avatar_history')
    op.drop_table('vtuber_avatar_history')
