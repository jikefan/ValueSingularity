"""initial schema: watchlist, journal, events, settings, snapshots

Revision ID: 0001
Revises:
Create Date: 2026-11-18
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "watchlist",
        sa.Column("code", sa.String(6), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("industry", sa.String(64)),
        sa.Column("note", sa.Text()),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_table(
        "journal",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("code", sa.String(6), nullable=False),
        sa.Column("name", sa.String(64)),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("falsify_condition", sa.Text(), nullable=False),
        sa.Column("max_drawdown", sa.Numeric(6, 2)),
        sa.Column("emotion", sa.String(32)),
        sa.Column("price", sa.Numeric(12, 3)),
        sa.Column("snapshot", postgresql.JSONB()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_journal_code", "journal", ["code"])
    op.create_index("ix_journal_code_created_at", "journal", ["code", "created_at"])
    op.create_table(
        "events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("code", sa.String(6)),
        sa.Column("meta", postgresql.JSONB()),
        sa.Column("ts", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "settings",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", postgresql.JSONB(), nullable=False),
    )
    op.create_table(
        "stock_snapshot",
        sa.Column("code", sa.String(6), primary_key=True),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_table(
        "market_snapshot",
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_market_snapshot_single_row"),
    )


def downgrade() -> None:
    op.drop_table("market_snapshot")
    op.drop_table("stock_snapshot")
    op.drop_table("settings")
    op.drop_table("events")
    op.drop_index("ix_journal_code_created_at", table_name="journal")
    op.drop_index("ix_journal_code", table_name="journal")
    op.drop_table("journal")
    op.drop_table("watchlist")
