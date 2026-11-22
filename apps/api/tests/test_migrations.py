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
