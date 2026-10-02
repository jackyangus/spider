"""HTML extraction: pick main content, sanitize it, classify links."""
from __future__ import annotations

import re
from urllib.parse import urldefrag, urljoin, urlparse

from bs4 import BeautifulSoup, Comment, Tag

ALLOWED_TAGS = {
    "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "div", "dl", "dt",
    "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd",
    "li", "mark", "ol", "p", "pre", "q", "s", "small", "span", "strong", "sub", "sup", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "section", "article", "main", "time",
}
# Dropped together with everything inside them.
DROP_TAGS = {
    "script", "style", "noscript", "iframe", "object", "embed", "form", "input", "button", "select",
    "textarea", "svg", "math", "link", "meta", "template", "nav", "header", "footer", "aside",
    "video", "audio", "canvas",
}
ALLOWED_ATTRS = {"href", "src", "alt", "title", "colspan", "rowspan", "datetime"}

# Wikipedia (MediaWiki) chrome that is noise for our purposes.
NOISE_SELECTORS = [
    ".mw-editsection", ".reference-accessdate + .reference-accessdate", "#toc", ".toc",
    ".mw-jump-link", ".hatnote", ".shortdescription", ".mw-empty-elt", ".noprint.portal",
    ".sistersitebox", ".metadata.plainlinks",
]
CONTENT_SELECTORS = ["#mw-content-text .mw-parser-output", "main article", "article", "main", "#content", "body"]

SKIP_EXT = re.compile(
    r"\.(?:png|jpe?g|gif|webp|svg|ico|bmp|tiff?|mp[34]|webm|ogg|wav|zip|gz|tar|rar|7z|exe|dmg|css|js|woff2?|ttf)$",
    re.I,
)

# Ordered: first match wins. (kind, url-pattern, anchor-pattern)
KIND_RULES: list[tuple[str, re.Pattern | None, re.Pattern | None]] = [
    ("isbn", re.compile(r"Special:BookSources|isbnsearch|/isbn/", re.I), re.compile(r"^\s*(ISBN\b|97[89][-\d ]{10,})", re.I)),
    ("doi", re.compile(r"doi\.org/", re.I), re.compile(r"^\s*(doi|10\.\d{4,}/)", re.I)),
    ("pmid", re.compile(r"pubmed\.ncbi\.nlm\.nih\.gov/\d+|ncbi\.nlm\.nih\.gov/pubmed", re.I), re.compile(r"^\s*PMID", re.I)),
    ("pmc", re.compile(r"/pmc/articles/|pmc\.ncbi", re.I), re.compile(r"^\s*PMC\s*\d", re.I)),
    ("bibcode", re.compile(r"ui\.adsabs\.harvard\.edu|adsabs\.harvard\.edu", re.I), re.compile(r"^\s*Bibcode", re.I)),
    ("s2cid", re.compile(r"semanticscholar\.org", re.I), re.compile(r"^\s*S2CID", re.I)),
    ("issn", re.compile(r"issn\.org|worldcat\.org/issn|search\.worldcat\.org/search\?q=n2", re.I), re.compile(r"^\s*ISSN", re.I)),
    ("oclc", re.compile(r"worldcat\.org/(oclc|title)", re.I), re.compile(r"^\s*OCLC", re.I)),
    ("jstor", re.compile(r"jstor\.org", re.I), re.compile(r"^\s*JSTOR", re.I)),
    ("archive", re.compile(r"web\.archive\.org|archive\.(org|today|ph|is)", re.I), re.compile(r"^\s*Archived", re.I)),
    ("pdf", re.compile(r"\.pdf(?:$|\?)", re.I), None),
]


def normalize_url(href: str, base: str) -> str | None:
    """Resolve to absolute http(s) URL without fragment, or None if unusable."""
    href = (href or "").strip()
    if not href or href.startswith(("javascript:", "mailto:", "tel:", "data:")):
        return None
    url, _ = urldefrag(urljoin(base, href))
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.netloc:
        return None
    return url


def classify(url: str, anchor: str, seed_host: str) -> tuple[str, bool]:
    host = urlparse(url).hostname or ""
    internal = host == seed_host
    for kind, url_re, anchor_re in KIND_RULES:
        if (url_re and url_re.search(url)) or (anchor_re and anchor_re.search(anchor)):
            return kind, internal
    if internal:
        # MediaWiki namespaces (File:, Help:, Special: ...) are not articles.
        path = urlparse(url).path
        if "/wiki/" in path and ":" in path.split("/wiki/", 1)[1]:
            return "meta", True
        return "page", True
    return "external", False


def is_crawlable(url: str, kind: str) -> bool:
    return kind in ("page", "external") and not SKIP_EXT.search(urlparse(url).path)


def _pick_content(soup: BeautifulSoup) -> Tag:
    for sel in CONTENT_SELECTORS:
        node = soup.select_one(sel)
        if node is not None:
            return node
    return soup


def extract(html: str, page_url: str, seed_host: str) -> dict:
    """Return {title, html, text_len, links:[{url, anchor, kind, internal}]}.

    The returned html is whitelisted (tags+attributes) so the frontend can inject it.
    Each kept <a> carries data-lid = index into links, so the UI can map elements to rows.
    """
    soup = BeautifulSoup(html, "lxml")
    title_el = soup.select_one("h1#firstHeading") or soup.find("title")
    title = title_el.get_text(" ", strip=True) if title_el else page_url

    root = _pick_content(soup)
    for sel in NOISE_SELECTORS:
        for el in root.select(sel):
            el.decompose()
    for c in root.find_all(string=lambda s: isinstance(s, Comment)):
        c.extract()
    for el in root.find_all(list(DROP_TAGS)):
        el.decompose()

    links: list[dict] = []
    for el in list(root.find_all(True)):
        if el.name not in ALLOWED_TAGS:
            el.unwrap()
            continue
        attrs = {}
        for k, v in el.attrs.items():
            if k not in ALLOWED_ATTRS:
                continue
            if isinstance(v, list):
                v = " ".join(v)
            attrs[k] = v
        el.attrs = attrs
        if el.name == "img":
            src = normalize_url(attrs.get("src", ""), page_url)
            if not src:
                el.decompose()
                continue
            el.attrs = {"src": src, "alt": attrs.get("alt", ""), "loading": "lazy"}
        elif el.name == "a":
            url = normalize_url(attrs.get("href", ""), page_url)
            anchor = el.get_text(" ", strip=True)
            if not url or not anchor:
                el.attrs = {}
                el.name = "span"
                continue
            kind, internal = classify(url, anchor, seed_host)
            el.attrs = {"href": url, "data-kind": kind, "target": "_blank", "rel": "noopener noreferrer"}
            # data-lid = position in `links`; the UI maps elements to DB rows with it.
            el["data-lid"] = str(len(links))
            links.append({"url": url, "anchor": anchor[:300], "kind": kind, "internal": internal})

    text_len = len(root.get_text(" ", strip=True))
    return {"title": title, "html": root.decode_contents(), "text_len": text_len, "links": links}
