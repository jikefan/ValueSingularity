"""saas phase 1: users, refresh_tokens, stock_meta, alert_deliveries, multi-tenant scope

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("TRUNCATE TABLE watchlist, journal, events, settings RESTART IDENTITY CASCADE")

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(255)),
        sa.Column("phone", sa.String(32)),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("display_name", sa.String(64), nullable=False),
        sa.Column("plan_tier", sa.String(16), server_default="free", nullable=False),
        sa.Column("plan_expires_at", sa.DateTime(timezone=True)),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("phone", name="uq_users_phone"),
        sa.CheckConstraint(
            "email IS NOT NULL OR phone IS NOT NULL",
            name="contact_present",
        ),
        sa.CheckConstraint(
            "plan_tier IN ('free', 'pro', 'ai_plus')",
            name="plan_tier_valid",
        ),
    )

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("user_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("user_agent", sa.String(255)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_refresh_tokens"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_refresh_tokens_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("token_hash", name="uq_refresh_tokens_token_hash"),
    )
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])

    op.create_table(
        "stock_meta",
        sa.Column("code", sa.String(6), nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("exchange", sa.String(8), nullable=False),
        sa.Column("industry_sw1", sa.String(64)),
        sa.Column("industry_sw2", sa.String(64)),
        sa.Column("list_date", sa.Date()),
        sa.Column("is_st", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("code", name="pk_stock_meta"),
    )

    op.create_table(
        "alert_deliveries",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("source_type", sa.String(24), nullable=False),
        sa.Column("code", sa.String(6), nullable=False),
        sa.Column("trigger_date", sa.Date(), nullable=False),
        sa.Column("rule_signature", sa.String(64), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("channel", sa.String(24), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_alert_deliveries"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_alert_deliveries_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "user_id",
            "source_type",
            "code",
            "trigger_date",
            "rule_signature",
            name="uq_alert_deliveries_dedup",
        ),
        sa.CheckConstraint(
            "source_type IN ('watchlist_sentinel', 'journal_falsify')",
            name="source_type_valid",
        ),
    )

    op.drop_constraint("pk_watchlist", "watchlist", type_="primary")
    op.add_column("watchlist", sa.Column("user_id", sa.Uuid(as_uuid=True), nullable=False))
    op.add_column("watchlist", sa.Column("target_price", sa.Numeric(12, 3)))
    op.add_column("watchlist", sa.Column("target_pe_percentile", sa.Numeric(5, 2)))
    op.add_column("watchlist", sa.Column("target_dividend_yield", sa.Numeric(5, 2)))
    op.add_column(
        "watchlist",
        sa.Column("alert_enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "watchlist",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_primary_key("pk_watchlist", "watchlist", ["user_id", "code"])
    op.create_foreign_key(
        "fk_watchlist_user_id_users",
        "watchlist",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_watchlist_user_added_at", "watchlist", ["user_id", "added_at"])

    op.drop_index("ix_journal_code_created_at", table_name="journal")
    op.drop_index("ix_journal_code", table_name="journal")
    op.add_column("journal", sa.Column("user_id", sa.Uuid(as_uuid=True), nullable=False))
    op.add_column("journal", sa.Column("falsify_rules", postgresql.JSONB()))
    op.add_column(
        "journal",
        sa.Column("benchmark_code", sa.String(6), server_default="000300", nullable=False),
    )
    op.add_column("journal", sa.Column("benchmark_price", sa.Numeric(12, 3)))
    op.create_foreign_key(
        "fk_journal_user_id_users",
        "journal",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_check_constraint(
        "action_valid",
        "journal",
        "action IN ('buy', 'sell', 'add', 'trim', 'pass')",
    )
    op.create_index("ix_journal_user_code_created_at", "journal", ["user_id", "code", "created_at"])

    op.add_column("events", sa.Column("user_id", sa.Uuid(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_events_user_id_users",
        "events",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_events_user_ts", "events", ["user_id", "ts"])

    op.drop_constraint("pk_settings", "settings", type_="primary")
    op.add_column("settings", sa.Column("user_id", sa.Uuid(as_uuid=True), nullable=False))
    op.create_primary_key("pk_settings", "settings", ["user_id", "key"])
    op.create_foreign_key(
        "fk_settings_user_id_users",
        "settings",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.create_index("ix_stock_snapshot_as_of", "stock_snapshot", ["as_of"])


def downgrade() -> None:
    op.drop_index("ix_stock_snapshot_as_of", table_name="stock_snapshot")
    op.execute("TRUNCATE TABLE watchlist, journal, events, settings RESTART IDENTITY CASCADE")

    op.drop_constraint("fk_settings_user_id_users", "settings", type_="foreignkey")
    op.drop_constraint("pk_settings", "settings", type_="primary")
    op.drop_column("settings", "user_id")
    op.create_primary_key("pk_settings", "settings", ["key"])

    op.drop_index("ix_events_user_ts", table_name="events")
    op.drop_constraint("fk_events_user_id_users", "events", type_="foreignkey")
    op.drop_column("events", "user_id")

    op.drop_index("ix_journal_user_code_created_at", table_name="journal")
    op.drop_constraint("action_valid", "journal", type_="check")
    op.drop_constraint("fk_journal_user_id_users", "journal", type_="foreignkey")
    op.drop_column("journal", "benchmark_price")
    op.drop_column("journal", "benchmark_code")
    op.drop_column("journal", "falsify_rules")
    op.drop_column("journal", "user_id")
    op.create_index("ix_journal_code", "journal", ["code"])
    op.create_index("ix_journal_code_created_at", "journal", ["code", "created_at"])

    op.drop_index("ix_watchlist_user_added_at", table_name="watchlist")
    op.drop_constraint("fk_watchlist_user_id_users", "watchlist", type_="foreignkey")
    op.drop_constraint("pk_watchlist", "watchlist", type_="primary")
    op.drop_column("watchlist", "updated_at")
    op.drop_column("watchlist", "alert_enabled")
    op.drop_column("watchlist", "target_dividend_yield")
    op.drop_column("watchlist", "target_pe_percentile")
    op.drop_column("watchlist", "target_price")
    op.drop_column("watchlist", "user_id")
    op.create_primary_key("pk_watchlist", "watchlist", ["code"])

    op.drop_table("alert_deliveries")
    op.drop_table("stock_meta")
    op.drop_index("ix_refresh_tokens_user_id", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_table("users")
