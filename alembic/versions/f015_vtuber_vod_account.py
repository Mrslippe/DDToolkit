"""V 的「录播号」（C1，需求 2.1）— v1.2.x

Revision ID: f015
Revises: f014
Create Date: 2026-10-11

新增一列：
- vtubers.vod_account_uid  TEXT NULL —— 用户为这个 V 指定的**录播号 mid**
  （B 站 uid；多个用逗号分隔）。

## 为什么需要它（2026-10-11 真机实测，`devlog/464`）

C1 的口径是"在 V 的账号本身 + 用户可指定的录播账号里找录播"，而实测那 12 个 V
**自己都不发回放**（投稿普遍 3~5 分钟，是剪辑/翻唱）—— 回放在"专门录播号"上。
所以"用户指定一个录播号"不是可选项，是这个功能**唯一能真正找到回放**的入口。

## 为什么是自由字符串而不是外键

录播号很可能**不在我们的库里**（用户从 B 站搜来一个 uid 直接用）⇒ 不能做成
`accounts.id` 外键。多个号用逗号分隔（同一场直播可能有多个录播组分段录）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f015'
down_revision: Union[str, Sequence[str], None] = 'f014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('vod_account_uid', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('vtubers') as batch:
        batch.drop_column('vod_account_uid')
