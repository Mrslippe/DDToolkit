"""vtubers.sort_order — 虚拟主播自定义排序（需求批次 4/5，v1.2.0）

Revision ID: f010
Revises: f009
Create Date: 2026-10-07

背景（用户 2026-10-07 批次需求 4/5）：
「允许用户在 vtuber 左栏中按住虚拟主播条目进行拖动并排序，**排序可以继承在筛选后的结果中**」
+ 「左栏筛选浮窗里新增一栏排序（自定义 / A-Z / 粉丝数 / …）」。

形状照 `f002`（`accounts.sort_order`，P8-B 平台徽章拖拽）**往上挪一层**：
左栏顺序是**用户数据**（不是设备偏好）⇒ 落库，前端乐观渲染、失败回退服务端顺序。

⚠️ **与 `accounts.sort_order` 的语义差别（别互相"统一"掉）**：
账号那套 `AccountRepo.reorder()` 是"未列出的排在其后"；左栏**带筛选**拖动时必须改成
"**把传进来的 id 按新顺序填回它们原本占的位置**"，否则被筛掉的那些 V 会被整体推到队尾。
见 `app/repositories/vtuber_repo.py::VTuberRepo.reorder` 的 docstring 与
`docs/plans/vtuber-order-execution.md`。

新增：
- vtubers.sort_order  Integer NOT NULL DEFAULT 0
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f010'
down_revision: Union[str, Sequence[str], None] = 'f009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('sort_order', sa.Integer(),
                                       nullable=False, server_default='0'))


def downgrade() -> None:
    with op.batch_alter_table('vtubers') as batch:
        batch.drop_column('sort_order')
