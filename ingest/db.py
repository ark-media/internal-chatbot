"""Postgres connection helpers shared by the ingest modules.

`conn_str` and `connect` were byte-identical in bootstrap.py, review.py and
upsert.py. They are here so the connection policy — autocommit off, so every
caller runs inside a transaction it has to commit — is stated once.
"""

from __future__ import annotations

import os

import psycopg


def conn_str() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url


def connect() -> psycopg.Connection:
    """Open a connection with autocommit OFF.

    Ingest work is batch: a partially-applied episode is worse than none, so
    callers commit explicitly once a unit of work is complete.
    """
    return psycopg.connect(conn_str(), autocommit=False)
