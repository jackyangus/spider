"""SQLite storage for crawls, pages and links."""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS crawls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    seed_url    TEXT    NOT NULL,
    max_pages   INTEGER NOT NULL,
    max_depth   INTEGER NOT NULL,
    same_domain INTEGER NOT NULL DEFAULT 1,
    status      TEXT    NOT NULL DEFAULT 'queued',   -- queued|running|done|stopped|error
    pages_done  INTEGER NOT NULL DEFAULT 0,
    links_found INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  REAL    NOT NULL,
    finished_at REAL
);

CREATE TABLE IF NOT EXISTS pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    crawl_id    INTEGER NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
    url         TEXT    NOT NULL,
    title       TEXT,
    depth       INTEGER NOT NULL,
    status_code INTEGER,
    html        TEXT,
    text_len    INTEGER NOT NULL DEFAULT 0,
    link_count  INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    fetched_at  REAL    NOT NULL,
    UNIQUE (crawl_id, url)
);

CREATE TABLE IF NOT EXISTS links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    crawl_id    INTEGER NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
    page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    url         TEXT    NOT NULL,
    anchor      TEXT,
    kind        TEXT    NOT NULL,
    internal    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_crawl ON pages(crawl_id);
CREATE INDEX IF NOT EXISTS idx_links_crawl_kind ON links(crawl_id, kind);
CREATE INDEX IF NOT EXISTS idx_links_page ON links(page_id);
"""


class Database:
    """Thin thread-safe wrapper around one sqlite3 connection."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)
            # A server restart kills in-flight crawls; don't leave them "running" forever.
            self._conn.execute(
                "UPDATE crawls SET status='stopped', finished_at=? WHERE status IN ('queued','running')",
                (time.time(),),
            )
            self._conn.commit()

    def execute(self, sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def executemany(self, sql: str, rows: list[tuple]) -> None:
        with self._lock:
            self._conn.executemany(sql, rows)
            self._conn.commit()

    def one(self, sql: str, params: tuple | dict = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, params: tuple | dict = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    # ---- domain helpers -------------------------------------------------

    def create_crawl(self, seed_url: str, max_pages: int, max_depth: int, same_domain: bool) -> int:
        cur = self.execute(
            "INSERT INTO crawls (seed_url, max_pages, max_depth, same_domain, created_at) VALUES (?,?,?,?,?)",
            (seed_url, max_pages, max_depth, int(same_domain), time.time()),
        )
        return int(cur.lastrowid)

    def set_crawl_status(self, crawl_id: int, status: str, error: str | None = None) -> None:
        finished = time.time() if status in ("done", "stopped", "error") else None
        self.execute(
            "UPDATE crawls SET status=?, error=COALESCE(?, error), finished_at=COALESCE(?, finished_at) WHERE id=?",
            (status, error, finished, crawl_id),
        )

    def save_page(
        self,
        crawl_id: int,
        url: str,
        depth: int,
        status_code: int | None,
        title: str | None,
        html: str | None,
        text_len: int,
        links: list[dict[str, Any]],
        error: str | None = None,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                "INSERT OR IGNORE INTO pages (crawl_id, url, title, depth, status_code, html, text_len, link_count, error, fetched_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (crawl_id, url, title, depth, status_code, html, text_len, len(links), error, time.time()),
            )
            page_id = cur.lastrowid
            if not cur.rowcount:
                row = self._conn.execute(
                    "SELECT id FROM pages WHERE crawl_id=? AND url=?", (crawl_id, url)
                ).fetchone()
                self._conn.commit()
                return int(row["id"])
            self._conn.executemany(
                "INSERT INTO links (crawl_id, page_id, url, anchor, kind, internal) VALUES (?,?,?,?,?,?)",
                [(crawl_id, page_id, l["url"], l["anchor"], l["kind"], int(l["internal"])) for l in links],
            )
            self._conn.execute(
                "UPDATE crawls SET pages_done=pages_done+1, links_found=links_found+? WHERE id=?",
                (len(links), crawl_id),
            )
            self._conn.commit()
            return int(page_id)
