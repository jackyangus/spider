/* In-browser crawler: fetch → sanitize → classify links → BFS.
 *
 * Browsers can only read cross-origin pages that send CORS headers, so:
 *  - MediaWiki sites (Wikipedia & sister projects) go through their api.php with origin=*.
 *  - Anything else is fetched directly (works only if the site allows CORS),
 *    or through an optional user-supplied CORS proxy template like "https://proxy.example/?url={url}".
 *
 * Output format mirrors the Python backend: links[i] <-> <a data-lid="i"> in page.html.
 */
(function () {
  "use strict";

  const ALLOWED_TAGS = new Set([
    "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "div", "dl", "dt",
    "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd",
    "li", "mark", "ol", "p", "pre", "q", "s", "small", "span", "strong", "sub", "sup", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "section", "article", "main", "time",
  ]);
  const DROP_TAGS = [
    "script", "style", "noscript", "iframe", "object", "embed", "form", "input", "button", "select",
    "textarea", "svg", "math", "link", "meta", "template", "nav", "header", "footer", "aside",
    "video", "audio", "canvas", "base",
  ];
  const ALLOWED_ATTRS = new Set(["href", "src", "alt", "title", "colspan", "rowspan", "datetime"]);
  const NOISE_SELECTORS = [
    ".mw-editsection", "#toc", ".toc", ".mw-jump-link", ".hatnote", ".shortdescription",
    ".mw-empty-elt", ".noprint.portal", ".sistersitebox", ".metadata.plainlinks",
  ];
  const CONTENT_SELECTORS = ["#mw-content-text .mw-parser-output", ".mw-parser-output", "main article", "article", "main", "#content", "body"];
  const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|tiff?|mp[34]|webm|ogg|wav|zip|gz|tar|rar|7z|exe|dmg|css|js|woff2?|ttf)$/i;

  // Ordered: first match wins. [kind, url regex, anchor regex]
  const KIND_RULES = [
    ["isbn", /Special:BookSources|isbnsearch|\/isbn\//i, /^\s*(ISBN\b|97[89][-\d ]{10,})/i],
    ["doi", /doi\.org\//i, /^\s*(doi|10\.\d{4,}\/)/i],
    ["pmid", /pubmed\.ncbi\.nlm\.nih\.gov\/\d+|ncbi\.nlm\.nih\.gov\/pubmed/i, /^\s*PMID/i],
    ["pmc", /\/pmc\/articles\/|pmc\.ncbi/i, /^\s*PMC\s*\d/i],
    ["bibcode", /adsabs\.harvard\.edu/i, /^\s*Bibcode/i],
    ["s2cid", /semanticscholar\.org/i, /^\s*S2CID/i],
    ["issn", /issn\.org|worldcat\.org\/issn|search\.worldcat\.org\/search\?q=n2/i, /^\s*ISSN/i],
    ["oclc", /worldcat\.org\/(oclc|title)/i, /^\s*OCLC/i],
    ["jstor", /jstor\.org/i, /^\s*JSTOR/i],
    ["archive", /web\.archive\.org|archive\.(org|today|ph|is)/i, /^\s*Archived/i],
    ["pdf", /\.pdf(?:$|\?)/i, null],
  ];
  const KINDS = ["page", "external", "meta", ...KIND_RULES.map((r) => r[0])];

  const WIKI_HOST = /(^|\.)(wikipedia|wiktionary|wikiquote|wikibooks|wikivoyage|wikisource|wikinews|wikiversity|wikimedia|mediawiki|wikidata|wikifunctions)\.org$/i;

  function normalizeUrl(href, base) {
    href = (href || "").trim();
    if (!href || /^(javascript|mailto|tel|data):/i.test(href)) return null;
    let u;
    try { u = new URL(href, base); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  }

  function classify(url, anchor, seedHost) {
    const u = new URL(url);
    const internal = u.hostname === seedHost;
    for (const [kind, urlRe, anchorRe] of KIND_RULES) {
      if ((urlRe && urlRe.test(url)) || (anchorRe && anchorRe.test(anchor))) return [kind, internal];
    }
    if (internal) {
      // MediaWiki namespaces (File:, Help:, Special: …) and /w/index.php actions are not articles.
      if (u.pathname.startsWith("/w/")) return ["meta", true];
      const i = u.pathname.indexOf("/wiki/");
      if (i >= 0 && decodeURIComponent(u.pathname.slice(i + 6)).includes(":")) return ["meta", true];
      return ["page", true];
    }
    return ["external", false];
  }

  function isCrawlable(url, kind) {
    return (kind === "page" || kind === "external") && !SKIP_EXT.test(new URL(url).pathname);
  }

  /** Sanitize + extract (wholeBody: skip main-content detection, e.g. re-sanitizing saved HTML). Returns {title, html, text_len, links:[{url, anchor, kind, internal}]} */
  function extract(html, pageUrl, seedHost, fallbackTitle, { wholeBody = false } = {}) {
    const doc = new DOMParser().parseFromString(html, "text/html"); // inert: no scripts run, no loads
    const titleEl = doc.querySelector("h1#firstHeading") || doc.querySelector("title");
    const title = fallbackTitle || (titleEl ? titleEl.textContent.trim() : "") || pageUrl;

    let root = null;
    if (!wholeBody) for (const sel of CONTENT_SELECTORS) if ((root = doc.querySelector(sel))) break;
    root = root || doc.body;
    for (const sel of NOISE_SELECTORS) root.querySelectorAll(sel).forEach((el) => el.remove());
    root.querySelectorAll(DROP_TAGS.join(",")).forEach((el) => el.remove());
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((c) => c.remove());

    const links = [];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        el.replaceWith(...el.childNodes);
        continue;
      }
      const keep = {};
      for (const a of Array.from(el.attributes)) {
        if (ALLOWED_ATTRS.has(a.name)) keep[a.name] = a.value;
        el.removeAttribute(a.name);
      }
      if (tag === "img") {
        const src = normalizeUrl(keep.src, pageUrl);
        if (!src) { el.remove(); continue; }
        el.setAttribute("src", src);
        el.setAttribute("alt", keep.alt || "");
        el.setAttribute("loading", "lazy");
        el.setAttribute("referrerpolicy", "no-referrer");
      } else if (tag === "a") {
        const url = normalizeUrl(keep.href, pageUrl);
        const anchor = el.textContent.replace(/\s+/g, " ").trim();
        if (!url || !anchor) {
          const span = doc.createElement("span");
          span.append(...el.childNodes);
          el.replaceWith(span);
          continue;
        }
        const [kind, internal] = classify(url, anchor, seedHost);
        el.setAttribute("href", url);
        el.setAttribute("data-kind", kind);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
        el.setAttribute("data-lid", String(links.length));
        links.push({ url, anchor: anchor.slice(0, 300), kind, internal });
      } else {
        for (const k of ["title", "colspan", "rowspan", "datetime", "alt"]) if (k in keep) el.setAttribute(k, keep[k]);
      }
    }
    return { title, html: root.innerHTML, text_len: root.textContent.replace(/\s+/g, " ").trim().length, links };
  }

  // ---------- fetching ----------

  function wikiTarget(url) {
    const u = new URL(url);
    if (!WIKI_HOST.test(u.hostname) || !u.pathname.startsWith("/wiki/")) return null;
    return { origin: u.origin, title: decodeURIComponent(u.pathname.slice(6)) };
  }

  async function fetchText(url, proxy, signal) {
    const target = proxy ? proxy.replace("{url}", encodeURIComponent(url)) : url;
    let res;
    try {
      res = await fetch(target, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error(proxy ? "代理请求失败" : "跨域被拒（该站点不允许 CORS，可在设置里配置代理）");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = res.headers.get("content-type") || "";
    if (ctype && !/html|text\/plain/i.test(ctype)) throw new Error(`不是 HTML (${ctype})`);
    const text = await res.text();
    if (text.length > 6e6) throw new Error("页面过大");
    return text;
  }

  /** Returns {url (canonical), title, html (raw)} */
  async function fetchPage(url, { proxy, signal }) {
    const wiki = wikiTarget(url);
    if (wiki) {
      const api = `${wiki.origin}/w/api.php?` + new URLSearchParams({
        action: "parse", page: wiki.title, prop: "text|displaytitle", format: "json",
        formatversion: "2", redirects: "1", disableeditsection: "1", disabletoc: "1", origin: "*",
      });
      const res = await fetch(api, { signal, credentials: "omit" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error.info || j.error.code);
      const title = j.parse.title;
      return {
        url: `${wiki.origin}/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":")}`,
        title,
        html: j.parse.text,
      };
    }
    return { url, title: null, html: await fetchText(url, proxy, signal) };
  }

  // Minimal robots.txt support for non-wiki sites ("User-agent: *" group, Disallow prefixes).
  async function loadRobots(origin, proxy, signal) {
    try {
      const txt = await fetchText(origin + "/robots.txt", proxy, signal);
      const rules = [];
      let applies = false;
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, "").trim();
        const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase(), val = m[2].trim();
        if (key === "user-agent") applies = val === "*";
        else if (applies && key === "disallow" && val) rules.push(val);
      }
      return (path) => !rules.some((r) => path.startsWith(r));
    } catch {
      return () => true;
    }
  }

  const sleep = (ms, signal) => new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

  class BrowserCrawler {
    /** opts: {workers, delay, proxy, onEvent(ev)} */
    constructor(opts) {
      this.opts = { workers: 3, delay: 700, proxy: "", onEvent: () => {}, ...opts };
      this.abort = null;
    }

    get running() { return !!this.abort; }

    stop() { this.abort?.abort(); }

    /** Mutates and returns `crawl` (the JSON document) while it runs. */
    async run(crawl) {
      const { workers, delay, proxy } = this.opts;
      const emit = (ev) => this.opts.onEvent({ ts: Date.now() / 1000, ...ev });
      const ac = new AbortController();
      this.abort = ac;
      const signal = ac.signal;

      const seedHost = new URL(crawl.seed_url).hostname;
      const seen = new Set([crawl.seed_url, ...crawl.pages.map((p) => p.url)]);
      const frontier = [{ url: crawl.seed_url, depth: 0, from_page: null, lid: null }];
      const robots = new Map();
      let claimed = 0, busy = 0;
      let nextId = crawl.pages.reduce((m, p) => Math.max(m, p.id), 0) + 1;

      crawl.status = "running";
      emit({ type: "status", status: "running" });

      const savePage = (page) => {
        crawl.pages.push(page);
        crawl.pages_done = crawl.pages.filter((p) => !p.error).length;
        crawl.links_found = crawl.pages.reduce((n, p) => n + p.links.length, 0);
      };

      const worker = async (wid) => {
        while (!signal.aborted) {
          const job = frontier.shift();
          if (!job) {
            if (busy === 0) return;
            await sleep(150, signal);
            continue;
          }
          if (claimed >= crawl.max_pages) { frontier.length = 0; continue; }
          busy++;
          try {
            const u = new URL(job.url);
            if (!wikiTarget(job.url)) {
              if (!robots.has(u.origin)) robots.set(u.origin, loadRobots(u.origin, proxy, signal));
              if (!(await robots.get(u.origin))(u.pathname)) {
                emit({ type: "skip", url: job.url, reason: "robots.txt", worker: wid });
                continue;
              }
            }
            claimed++;
            emit({ type: "fetching", url: job.url, depth: job.depth, from_page: job.from_page, lid: job.lid, worker: wid });
            const id = nextId++;
            try {
              const got = await fetchPage(job.url, { proxy, signal });
              seen.add(got.url);
              const data = extract(got.html, got.url, seedHost, got.title);
              const page = { id, url: got.url, requested_url: job.url !== got.url ? job.url : undefined,
                             title: data.title, depth: job.depth, html: data.html, text_len: data.text_len,
                             links: data.links, error: null, fetched_at: Date.now() / 1000 };
              savePage(page);
              const kinds = {};
              for (const l of data.links) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
              emit({ type: "page", page_id: id, url: got.url, requested_url: job.url, title: data.title,
                     depth: job.depth, links: data.links.length, kinds, worker: wid });
              if (job.depth < crawl.max_depth) {
                data.links.forEach((l, lid) => {
                  if (seen.has(l.url) || !isCrawlable(l.url, l.kind)) return;
                  if (crawl.same_domain && !l.internal) return;
                  seen.add(l.url);
                  frontier.push({ url: l.url, depth: job.depth + 1, from_page: id, lid });
                });
              }
            } catch (e) {
              if (e.name === "AbortError") return;
              savePage({ id, url: job.url, title: null, depth: job.depth, html: null, text_len: 0, links: [],
                         error: String(e.message || e).slice(0, 300), fetched_at: Date.now() / 1000 });
              emit({ type: "page_error", page_id: id, url: job.url, error: String(e.message || e).slice(0, 200), worker: wid });
            }
            await sleep(delay, signal);
          } finally {
            busy--;
          }
        }
      };

      try {
        await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
        crawl.status = signal.aborted ? "stopped" : "done";
      } catch (e) {
        crawl.status = "error";
        crawl.error = String(e);
      } finally {
        crawl.finished_at = Date.now() / 1000;
        this.abort = null;
      }
      emit({ type: "status", status: crawl.status, error: crawl.error });
      return crawl;
    }
  }

  function newCrawl({ seed_url, max_pages, max_depth, same_domain }) {
    return {
      app: "pachong-spider", version: 1,
      id: Date.now(), seed_url, max_pages, max_depth, same_domain,
      status: "queued", pages_done: 0, links_found: 0, error: null,
      created_at: Date.now() / 1000, finished_at: null, pages: [],
    };
  }

  window.PachongCrawler = { BrowserCrawler, newCrawl, extract, classify, normalizeUrl, isCrawlable, wikiTarget, KINDS };
})();
