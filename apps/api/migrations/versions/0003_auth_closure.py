"""auth closure: user email verification, token version, and verification codes

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("email_verified_at", sa.DateTime(timezone=True)))
    op.add_column(
        "users",
        sa.Column("token_version", sa.Integer(), server_default="1", nullable=False),
    )

    op.add_column("refresh_tokens", sa.Column("family_id", sa.Uuid(as_uuid=True), nullable=True))
    op.execute("UPDATE refresh_tokens SET family_id = id WHERE family_id IS NULL")
    op.alter_column(
        "refresh_tokens",
        "family_id",
        existing_type=sa.Uuid(as_uuid=True),
        nullable=False,
    )
    op.add_column("refresh_tokens", sa.Column("revoked_reason", sa.String(32)))
    op.create_index("ix_refresh_tokens_family_id", "refresh_tokens", ["family_id"])

    op.create_table(
        "email_verification_codes",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("attempt_count", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_email_verification_codes"),
        sa.CheckConstraint(
            "purpose IN ('register', 'reset_password', 'verify_email', 'delete_account')",
            name="purpose_valid",
        ),
    )
    op.create_index(
        "ix_email_codes_email_purpose_created",
        "email_verification_codes",
        ["email", "purpose", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_email_codes_email_purpose_created", table_name="email_verification_codes")
    op.drop_table("email_verification_codes")
    op.drop_index("ix_refresh_tokens_family_id", table_name="refresh_tokens")
    op.drop_column("refresh_tokens", "revoked_reason")
    op.drop_column("refresh_tokens", "family_id")
    op.drop_column("users", "token_version")
    op.drop_column("users", "email_verified_at")
