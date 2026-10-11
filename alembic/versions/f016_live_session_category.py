"""直播场次类型落库（写时定稿）— v1.2.x

Revision ID: f016
Revises: f015
Create Date: 2026-10-12

新增两列 + 一个索引：
- `live_sessions.category`       TEXT NULL —— 定稿的类型（英文枚举，与前端标签同一套）；
- `live_sessions.category_from`  TEXT NULL —— **哪一档定的**（诊断/界面"为什么"用）；
- `(account_id, category)` 索引 —— 按类型筛（日历）与按类型聚合（数据视图卡片）都吃它。

## 为什么落库（用户 2026-10-12 决策）

> 「直播场次信息在入库的时候根据其中携带的各类数据直接推断出类型，
>  不需要再在新增场次的时候去考虑改变已经入库的历史场次类型」

两条收益：① **可查询**（按类型筛/统计是我们确实要做的，落库前这只能每请求现算）；
② 规则迭代不必再背"读路径每请求全局重算"的包袱。

⚠️ **两列都必须可空**：写时定稿只写"真正的推导"（title/area/date），
兜底（`fallback`）**不落库**——NULL 表示"还没定出来"，读取时按同一口径现算并显示中性。
老库存量行的两列天然是 NULL，由**惰性回填**（读路径顺手补齐，见 `app/services/live_settle.py`）
收敛，不需要脚本：迁移会自动跑（`app/main.py::lifespan`），而 `scripts/backfill_*.py` 不会。

## 为什么索引是 (account_id, category) 而不是 (category)

两类查询都是**账号内**的：日历是按账号+月份筛类型，卡片是按账号聚合类型分布。
`category` 单列索引在这个数据量（每账号千级）下没有意义。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f016'
down_revision: Union[str, Sequence[str], None] = 'f015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('live_sessions', sa.Column('category', sa.Text(), nullable=True))
    op.add_column('live_sessions', sa.Column('category_from', sa.Text(), nullable=True))
    op.create_index('ix_live_sessions_account_category', 'live_sessions',
                    ['account_id', 'category'])


def downgrade() -> None:
    op.drop_index('ix_live_sessions_account_category', table_name='live_sessions')
    with op.batch_alter_table('live_sessions') as batch:
        batch.drop_column('category_from')
        batch.drop_column('category')
