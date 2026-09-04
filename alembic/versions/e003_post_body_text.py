"""post body_text — 帖子正文纯文本列（P2 全文搜索）

Revision ID: e003
Revises: e002
Create Date: 2026-09-05

背景：关键词搜索此前仅覆盖 title/summary（前 200 字摘要），正文检索盲区。
新增 posts.body_text 存 body_json 提取的纯文本（提取逻辑单一来源：
app/services/post_text.py，写入路径与回填脚本共用）。

设计定案（docs/TODO.md P2）：
- 个人库量级（千条级）先 LIKE 即可，FTS5 暂缓；本列不加索引
（LIKE '%q%' 无法走 B-tree，加索引反增写放大）；
- 存量回填走一次性脚本 scripts/backfill_post_body_text.py（幂等），
不在迁移内做数据搬运，保持迁移轻。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e003'
down_revision: Union[str, Sequence[str], None] = 'e002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('posts', sa.Column('body_text', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('posts', 'body_text')
