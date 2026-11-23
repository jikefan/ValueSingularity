from __future__ import annotations

import contextlib
import io
import re
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from app.db import models  # noqa: F401
from app.db.base import Base

API_ROOT = Path(__file__).resolve().parents[1]
CHECK_CONSTRAINT_RE = re.compile(r"CONSTRAINT\s+(ck_[a-z0-9_]+)\s+CHECK")


def _render_offline_sql(direction: str, revision: str) -> str:
    buf = io.StringIO()
    cfg = Config(stdout=buf)
    cfg.set_main_option("script_location", str(API_ROOT / "migrations"))
    with contextlib.redirect_stdout(buf):
        if direction == "upgrade":
            command.upgrade(cfg, revision, sql=True)
        else:
            command.downgrade(cfg, revision, sql=True)
    return buf.getvalue()


def test_0002_check_constraints_match_metadata_without_double_prefix() -> None:
    upgrade_sql = _render_offline_sql("upgrade", "0001:0002")
    emitted_checks = set(CHECK_CONSTRAINT_RE.findall(upgrade_sql))

    expected_checks: set[str] = set()
    for table_name in ("users", "alert_deliveries", "journal"):
        table = Base.metadata.tables[table_name]
        table_checks = {
            c.name
            for c in table.constraints
            if isinstance(c, sa.CheckConstraint) and isinstance(c.name, str)
        }
        assert table_checks
        for name in table_checks:
            assert f"CONSTRAINT {name} CHECK" in upgrade_sql
            assert not name.startswith(f"ck_{table_name}_ck_{table_name}_")
        expected_checks.update(table_checks)

    assert emitted_checks == expected_checks

    downgrade_sql = _render_offline_sql("downgrade", "0002:0001")
    assert "DROP CONSTRAINT ck_journal_action_valid" in downgrade_sql
    assert "ck_journal_ck_journal_action_valid" not in downgrade_sql


def test_0003_check_constraints_match_metadata_without_double_prefix() -> None:
    upgrade_sql = _render_offline_sql("upgrade", "0002:0003")
    emitted_checks = set(CHECK_CONSTRAINT_RE.findall(upgrade_sql))

    table_name = "email_verification_codes"
    table = Base.metadata.tables[table_name]
    expected_checks = {
        c.name
        for c in table.constraints
        if isinstance(c, sa.CheckConstraint) and isinstance(c.name, str)
    }
    assert expected_checks == {"ck_email_verification_codes_purpose_valid"}
    for name in expected_checks:
        assert f"CONSTRAINT {name} CHECK" in upgrade_sql
        assert not name.startswith(f"ck_{table_name}_ck_{table_name}_")

    assert emitted_checks == expected_checks
    assert "ADD COLUMN email_verified_at" in upgrade_sql
    assert "ADD COLUMN token_version" in upgrade_sql
    assert "ADD COLUMN family_id" in upgrade_sql
    assert "ADD COLUMN revoked_reason" in upgrade_sql
    assert "CREATE INDEX ix_refresh_tokens_family_id" in upgrade_sql
    assert "CREATE INDEX ix_email_codes_email_purpose_created" in upgrade_sql

    downgrade_sql = _render_offline_sql("downgrade", "0003:0002")
    assert "DROP INDEX ix_email_codes_email_purpose_created" in downgrade_sql
    assert "DROP TABLE email_verification_codes" in downgrade_sql
    assert "DROP INDEX ix_refresh_tokens_family_id" in downgrade_sql
    assert "DROP COLUMN revoked_reason" in downgrade_sql
    assert "DROP COLUMN family_id" in downgrade_sql
    assert "DROP COLUMN token_version" in downgrade_sql
    assert "DROP COLUMN email_verified_at" in downgrade_sql
