"""app_meta — 通用 KV 表（P9-4，v0.9.8）

Revision ID: f003
Revises: f002
Create Date: 2026-09-10

背景（用户 2026-09-10 P9-4）：「应用启动的时候的定时任务管线添加全部在库的 V 的
主要账号的外部任务……同时记录这次外部任务的时间戳，如果再次启动应用的时间戳与
历史时间戳相差不到 24 小时，则跳过该次任务。」

需要**进程外**记住「上次启动外部补抓是什么时候」——之前的调度判据都是数据驱动
（账号流看 `last_fetched_at`、动态流看进程内计时），但「上次跑没跑过外部补抓」
在数据里没有对应物（第三方源幂等落库，跑没跑看出来），因此需要一张极小的键值表。

新增：
- app_meta(key PK, value TEXT, updated_at DATETIME)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f003'
down_revision: Union[str, Sequence[str], None] = 'f002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'app_meta',
        sa.Column('key', sa.String(), primary_key=True),
        sa.Column('value', sa.Text(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table('app_meta')
