"""轻资产长期储存索引（L1，devlog/257）

Revision ID: f009
Revises: f008
Create Date: 2026-09-29

新建一张 `local_assets`（而不是往 `vtubers` / `accounts` 上挂列）：被固化的资源**不属于
某一个 V**（同一张图可能被多个 V 用、账号删掉后用户选过的那张仍要留着），粒度是
`(kind, 稳定键)`。规格见 `docs/backend/ASSETS.md` §2.3。

- `key` = **去掉签名参数的 URL**：实测微博头像签名只有约 3 小时有效期，同一张图的两次
  抓取只差 `Expires`/`ssig`（盘上两个文件 sha256 逐字节相同）⇒ 按 URL 去重等于没去重；
- `url` 另存完整 URL（回源用）：丢掉签名参数只影响**查找**，绝不影响**下载**；
- `sha256` 用于去重与校验（文件名用的是 URL 摘要 —— 内容摘要要下完才知道，
  而那会让"每次都要先发请求"，恰好废掉本模块的主要收益）；
- `pinned` = 用户选过的 / 手动 pin 的 ⇒ `prune` 永不删。

⚠️ **本表不挂 `vtubers` / `accounts` 外键** ⇒ **不需要**改 `app/services/purge.py`
（删 V / 删账号不该动共享资源）。代价是"还被谁引用"必须**显式查**：
`app/services/assets.py::_referenced_keys()`（`vtubers.avatar` / 账号 `avatar_url` /
`vtuber_avatar_history.avatar_url`；L3 起再加 `posts.cover_local`）。

只建表、可回滚（不重建任何既有表 —— 方案 §4 S-2 的红线）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f009'
down_revision: Union[str, Sequence[str], None] = 'f008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'local_assets',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('kind', sa.String(), nullable=False),
        sa.Column('key', sa.Text(), nullable=False),
        sa.Column('url', sa.Text(), nullable=False),
        sa.Column('path', sa.String(), nullable=False),
        sa.Column('ext', sa.String(), nullable=True),
        sa.Column('bytes', sa.Integer(), nullable=True),
        sa.Column('sha256', sa.String(), nullable=True),
        sa.Column('pinned', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('last_used_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('kind', 'key', name='uq_local_asset_kind_key'),
    )
    op.create_index('ix_local_assets_id', 'local_assets', ['id'])
    op.create_index('ix_local_assets_kind_sha256', 'local_assets', ['kind', 'sha256'])
    op.create_index('ix_local_assets_kind_pinned', 'local_assets', ['kind', 'pinned'])


def downgrade() -> None:
    op.drop_index('ix_local_assets_kind_pinned', table_name='local_assets')
    op.drop_index('ix_local_assets_kind_sha256', table_name='local_assets')
    op.drop_index('ix_local_assets_id', table_name='local_assets')
    op.drop_table('local_assets')
