"""签名来源/覆盖 + 曾用名·曾用签名历史（2026-09-13，devlog/074）

Revision ID: f004
Revises: f003
Create Date: 2026-09-13

用户 2026-09-13 口径（签名下拉栏的第三轮迭代）：

1. **签名来源选择（A3）**：卡片签名 = `vtubers.sign_override`（手改的覆盖）
   → `vtubers.sign_source_account_id` 指向的账号 → 主账号。
   两个新字段都**不改** `accounts.sign` —— 平台签名是平台的事实，只读。
2. **字段锁定退役**：`accounts.locked_fields` 删除 —— 平台昵称/签名允许被抓取覆盖，
   改动的痕迹改为显式记账（见下）。
3. **曾用名 / 曾用签名**：新表 `vtuber_field_history`，每次值真的变了追加一行旧值。
   ⚠️ 不能指望快照表兜底：`account_stat_snapshots` 只存粉丝数/直播状态/开播标题，
   **不含昵称与签名**。

新增：
- vtubers.sign_override            Text    NULL
- vtubers.sign_source_account_id   Integer NULL
- vtuber_field_history（新表：vtuber_id / account_id / field / value / changed_at）
删除：
- accounts.locked_fields           String  NULL（连带 scheduler._field_locked）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f004'
down_revision: Union[str, Sequence[str], None] = 'f003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('sign_override', sa.Text(), nullable=True))
    op.add_column('vtubers', sa.Column('sign_source_account_id', sa.Integer(),
                                       nullable=True))
    op.create_table(
        'vtuber_field_history',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('vtuber_id', sa.Integer(), sa.ForeignKey('vtubers.id'), nullable=False),
        sa.Column('account_id', sa.Integer(), sa.ForeignKey('accounts.id'), nullable=True),
        sa.Column('field', sa.String(), nullable=False),
        sa.Column('value', sa.Text(), nullable=False),
        sa.Column('changed_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_vtuber_field_history_id', 'vtuber_field_history', ['id'])
    op.create_index('ix_vtuber_field_history_vtuber', 'vtuber_field_history',
                    ['vtuber_id', 'field'])
    with op.batch_alter_table('accounts') as batch:
        batch.drop_column('locked_fields')


def downgrade() -> None:
    op.add_column('accounts', sa.Column('locked_fields', sa.String(), nullable=True))
    op.drop_index('ix_vtuber_field_history_vtuber', table_name='vtuber_field_history')
    op.drop_index('ix_vtuber_field_history_id', table_name='vtuber_field_history')
    op.drop_table('vtuber_field_history')
    with op.batch_alter_table('vtubers') as batch:
        batch.drop_column('sign_source_account_id')
        batch.drop_column('sign_override')
