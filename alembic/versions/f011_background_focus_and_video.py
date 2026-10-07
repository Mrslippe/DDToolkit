"""vtubers 背景取景 + 背景视频 — 需求 7/9（v1.2.0）

Revision ID: f011
Revises: f010
Create Date: 2026-10-07

背景（用户 2026-10-07 批次需求 7/9，口径见 `docs/plans/background-and-solo-execution.md`）：
- **需求 7**「背景图支持调整位置」= **平移 + 缩放**，**每个 V 各存一份**，入口在「档案设置」；
- **需求 9**「背景图支持视频」= **本地文件**（设置里选，拷进 `static/custom_bg/`），不填 URL。

两列同一条迁移：同一处功能（背景）、同一次全套文档与判据同步，分成两条迁移没有收益。

新增：
- vtubers.background_focus       TEXT NULL —— 取景，JSON `{"x":0..1,"y":0..1,"scale":1..3}`
  ⚠️ **归一化存**（0..1 的比例，不是像素）：窗口尺寸/DPR 变了取景不该跟着跑。
- vtubers.background_video_path  TEXT NULL —— `static/custom_bg/` 相对路径（与 `background_path`
  同款口径：**只取文件名**，不许越出目录 —— 见 `app/services/vtuber_background.py` 头部那三条不变量）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f011'
down_revision: Union[str, Sequence[str], None] = 'f010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('background_focus', sa.Text(), nullable=True))
    op.add_column('vtubers', sa.Column('background_video_path', sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('vtubers') as batch:
        batch.drop_column('background_video_path')
        batch.drop_column('background_focus')
