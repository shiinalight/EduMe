"""PostgreSQL access for EduMe, tuned for Supabase's transaction pooler.

Application tables live in the private ``edume_private`` schema, which Supabase's
Data API does not expose. The pooler does not keep session state (such as
``search_path``) between transactions, so every query names its schema.
"""
from __future__ import annotations

import os
from typing import Any

import psycopg
from psycopg.rows import dict_row

SCHEMA = "edume_private"
Row = dict[str, Any]
SSL_MODES = ("disable", "allow", "prefer", "require", "verify-ca", "verify-full")


class DatabaseConfigError(RuntimeError):
    """Raised for missing or invalid database settings; never includes credentials."""


def database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        raise DatabaseConfigError(
            "DATABASE_URL is not set. Add DATABASE_URL=<your Supabase transaction-pooler URI> to .env "
            "(see .env.example), save it, and restart."
        )
    return url


def ssl_mode() -> str:
    mode = os.environ.get("DATABASE_SSLMODE", "require").strip() or "require"
    if mode not in SSL_MODES:
        raise DatabaseConfigError(f"DATABASE_SSLMODE must be one of: {', '.join(SSL_MODES)}.")
    return mode


def connect() -> psycopg.Connection[Row]:
    """Open a connection; use as ``with connect() as db`` (commit on success, rollback on error, then close).

    ``prepare_threshold=None`` disables automatic server-side prepared statements,
    which a transaction pooler cannot route reliably. The SSL mode defaults to
    ``require`` regardless of what the URL says.
    """
    return psycopg.connect(
        database_url(),
        sslmode=ssl_mode(),
        prepare_threshold=None,
        row_factory=dict_row,
        connect_timeout=10,
    )


def redact(message: object) -> str:
    """Remove the configured username and password from text before it is shown."""
    text = str(message)
    _, separator, rest = os.environ.get("DATABASE_URL", "").partition("://")
    userinfo = rest.rpartition("@")[0] if separator else ""
    user, _, password = userinfo.partition(":")
    for secret in (password, user):
        if len(secret) >= 3:
            text = text.replace(secret, "***")
    return text


# Defense in depth for a schema that is already outside the Data API: no row-level
# access for Supabase's API roles even if the schema is ever exposed by mistake.
# The app connects as the table owner (postgres), which is not subject to RLS.
_LOCK_DOWN = f"""
DO $$
DECLARE
    item record;
    role_name text;
BEGIN
    FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = '{SCHEMA}' LOOP
        EXECUTE format('ALTER TABLE {SCHEMA}.%I ENABLE ROW LEVEL SECURITY', item.tablename);
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA {SCHEMA} FROM %I', role_name);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA {SCHEMA} FROM %I', role_name);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA {SCHEMA} FROM %I', role_name);
        END IF;
    END LOOP;
END $$;
"""


def initialize(*table_definitions: str) -> None:
    """Create the private schema and the given tables in one transaction. Safe to re-run."""
    with connect() as db:
        db.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")
        db.execute(f"REVOKE ALL ON SCHEMA {SCHEMA} FROM PUBLIC")
        for definition in table_definitions:
            db.execute(definition)
        db.execute(_LOCK_DOWN)
