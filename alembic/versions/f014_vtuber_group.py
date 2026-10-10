"""V 的企划归属（B3，需求 6）— v1.2.x

Revision ID: f014
Revises: f013
Create Date: 2026-10-08

用户口径（2026-10-08 拍板）：「**全图标**；素材还没制作 ⇒ 先用默认图标或文字占位」。

新增两列：
- vtubers.group_name  TEXT NULL —— 企划名（如 `VirtuaReal` / `NIJISANJI` / `虚研社`）；
- vtubers.group_uuid  TEXT NULL —— 企划的**稳定 UUID**（vdb 的 `group` 字段）。

为什么是两列而不是一张关联表：一个 V 现实里**只属一个企划**，多对多是过度设计
（真出现"多企划"时再加表也不迟，届时这两列就是"主企划"）。UUID 单列的意义是**跨源对齐**：
vdb 是唯一同时给 UUID 与名字的源，有了它才能判断"两份名单里的企划是不是同一个"
（danmakus 那份是二次派生、只有名字）。

⚠️ 数据来源**不出网**（`app/services/groups.py`）：随包候选池快照（vdb 派生）→ 本地
`thirdparty_vtubers`（danmakus 周级索引）兜底。B 站官方**没有**"所属企划"结构化字段（实测）。
写入纪律：**只填空、不覆盖**（见该模块的头注释）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f014'
down_revision: Union[str, Sequence[str], None] = 'f013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('group_name', sa.Text(), nullable=True))
    op.add_column('vtubers', sa.Column('group_uuid', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('vtubers') as batch:
        batch.drop_column('group_uuid')
        batch.drop_column('group_name')
