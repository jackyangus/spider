"""FastAPI app: REST + SSE API for the crawler, and static hosting for the frontend."""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, HttpUrl

from .crawler import Crawler, EventBus, UnsafeURL
from .db import Database

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
DB_PATH = os.environ.get("PACHONG_DB", str(ROOT / "data" / "pachong.db"))


class CrawlIn(BaseModel):
    seed_url: HttpUrl
    max_pages: int = Field(30, ge=1, le=2000)
    max_depth: int = Field(2, ge=0, le=10)
    same_domain: bool = True


def create_app(db: Database | None = None, crawler: Crawler | None = None) -> FastAPI:
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state["db"] = db or Database(DB_PATH)
        state["bus"] = crawler.bus if crawler else EventBus()
        state["crawler"] = crawler or Crawler(state["db"], state["bus"])
        yield
        for job in list(state["crawler"].jobs.values()):
            job.stop.set()

    app = FastAPI(title="Pachong Spider", lifespan=lifespan)

    def _db() -> Database:
        return state["db"]

    @app.post("/api/crawls", status_code=201)
    async def create_crawl(body: CrawlIn):
        try:
            cid = state["crawler"].start(str(body.seed_url), body.max_pages, body.max_depth, body.same_domain)
        except UnsafeURL as e:
            raise HTTPException(400, str(e))
        return _db().one("SELECT * FROM crawls WHERE id=?", (cid,))

    @app.get("/api/crawls")
    def list_crawls(limit: int = Query(50, ge=1, le=500)):
        return _db().all("SELECT * FROM crawls ORDER BY id DESC LIMIT ?", (limit,))

    @app.get("/api/crawls/{cid}")
    def get_crawl(cid: int):
        crawl = _db().one("SELECT * FROM crawls WHERE id=?", (cid,))
        if not crawl:
            raise HTTPException(404, "crawl not found")
        crawl["kinds"] = {r["kind"]: r["n"] for r in _db().all(
            "SELECT kind, COUNT(*) n FROM links WHERE crawl_id=? GROUP BY kind ORDER BY n DESC", (cid,))}
        return crawl

    @app.post("/api/crawls/{cid}/stop")
    def stop_crawl(cid: int):
        if not state["crawler"].stop(cid):
            raise HTTPException(409, "crawl is not running")
        return {"ok": True}

    @app.delete("/api/crawls/{cid}", status_code=204)
    def delete_crawl(cid: int):
        state["crawler"].stop(cid)
        _db().execute("DELETE FROM crawls WHERE id=?", (cid,))

    @app.get("/api/crawls/{cid}/pages")
    def list_pages(cid: int):
        return _db().all(
            "SELECT id, url, title, depth, status_code, text_len, link_count, error, fetched_at"
            " FROM pages WHERE crawl_id=? ORDER BY id", (cid,))

    @app.get("/api/pages/{pid}")
    def get_page(pid: int):
        page = _db().one("SELECT * FROM pages WHERE id=?", (pid,))
        if not page:
            raise HTTPException(404, "page not found")
        # Index i of this list == data-lid i in page.html
        page["links"] = _db().all("SELECT id, url, anchor, kind, internal FROM links WHERE page_id=? ORDER BY id", (pid,))
        crawled = {r["url"]: r["id"] for r in _db().all(
            "SELECT id, url FROM pages WHERE crawl_id=? AND html IS NOT NULL", (page["crawl_id"],))}
        for l in page["links"]:
            l["page_id"] = crawled.get(l["url"])
        return page

    def _link_filter(cid: int, kind: str | None, q: str | None) -> tuple[str, list]:
        where, params = ["l.crawl_id=?"], [cid]
        if kind:
            where.append("l.kind=?")
            params.append(kind)
        if q:
            where.append("(l.url LIKE ? OR l.anchor LIKE ?)")
            params += [f"%{q}%", f"%{q}%"]
        return " AND ".join(where), params

    @app.get("/api/crawls/{cid}/links")
    def list_links(cid: int, kind: str | None = None, q: str | None = None, distinct: bool = True,
                   limit: int = Query(100, ge=1, le=1000), offset: int = Query(0, ge=0)):
        where, params = _link_filter(cid, kind, q)
        if distinct:
            base = (f"SELECT l.url, l.anchor anchor, MAX(LENGTH(l.anchor)) _alen, l.kind, l.internal, COUNT(*) refs, MIN(p.url) found_on"
                    f" FROM links l JOIN pages p ON p.id=l.page_id WHERE {where} GROUP BY l.url, l.kind")
        else:
            base = (f"SELECT l.url, l.anchor, l.kind, l.internal, 1 refs, p.url found_on"
                    f" FROM links l JOIN pages p ON p.id=l.page_id WHERE {where}")
        total = _db().one(f"SELECT COUNT(*) n FROM ({base})", tuple(params))["n"]
        rows = _db().all(f"{base} ORDER BY refs DESC, l.url LIMIT ? OFFSET ?", tuple(params + [limit, offset]))
        return {"total": total, "items": rows}

    @app.get("/api/crawls/{cid}/export")
    def export_links(cid: int, fmt: str = Query("csv", pattern="^(csv|json)$"), kind: str | None = None):
        where, params = _link_filter(cid, kind, None)
        rows = _db().all(
            f"SELECT l.url, l.anchor, l.kind, l.internal, p.url found_on FROM links l"
            f" JOIN pages p ON p.id=l.page_id WHERE {where} ORDER BY l.id", tuple(params))
        name = f"crawl-{cid}-links{'-' + kind if kind else ''}"
        if fmt == "json":
            return StreamingResponse(iter([json.dumps(rows, ensure_ascii=False, indent=1)]),
                                     media_type="application/json",
                                     headers={"Content-Disposition": f'attachment; filename="{name}.json"'})
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=["url", "anchor", "kind", "internal", "found_on"])
        w.writeheader()
        w.writerows(rows)
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})

    @app.get("/api/crawls/{cid}/events")
    async def events(cid: int, request: Request):
        bus: EventBus = state["bus"]
        q, backlog = bus.subscribe(cid)

        async def stream():
            try:
                for ev in backlog:
                    yield f"data: {json.dumps(ev)}\n\n"
                while not await request.is_disconnected():
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"data: {json.dumps(ev)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
            finally:
                bus.unsubscribe(cid, q)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    if FRONTEND.exists():
        app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

        @app.get("/", response_class=HTMLResponse)
        def index():
            return FileResponse(FRONTEND / "index.html")

    return app


app = create_app()
