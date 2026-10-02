import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app.crawler import Crawler, EventBus, UnsafeURL, assert_public_url
from backend.app.db import Database
from backend.app.main import create_app
from backend.app.parse import classify, extract

SEED = "https://wiki.test/wiki/Spider"

PAGES = {
    "/wiki/Spider": """
      <html><head><title>Spider - Wiki</title><script>alert(1)</script></head><body>
      <h1 id="firstHeading">Spider</h1>
      <div id="mw-content-text"><div class="mw-parser-output">
        <p onclick="evil()" style="color:red">Spiders are <a href="/wiki/Arachnid">arachnids</a>.</p>
        <p><a href="/wiki/Silk#x">silk</a> <a href="javascript:alert(1)">bad</a>
           <a href="https://doi.org/10.1/abc">doi:10.1/abc</a>
           <a href="/wiki/Special:BookSources/978-0-521">978-0-521</a>
           <a href="https://pubmed.ncbi.nlm.nih.gov/123/">123</a>
           <a href="/wiki/File:Spider.jpg">file</a>
           <img src="//img.test/a.png" onerror="x()"></p>
        <iframe src="https://evil.test"></iframe>
      </div></div></body></html>""",
    "/wiki/Arachnid": """<html><body><h1 id="firstHeading">Arachnid</h1><div id="mw-content-text"><div class="mw-parser-output">
        <p><a href="/wiki/Spider">back</a> <a href="/wiki/Scorpion">scorpion</a></p></div></div></body></html>""",
    "/wiki/Silk": """<html><body><h1 id="firstHeading">Silk</h1><p>no links</p></body></html>""",
    "/wiki/Scorpion": """<html><body><h1 id="firstHeading">Scorpion</h1></body></html>""",
}


def handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/robots.txt":
        return httpx.Response(200, text="User-agent: *\nDisallow: /private/")
    body = PAGES.get(request.url.path)
    if body is None:
        return httpx.Response(404, text="nope", headers={"content-type": "text/plain"})
    return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})


def test_extract_sanitizes_and_classifies():
    d = extract(PAGES["/wiki/Spider"], SEED, "wiki.test")
    assert d["title"] == "Spider"
    html = d["html"]
    for bad in ("<script", "onclick", "onerror", "style=", "<iframe", "javascript:", "class="):
        assert bad not in html
    kinds = {l["url"]: l["kind"] for l in d["links"]}
    assert kinds["https://wiki.test/wiki/Arachnid"] == "page"
    assert kinds["https://wiki.test/wiki/Silk"] == "page"  # fragment stripped
    assert kinds["https://doi.org/10.1/abc"] == "doi"
    assert kinds["https://wiki.test/wiki/Special:BookSources/978-0-521"] == "isbn"
    assert kinds["https://pubmed.ncbi.nlm.nih.gov/123/"] == "pmid"
    assert kinds["https://wiki.test/wiki/File:Spider.jpg"] == "meta"
    # every recorded link is tagged in the html with its index
    for i in range(len(d["links"])):
        assert f'data-lid="{i}"' in html
    assert 'src="https://img.test/a.png"' in html


@pytest.mark.parametrize("url,anchor,kind", [
    ("https://ui.adsabs.harvard.edu/abs/2011", "2011BiLet", "bibcode"),
    ("https://www.jstor.org/stable/1", "1", "jstor"),
    ("https://web.archive.org/web/2009/x", "Archived", "archive"),
    ("https://example.org/paper.pdf", "paper", "pdf"),
    ("https://example.org/", "home", "external"),
])
def test_classify(url, anchor, kind):
    assert classify(url, anchor, "wiki.test")[0] == kind


def test_ssrf_guard():
    for url in ("http://127.0.0.1/", "http://localhost:8000/", "http://10.0.0.1/", "file:///etc/passwd"):
        with pytest.raises(UnsafeURL):
            assert_public_url(url)


async def _crawl(max_pages: int, max_depth: int):
    db = Database(":memory:")
    bus = EventBus()
    crawler = Crawler(db, bus, transport=httpx.MockTransport(handler), delay=0, check_ssrf=False)
    cid = crawler.start(SEED, max_pages, max_depth, True)
    q, _ = bus.subscribe(cid)
    await asyncio.wait_for(crawler.jobs[cid].task, timeout=20)
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    return db, cid, events


def test_crawl_bfs_respects_limits():
    db, cid, events = asyncio.run(_crawl(max_pages=10, max_depth=1))
    crawl = db.one("SELECT * FROM crawls WHERE id=?", (cid,))
    assert crawl["status"] == "done"
    urls = {p["url"] for p in db.all("SELECT url FROM pages WHERE crawl_id=?", (cid,))}
    # depth 1: seed + its internal article links; Scorpion is depth 2; File: page is not crawled
    assert urls == {SEED, "https://wiki.test/wiki/Arachnid", "https://wiki.test/wiki/Silk"}
    assert crawl["pages_done"] == 3
    types = [e["type"] for e in events]
    assert types.count("page") == 3 and types[-1] == "status"
    fetch = [e for e in events if e["type"] == "fetching" and e["from_page"]]
    assert all(isinstance(e["lid"], int) for e in fetch)


def test_crawl_max_pages():
    db, cid, _ = asyncio.run(_crawl(max_pages=2, max_depth=5))
    assert db.one("SELECT pages_done FROM crawls WHERE id=?", (cid,))["pages_done"] == 2


def test_api_flow():
    db = Database(":memory:")
    crawler = Crawler(db, EventBus(), transport=httpx.MockTransport(handler), delay=0, check_ssrf=False)
    app = create_app(db=db, crawler=crawler)
    with TestClient(app) as client:
        r = client.post("/api/crawls", json={"seed_url": SEED, "max_pages": 5, "max_depth": 2})
        assert r.status_code == 201
        cid = r.json()["id"]
        for _ in range(100):
            if client.get(f"/api/crawls/{cid}").json()["status"] == "done":
                break
            asyncio.run(asyncio.sleep(0.05))
        crawl = client.get(f"/api/crawls/{cid}").json()
        assert crawl["status"] == "done" and crawl["pages_done"] == 4
        assert crawl["kinds"]["doi"] == 1

        pages = client.get(f"/api/crawls/{cid}/pages").json()
        seed = next(p for p in pages if p["url"] == SEED)
        page = client.get(f"/api/pages/{seed['id']}").json()
        assert page["links"][0]["url"] == "https://wiki.test/wiki/Arachnid"
        assert page["links"][0]["page_id"] is not None  # crawled -> clickable in UI

        links = client.get(f"/api/crawls/{cid}/links", params={"kind": "page"}).json()
        assert links["total"] >= 3
        spider = next(l for l in links["items"] if l["url"] == SEED)
        assert spider["refs"] == 1 and spider["anchor"] == "back"

        csv_text = client.get(f"/api/crawls/{cid}/export", params={"fmt": "csv", "kind": "doi"}).text
        assert csv_text.splitlines()[0] == "url,anchor,kind,internal,found_on"
        assert "doi.org/10.1/abc" in csv_text
        data = json.loads(client.get(f"/api/crawls/{cid}/export", params={"fmt": "json"}).text)
        assert len(data) == crawl["links_found"]

        assert client.post("/api/crawls", json={"seed_url": "not a url"}).status_code == 422
        assert client.post(f"/api/crawls/{cid}/stop").status_code == 409
        assert client.delete(f"/api/crawls/{cid}").status_code == 204
        assert client.get(f"/api/crawls/{cid}").status_code == 404
