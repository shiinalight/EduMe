"""Create or update EduMe's tables in PostgreSQL. Safe to re-run.

    python init_db.py           # create the private schema and tables
    python init_db.py --check   # only test the connection; changes nothing

Loads DATABASE_URL from .env (next to this file) unless it is already set in the
environment. The app itself never creates tables.
"""
from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv


def run(argv: list[str]) -> int:
    load_dotenv(Path(__file__).with_name(".env"))
    import psycopg

    import database

    try:
        if "--check" in argv:
            with database.connect() as db:
                db.execute("SELECT 1")
                print(f"Connected to PostgreSQL. SSL in use: {db.pgconn.ssl_in_use}. No changes made.")
            return 0
        from main import initialize_database

        initialize_database()
        with database.connect() as db:
            tables = db.execute(
                "SELECT count(*) AS n FROM pg_tables WHERE schemaname = %s", (database.SCHEMA,)
            ).fetchone()["n"]
        print(f"Database ready: {tables} tables in the private '{database.SCHEMA}' schema.")
        return 0
    except (database.DatabaseConfigError, psycopg.Error) as error:
        print(f"Database error ({type(error).__name__}): {database.redact(error).strip()}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
