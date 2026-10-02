"""Async breadth-first crawler with a per-crawl event bus for the live UI."""
from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any
from urllib import robotparser
from urllib.parse import urlparse

import httpx

from .db import Database
from .parse import extract, is_crawlable

USER_AGENT = os.environ.get("PACHONG_UA", "PachongSpider/0.1 (educational link crawler; +https://github.com/)")
WORKERS = 3
REQUEST_DELAY = 0.6  # seconds between requests per worker
MAX_BYTES = 6 * 1024 * 1024


class UnsafeURL(ValueError):
    pass


def assert_public_url(url: str) -> None:
    """Refuse loopback / private / link-local targets (basic SSRF guard)."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise UnsafeURL("only http(s) URLs are allowed")
    try:
        infos = socket.getaddrinfo(p.hostname, None)
    except socket.gaierror as e:
        raise UnsafeURL(f"cannot resolve host {p.hostname}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise UnsafeURL(f"{p.hostname} resolves to a non-public address")


class EventBus:
    """Fan-out of crawl events to SSE subscribers; keeps a short backlog for late joiners."""

    def __init__(self, backlog: int = 400):
        self._subs: dict[int, set[asyncio.Queue]] = {}
        self._backlog: dict[int, deque] = {}
        self._size = backlog

    def subscribe(self, crawl_id: int) -> tuple[asyncio.Queue, list[dict]]:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs.setdefault(crawl_id, set()).add(q)
        return q, list(self._backlog.get(crawl_id, ()))

    def unsubscribe(self, crawl_id: int, q: asyncio.Queue) -> None:
        self._subs.get(crawl_id, set()).discard(q)

    def publish(self, crawl_id: int, event: dict[str, Any]) -> None:
        event = {"ts": time.time(), **event}
        self._backlog.setdefault(crawl_id, deque(maxlen=self._size)).append(event)
        for q in list(self._subs.get(crawl_id, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # slow consumer: drop rather than stall the crawler


@dataclass
class CrawlJob:
    crawl_id: int
    seed_url: str
    max_pages: int
    max_depth: int
    same_domain: bool
    seed_host: str = ""
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None


class Crawler:
    def __init__(self, db: Database, bus: EventBus, transport: httpx.AsyncBaseTransport | None = None,
                 delay: float = REQUEST_DELAY, check_ssrf: bool = True):
        self.db = db
        self.bus = bus
        self.jobs: dict[int, CrawlJob] = {}
        self._transport = transport
        self._delay = delay
        self._check_ssrf = check_ssrf

    def start(self, seed_url: str, max_pages: int, max_depth: int, same_domain: bool) -> int:
        if self._check_ssrf:
            assert_public_url(seed_url)
        crawl_id = self.db.create_crawl(seed_url, max_pages, max_depth, same_domain)
        job = CrawlJob(crawl_id, seed_url, max_pages, max_depth, same_domain,
                       seed_host=urlparse(seed_url).hostname or "")
        self.jobs[crawl_id] = job
        job.task = asyncio.create_task(self._run(job))
        return crawl_id

    def stop(self, crawl_id: int) -> bool:
        job = self.jobs.get(crawl_id)
        if not job:
            return False
        job.stop.set()
        return True

    async def _robots(self, client: httpx.AsyncClient, url: str) -> robotparser.RobotFileParser:
        rp = robotparser.RobotFileParser()
        p = urlparse(url)
        try:
            r = await client.get(f"{p.scheme}://{p.netloc}/robots.txt")
            rp.parse(r.text.splitlines() if r.status_code == 200 else [])
        except httpx.HTTPError:
            rp.parse([])
        return rp

    async def _run(self, job: CrawlJob) -> None:
        cid = job.crawl_id
        self.db.set_crawl_status(cid, "running")
        self.bus.publish(cid, {"type": "status", "status": "running"})
        frontier: asyncio.Queue = asyncio.Queue()
        seen: set[str] = {job.seed_url}
        frontier.put_nowait((job.seed_url, 0, None, None))  # url, depth, from_page_id, link index
        claimed = 0
        robots: dict[str, robotparser.RobotFileParser] = {}

        async with httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
            follow_redirects=True, timeout=20, transport=self._transport,
        ) as client:

            async def worker(wid: int) -> None:
                nonlocal claimed
                while not job.stop.is_set():
                    try:
                        url, depth, from_page, lid = await asyncio.wait_for(frontier.get(), timeout=1.5)
                    except asyncio.TimeoutError:
                        if all_idle():
                            return
                        continue
                    busy.add(wid)
                    try:
                        if claimed >= job.max_pages:
                            continue
                        host = urlparse(url).netloc
                        if host not in robots:
                            robots[host] = await self._robots(client, url)
                        if not robots[host].can_fetch(USER_AGENT, url):
                            self.bus.publish(cid, {"type": "skip", "url": url, "reason": "robots.txt", "worker": wid})
                            continue
                        claimed += 1
                        self.bus.publish(cid, {"type": "fetching", "url": url, "depth": depth,
                                               "from_page": from_page, "lid": lid, "worker": wid})
                        await self._fetch_one(client, job, url, depth, wid, frontier, seen)
                        await asyncio.sleep(self._delay)
                    finally:
                        busy.discard(wid)
                        frontier.task_done()

            busy: set[int] = set()

            def all_idle() -> bool:
                return frontier.empty() and not busy

            try:
                await asyncio.gather(*(worker(i) for i in range(WORKERS)))
                status = "stopped" if job.stop.is_set() else "done"
                self.db.set_crawl_status(cid, status)
                self.bus.publish(cid, {"type": "status", "status": status})
            except Exception as e:  # pragma: no cover - defensive
                self.db.set_crawl_status(cid, "error", repr(e))
                self.bus.publish(cid, {"type": "status", "status": "error", "error": repr(e)})
            finally:
                self.jobs.pop(cid, None)

    async def _fetch_one(self, client: httpx.AsyncClient, job: CrawlJob, url: str, depth: int, wid: int,
                         frontier: asyncio.Queue, seen: set[str]) -> None:
        cid = job.crawl_id
        try:
            if self._check_ssrf:
                await asyncio.to_thread(assert_public_url, url)
            r = await client.get(url)
            ctype = r.headers.get("content-type", "")
            if "html" not in ctype:
                raise ValueError(f"not html ({ctype or 'unknown'})")
            if len(r.content) > MAX_BYTES:
                raise ValueError("page too large")
            data = await asyncio.to_thread(extract, r.text, str(r.url), job.seed_host)
        except Exception as e:
            page_id = self.db.save_page(cid, url, depth, None, None, None, 0, [], error=str(e)[:500])
            self.bus.publish(cid, {"type": "page_error", "page_id": page_id, "url": url, "error": str(e)[:200], "worker": wid})
            return

        page_id = self.db.save_page(cid, url, depth, r.status_code, data["title"], data["html"],
                                    data["text_len"], data["links"])
        kinds: dict[str, int] = {}
        for l in data["links"]:
            kinds[l["kind"]] = kinds.get(l["kind"], 0) + 1
        self.bus.publish(cid, {"type": "page", "page_id": page_id, "url": url, "title": data["title"],
                               "depth": depth, "links": len(data["links"]), "kinds": kinds, "worker": wid})

        if depth >= job.max_depth:
            return
        for lid, l in enumerate(data["links"]):
            if l["url"] in seen or not is_crawlable(l["url"], l["kind"]):
                continue
            if job.same_domain and not l["internal"]:
                continue
            seen.add(l["url"])
            frontier.put_nowait((l["url"], depth + 1, page_id, lid))
