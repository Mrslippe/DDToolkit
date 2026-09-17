"""档案视图的卡片布局（R37-P2，devlog/142）

Revision ID: f006
Revises: f005
Create Date: 2026-09-17

用户口径（2026-09-17）：「以卡片为基本单位，用户可以编辑卡片的大小、位置、排布，
卡片内容由用户自定义，例如有纪念日、优质投稿、大事记、时间线等等」。
P1（devlog/141）已交付只读画布 + 卡片注册表 + 两张内置卡；本迁移为 P2 的"用户排布"
落库：**一卡一行**（四个选型里的"新表 `profile_cards`"）。

- `card_key` 是**实例 id**（内置卡 = kind；P3 的自定义卡可以同 kind 多实例）
  ⇒ 唯一键取 `(vtuber_id, card_key)` 而不是 `(vtuber_id, kind)`，P3 不用再改结构；
- `x/y/w/h` 是 12 列网格里的格位（与前端 `layoutModel` 同一口径）；
- `config_json` 留给 P3 的卡片自定义配置（P2 先不写）。

⚠️ 本表挂 `vtubers.id` 外键 ⇒ **删除 V 必须走 `services/purge.py`**
（posts 无外键那次事故的教训：漏清一张子表，`DELETE FROM vtubers` 被外键挡下、整次回滚）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f006'
down_revision: Union[str, Sequence[str], None] = 'f005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'profile_cards',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('vtuber_id', sa.Integer(), sa.ForeignKey('vtubers.id'), nullable=False),
        sa.Column('card_key', sa.String(), nullable=False),
        sa.Column('kind', sa.String(), nullable=False),
        sa.Column('x', sa.Integer(), nullable=False),
        sa.Column('y', sa.Integer(), nullable=False),
        sa.Column('w', sa.Integer(), nullable=False),
        sa.Column('h', sa.Integer(), nullable=False),
        sa.Column('config_json', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('vtuber_id', 'card_key', name='uq_profile_card_vtuber_key'),
    )
    op.create_index('ix_profile_cards_id', 'profile_cards', ['id'])
    op.create_index('ix_profile_cards_vtuber', 'profile_cards',
                    ['vtuber_id', 'y', 'x'])


def downgrade() -> None:
    op.drop_index('ix_profile_cards_vtuber', table_name='profile_cards')
    op.drop_index('ix_profile_cards_id', table_name='profile_cards')
    op.drop_table('profile_cards')