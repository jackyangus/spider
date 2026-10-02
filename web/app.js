(function () {
  "use strict";

  const { BrowserCrawler, newCrawl } = window.PachongCrawler;
  const Store = window.PachongStore;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (u) => { try { const x = new URL(u); return decodeURIComponent(x.pathname + x.search).slice(0, 80) || x.host; } catch { return u; } };

  const SETTINGS_KEY = "pachong.settings";
  const state = {
    crawls: [],        // metadata list
    crawl: null,       // full JSON document of the selected crawl
    pageId: null,
    crawler: null,     // BrowserCrawler while running
    runningId: null,
    view: "spider",
    kind: null,
    q: "",
    offset: 0,
    limit: 50,
    distinct: null,    // cached aggregated links for data view
  };

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 4500);
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- settings (per-viewer, localStorage) ----------
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (s.proxy) $("#proxy").value = s.proxy;
      if (s.workers) $("#workers").value = s.workers;
      if (s.delay) $("#delay").value = s.delay;
    } catch {}
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ proxy: $("#proxy").value.trim(), workers: $("#workers").value, delay: $("#delay").value }));
    } catch {}
  }

  // ---------- spider world ----------
  const world = new SpiderWorld({
    stage: $("#stage"),
    page: $("#page"),
    canvas: $("#canvas"),
    onEat: (n) => { $("#sEaten").textContent = n; },
    onOpenPage: (id) => openPage(id),
  });

  // ---------- crawls ----------
  async function loadCrawls() {
    state.crawls = await Store.list();
    renderCrawls();
  }

  function renderCrawls() {
    const cur = state.crawl?.id;
    $("#crawlList").innerHTML = state.crawls.map((c) => {
      const live = c.id === cur ? state.crawl : c;
      return `
      <li data-id="${c.id}" class="${c.id === cur ? "active" : ""}">
        <span class="row"><span class="t" title="${esc(c.seed_url)}">${esc(short(c.seed_url))}</span>
          <button class="ghost del" data-del="${c.id}" title="删除本地记录" aria-label="删除">×</button></span>
        <span class="m"><span class="badge ${live.status}">${live.status}</span><span>${live.pages_done}/${live.max_pages} 页</span><span>${live.links_found} 链接</span></span>
      </li>`;
    }).join("") || `<li class="m" style="cursor:default">还没有记录</li>`;
  }

  function updateStats() {
    const c = state.crawl;
    $("#sPages").textContent = c ? c.pages_done : 0;
    $("#sLinks").textContent = c ? c.links_found : 0;
    $("#stopBtn").hidden = !(c && state.runningId === c.id);
    $("#downloadBtn").disabled = !c || !c.pages.length;
  }

  async function selectCrawl(id) {
    const doc = state.runningId === id && state.crawler ? state.runningDoc : await Store.get(id);
    if (!doc) { toast("找不到这条记录"); return; }
    state.crawl = doc;
    state.pageId = null;
    state.kind = null;
    state.offset = 0;
    state.distinct = null;
    if (state.runningId !== id) $("#log").innerHTML = "";
    renderCrawls();
    renderPages();
    updateStats();
    const first = doc.pages.find((p) => !p.error);
    if (first) openPage(first.id);
    else showEmpty(true);
    if (state.view === "data") renderLinks();
  }

  function renderPages() {
    const pages = state.crawl?.pages || [];
    $("#pageCount").textContent = pages.length ? `(${pages.length})` : "";
    $("#pageList").innerHTML = pages.map((p) => `
      <li data-id="${p.id}" class="${p.id === state.pageId ? "active" : ""} ${p.error ? "err" : ""}">
        <span class="t" title="${esc(p.url)}">${esc(p.title || short(p.url))}</span>
        <span class="m"><span class="depth">d${p.depth}</span>${p.error ? esc(p.error.slice(0, 40)) : `${p.links.length} 链接`}</span>
      </li>`).join("");
  }

  function pageIdByUrl() {
    const m = new Map();
    for (const p of state.crawl.pages) {
      if (p.error) continue;
      m.set(p.url, p.id);
      if (p.requested_url) m.set(p.requested_url, p.id);
    }
    return m;
  }

  function openPage(id) {
    const p = state.crawl?.pages.find((x) => x.id === id);
    if (!p) return;
    if (!p.html) { toast(`该页面抓取失败：${p.error || "无内容"}`); return; }
    state.pageId = id;
    renderPages();
    showEmpty(false);
    $("#page").innerHTML =
      `<h1 class="page-title">${esc(p.title)}</h1><div class="page-url">${esc(p.url)}</div>` + p.html;
    const byUrl = pageIdByUrl();
    world.load(p.links.map((l) => ({ ...l, page_id: byUrl.get(l.url) || null })));
    if (state.view !== "spider") setView("spider");
  }

  function showEmpty(on) {
    $("#empty").style.display = on ? "" : "none";
    if (on) { $("#page").innerHTML = ""; world.load([]); }
  }

  // ---------- crawling ----------
  function logLine(cls, text) {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = text;
    li.title = text;
    const log = $("#log");
    log.prepend(li);
    while (log.children.length > 200) log.lastChild.remove();
  }

  let saveT = null;
  function saveSoon(doc) {
    clearTimeout(saveT);
    saveT = setTimeout(() => Store.put(doc), 1200);
  }

  async function startCrawl(params) {
    if (state.crawler) { toast("已有爬取在进行，请先停止"); return; }
    let u;
    try { u = new URL(params.seed_url); } catch { toast("URL 无效"); return; }
    if (u.protocol !== "https:" && u.protocol !== "http:") { toast("只支持 http(s) 网址"); return; }

    const doc = newCrawl(params);
    const crawler = new BrowserCrawler({
      workers: +$("#workers").value,
      delay: +$("#delay").value,
      proxy: $("#proxy").value.trim(),
      onEvent: (ev) => onCrawlEvent(doc, ev),
    });
    state.crawler = crawler;
    state.runningId = doc.id;
    state.runningDoc = doc;
    await Store.put(doc);
    state.crawls.unshift({ ...doc });
    $("#log").innerHTML = "";
    await selectCrawl(doc.id);
    await crawler.run(doc);
    state.crawler = null;
    state.runningId = null;
    state.runningDoc = null;
    clearTimeout(saveT);
    await Store.put(doc);
    syncMeta(doc);
    updateStats();
    if (!doc.pages.some((p) => !p.error)) {
      const err = doc.pages.find((p) => p.error)?.error;
      if (err) toast(`没有抓到页面：${err}`);
    }
  }

  function syncMeta(doc) {
    const i = state.crawls.findIndex((c) => c.id === doc.id);
    if (i >= 0) Object.assign(state.crawls[i], { status: doc.status, pages_done: doc.pages_done, links_found: doc.links_found });
    renderCrawls();
  }

  function onCrawlEvent(doc, ev) {
    const viewing = state.crawl && state.crawl.id === doc.id;
    if (ev.type === "fetching") {
      if (viewing) logLine(`w${ev.worker}`, `→ [蜘蛛${ev.worker + 1}] ${short(ev.url)}`);
      if (viewing && ev.from_page === state.pageId && ev.lid != null) world.fetching(ev.lid, ev.worker);
    } else if (ev.type === "page") {
      saveSoon(doc);
      syncMeta(doc);
      if (!viewing) return;
      logLine("ok", `✓ ${ev.title} · ${ev.links} 链接`);
      renderPages();
      updateStats();
      state.distinct = null;
      world.crawled(ev.url, ev.page_id);
      if (ev.requested_url !== ev.url) world.crawled(ev.requested_url, ev.page_id);
      if (!state.pageId) openPage(ev.page_id);
      if (state.view === "data") renderLinks();
    } else if (ev.type === "page_error") {
      saveSoon(doc);
      if (!viewing) return;
      logLine("bad", `✗ ${short(ev.url)} ${ev.error}`);
      renderPages();
    } else if (ev.type === "skip") {
      if (viewing) logLine("", `· 跳过 ${short(ev.url)} (${ev.reason})`);
    } else if (ev.type === "status") {
      syncMeta(doc);
      if (viewing) {
        logLine(ev.status === "error" ? "bad" : "ok", `■ 状态：${ev.status}${ev.error ? " " + ev.error : ""}`);
        updateStats();
      }
    }
  }

  // ---------- JSON import / export ----------
  function fileStem(c) {
    let host = "crawl";
    try { host = new URL(c.seed_url).hostname.replace(/^www\./, ""); } catch {}
    const d = new Date(c.created_at * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `spider-${host}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function downloadCrawl() {
    const c = state.crawl;
    if (!c) return;
    download(`${fileStem(c)}.json`, JSON.stringify(c), "application/json");
  }

  function validCrawl(j) {
    return j && typeof j === "object" && typeof j.seed_url === "string" && Array.isArray(j.pages) &&
      j.pages.every((p) => p && typeof p.id === "number" && typeof p.url === "string" && Array.isArray(p.links));
  }

  async function importFile(file) {
    let j;
    try { j = JSON.parse(await file.text()); } catch { toast("不是有效的 JSON 文件"); return; }
    if (!validCrawl(j)) { toast("JSON 格式不对：需要本应用导出的爬取文件"); return; }
    // Re-sanitize page HTML on import: the file may come from anywhere.
    const host = (() => { try { return new URL(j.seed_url).hostname; } catch { return ""; } })();
    for (const p of j.pages) {
      if (typeof p.html === "string") {
        const clean = window.PachongCrawler.extract(p.html, p.url, host, p.title, { wholeBody: true });
        p.html = clean.html;
        p.links = clean.links;
      } else {
        p.html = null;
      }
    }
    j.app = "pachong-spider";
    j.version = 1;
    if (j.status === "running" || j.status === "queued") j.status = "stopped";
    if (state.crawls.some((c) => c.id === j.id) || typeof j.id !== "number") j.id = Date.now();
    j.created_at = j.created_at || Date.now() / 1000;
    j.max_pages = j.max_pages || j.pages.length;
    j.max_depth = j.max_depth ?? 0;
    j.pages_done = j.pages.filter((p) => !p.error).length;
    j.links_found = j.pages.reduce((n, p) => n + p.links.length, 0);
    await Store.put(j);
    state.crawls.unshift({ ...j });
    await selectCrawl(j.id);
    toast(`已打开：${j.pages_done} 页，${j.links_found} 链接`);
  }

  // ---------- data view ----------
  function aggregate() {
    if (state.distinct) return state.distinct;
    const map = new Map();
    for (const p of state.crawl?.pages || []) {
      for (const l of p.links) {
        let row = map.get(l.url);
        if (!row) { row = { url: l.url, anchor: l.anchor, kind: l.kind, internal: l.internal, refs: 0, found_on: p.url }; map.set(l.url, row); }
        row.refs++;
        if ((l.anchor || "").length > (row.anchor || "").length) row.anchor = l.anchor;
      }
    }
    state.distinct = [...map.values()].sort((a, b) => b.refs - a.refs || a.url.localeCompare(b.url));
    return state.distinct;
  }

  function filteredRaw(kind) {
    const rows = [];
    for (const p of state.crawl?.pages || []) {
      for (const l of p.links) if (!kind || l.kind === kind) rows.push({ url: l.url, anchor: l.anchor, kind: l.kind, internal: l.internal, found_on: p.url });
    }
    return rows;
  }

  function renderLinks() {
    if (!state.crawl) { $("#linkRows").innerHTML = ""; $("#kindChips").innerHTML = ""; $("#pageInfo").textContent = ""; return; }
    const all = aggregate();
    const kinds = {};
    let total = 0;
    for (const p of state.crawl.pages) for (const l of p.links) { kinds[l.kind] = (kinds[l.kind] || 0) + 1; total++; }
    $("#kindChips").innerHTML = [`<button class="chip ${!state.kind ? "on" : ""}" data-kind="">全部 ${total}</button>`]
      .concat(Object.entries(kinds).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `<button class="chip ${state.kind === k ? "on" : ""}" data-kind="${esc(k)}">${esc(k)} ${n}</button>`))
      .join("");
    const q = state.q.toLowerCase();
    const rows = all.filter((r) => (!state.kind || r.kind === state.kind) &&
      (!q || r.url.toLowerCase().includes(q) || (r.anchor || "").toLowerCase().includes(q)));
    const pageRows = rows.slice(state.offset, state.offset + state.limit);
    $("#linkRows").innerHTML = pageRows.map((l) => `
      <tr>
        <td class="url"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${esc(l.url)}</a></td>
        <td title="${esc(l.anchor)}">${esc(l.anchor)}</td>
        <td><span class="k">${esc(l.kind)}</span></td>
        <td class="num">${l.refs}</td>
        <td class="found" title="${esc(l.found_on)}">${esc(short(l.found_on))}</td>
      </tr>`).join("") || `<tr><td colspan="5" style="color:var(--muted)">没有数据</td></tr>`;
    const end = Math.min(state.offset + state.limit, rows.length);
    $("#pageInfo").textContent = rows.length ? `${state.offset + 1}–${end} / ${rows.length} 个唯一链接` : "";
    $("#prevBtn").disabled = state.offset === 0;
    $("#nextBtn").disabled = end >= rows.length;
  }

  function exportLinks(fmt) {
    const c = state.crawl;
    if (!c) return;
    const rows = filteredRaw(state.kind);
    const name = `${fileStem(c)}-links${state.kind ? "-" + state.kind : ""}`;
    if (fmt === "json") return download(`${name}.json`, JSON.stringify(rows, null, 1), "application/json");
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["url,anchor,kind,internal,found_on"]
      .concat(rows.map((r) => [r.url, r.anchor, r.kind, r.internal ? 1 : 0, r.found_on].map(cell).join(",")));
    download(`${name}.csv`, "﻿" + lines.join("\r\n"), "text/csv");
  }

  function setView(v) {
    state.view = v;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    $("#view-spider").classList.toggle("on", v === "spider");
    $("#view-data").classList.toggle("on", v === "data");
    $("#spiderCtl").style.visibility = v === "spider" ? "" : "hidden";
    if (v === "data") renderLinks();
    else world.dirty = true;
  }

  // ---------- events ----------
  $("#crawlForm").addEventListener("submit", (e) => {
    e.preventDefault();
    startCrawl({
      seed_url: $("#seedUrl").value.trim(),
      max_pages: Math.max(1, Math.min(500, +$("#maxPages").value || 1)),
      max_depth: Math.max(0, Math.min(5, +$("#maxDepth").value || 0)),
      same_domain: $("#sameDomain").checked,
    }).catch((err) => toast(err.message));
  });
  $("#demoBtn").addEventListener("click", () => {
    $("#seedUrl").value = "https://en.wikipedia.org/wiki/Spider";
    $("#maxPages").value = 12;
    $("#maxDepth").value = 1;
    $("#crawlForm").requestSubmit();
  });
  $("#settingsBtn").addEventListener("click", () => {
    const s = $("#settings");
    s.hidden = !s.hidden;
    $("#settingsBtn").setAttribute("aria-expanded", String(!s.hidden));
    world.dirty = true;
  });
  ["#proxy", "#workers", "#delay"].forEach((id) => $(id).addEventListener("change", saveSettings));

  const pickFile = () => $("#importFile").click();
  $("#importBtn").addEventListener("click", pickFile);
  $("#emptyImportBtn").addEventListener("click", pickFile);
  $("#importFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) importFile(f).catch((err) => toast(err.message));
  });
  // Drag a JSON file anywhere onto the page to open it.
  document.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    importFile(f).catch((err) => toast(err.message));
  });
  $("#downloadBtn").addEventListener("click", downloadCrawl);

  $("#crawlList").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      const id = +del.dataset.del;
      if (id === state.runningId) { toast("正在爬取，先停止再删除"); return; }
      await Store.remove(id);
      state.crawls = state.crawls.filter((c) => c.id !== id);
      if (state.crawl?.id === id) {
        state.crawl = null;
        state.pageId = null;
        renderPages();
        updateStats();
        showEmpty(true);
      }
      renderCrawls();
      return;
    }
    const li = e.target.closest("li[data-id]");
    if (li) selectCrawl(+li.dataset.id).catch((err) => toast(err.message));
  });
  $("#pageList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) openPage(+li.dataset.id);
  });
  $("#stopBtn").addEventListener("click", () => state.crawler?.stop());
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  $("#spiderCount").addEventListener("change", (e) => world.setCount(+e.target.value));
  $("#speed").addEventListener("input", (e) => { world.speed = +e.target.value; });
  $("#follow").addEventListener("change", (e) => { world.follow = e.target.checked; });
  $("#pauseBtn").addEventListener("click", (e) => {
    world.paused = !world.paused;
    e.target.textContent = world.paused ? "继续" : "暂停";
  });
  $("#resetBtn").addEventListener("click", () => { if (state.pageId) openPage(state.pageId); });

  $("#kindChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    state.kind = b.dataset.kind || null;
    state.offset = 0;
    renderLinks();
  });
  let qT;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qT);
    qT = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; renderLinks(); }, 200);
  });
  $("#prevBtn").addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); renderLinks(); });
  $("#nextBtn").addEventListener("click", () => { state.offset += state.limit; renderLinks(); });
  $("#exportCsv").addEventListener("click", () => exportLinks("csv"));
  $("#exportJson").addEventListener("click", () => exportLinks("json"));

  window.addEventListener("beforeunload", (e) => {
    if (state.crawler) { e.preventDefault(); e.returnValue = ""; }
  });

  // ---------- boot ----------
  loadSettings();
  updateStats();
  loadCrawls()
    .then(() => { if (state.crawls[0]) return selectCrawl(state.crawls[0].id); })
    .catch((e) => toast(e.message));
})();
