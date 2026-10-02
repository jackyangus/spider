(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (u) => { try { const x = new URL(u); return decodeURIComponent(x.pathname + x.search).slice(0, 80) || x.host; } catch { return u; } };

  const state = {
    crawls: [],
    crawlId: null,
    crawl: null,
    pages: [],
    pageId: null,
    es: null,
    view: "spider",
    kind: null,
    q: "",
    offset: 0,
    limit: 50,
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 4000);
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
    state.crawls = await api("/api/crawls");
    renderCrawls();
  }

  function renderCrawls() {
    $("#crawlList").innerHTML = state.crawls.map((c) => `
      <li data-id="${c.id}" class="${c.id === state.crawlId ? "active" : ""}">
        <span class="t" title="${esc(c.seed_url)}">#${c.id} ${esc(short(c.seed_url))}</span>
        <span class="m"><span class="badge ${c.status}">${c.status}</span><span>${c.pages_done}/${c.max_pages} 页</span><span>${c.links_found} 链接</span></span>
      </li>`).join("") || `<li class="m" style="cursor:default">还没有任务</li>`;
  }

  async function selectCrawl(id) {
    if (state.es) { state.es.close(); state.es = null; }
    state.crawlId = id;
    state.pageId = null;
    state.kind = null;
    state.offset = 0;
    $("#log").innerHTML = "";
    renderCrawls();
    await refreshCrawl();
    state.pages = await api(`/api/crawls/${id}/pages`);
    renderPages();
    const first = state.pages.find((p) => !p.error);
    if (first) openPage(first.id);
    else showEmpty(true);
    if (state.crawl.status === "running" || state.crawl.status === "queued") connectEvents(id);
    if (state.view === "data") loadLinks();
  }

  async function refreshCrawl() {
    if (!state.crawlId) return;
    state.crawl = await api(`/api/crawls/${state.crawlId}`);
    $("#sPages").textContent = state.crawl.pages_done;
    $("#sLinks").textContent = state.crawl.links_found;
    $("#stopBtn").hidden = state.crawl.status !== "running";
    const i = state.crawls.findIndex((c) => c.id === state.crawlId);
    if (i >= 0) { state.crawls[i] = { ...state.crawls[i], ...state.crawl }; renderCrawls(); }
  }

  function renderPages() {
    $("#pageCount").textContent = state.pages.length ? `(${state.pages.length})` : "";
    $("#pageList").innerHTML = state.pages.map((p) => `
      <li data-id="${p.id}" class="${p.id === state.pageId ? "active" : ""} ${p.error ? "err" : ""}">
        <span class="t" title="${esc(p.url)}">${esc(p.title || short(p.url))}</span>
        <span class="m"><span class="depth">d${p.depth}</span>${p.error ? esc(p.error.slice(0, 40)) : `${p.link_count} 链接`}</span>
      </li>`).join("");
  }

  async function openPage(id) {
    const p = await api(`/api/pages/${id}`);
    if (!p.html) { toast(`该页面抓取失败：${p.error || "无内容"}`); return; }
    state.pageId = id;
    renderPages();
    showEmpty(false);
    $("#page").innerHTML =
      `<h1 class="page-title">${esc(p.title)}</h1><div class="page-url">${esc(p.url)}</div>` + p.html;
    world.load(p.links);
    if (state.view !== "spider") setView("spider");
  }

  function showEmpty(on) {
    $("#empty").style.display = on ? "" : "none";
    if (on) { $("#page").innerHTML = ""; world.load([]); }
  }

  // ---------- live events ----------
  function logLine(cls, text) {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = text;
    li.title = text;
    const log = $("#log");
    log.prepend(li);
    while (log.children.length > 200) log.lastChild.remove();
  }

  function connectEvents(id) {
    const es = new EventSource(`/api/crawls/${id}/events`);
    state.es = es;
    let refreshT = null;
    const soonRefresh = () => { clearTimeout(refreshT); refreshT = setTimeout(refreshCrawl, 400); };
    es.onmessage = async (msg) => {
      const ev = JSON.parse(msg.data);
      if (state.crawlId !== id) return;
      if (ev.type === "fetching") {
        logLine(`w${ev.worker}`, `→ [蜘蛛${ev.worker + 1}] ${short(ev.url)}`);
        if (ev.from_page === state.pageId && ev.lid != null) world.fetching(ev.lid, ev.worker);
      } else if (ev.type === "page") {
        logLine("ok", `✓ ${ev.title} · ${ev.links} 链接`);
        if (!state.pages.some((p) => p.id === ev.page_id)) {
          state.pages.push({ id: ev.page_id, url: ev.url, title: ev.title, depth: ev.depth, link_count: ev.links });
          renderPages();
        }
        world.crawled(ev.url, ev.page_id);
        if (!state.pageId) openPage(ev.page_id);
        soonRefresh();
      } else if (ev.type === "page_error") {
        logLine("bad", `✗ ${short(ev.url)} ${ev.error}`);
        if (!state.pages.some((p) => p.id === ev.page_id)) {
          state.pages.push({ id: ev.page_id, url: ev.url, title: null, depth: 0, error: ev.error });
          renderPages();
        }
      } else if (ev.type === "skip") {
        logLine("", `· 跳过 ${short(ev.url)} (${ev.reason})`);
      } else if (ev.type === "status") {
        logLine(ev.status === "error" ? "bad" : "ok", `■ 状态：${ev.status}${ev.error ? " " + ev.error : ""}`);
        await refreshCrawl();
        if (["done", "stopped", "error"].includes(ev.status)) { es.close(); state.es = null; }
      }
    };
    es.onerror = () => { if (state.crawl && state.crawl.status !== "running") es.close(); };
  }

  // ---------- data view ----------
  async function loadLinks() {
    if (!state.crawlId) { $("#linkRows").innerHTML = ""; $("#kindChips").innerHTML = ""; return; }
    await refreshCrawl();
    const kinds = state.crawl.kinds || {};
    const total = Object.values(kinds).reduce((a, b) => a + b, 0);
    $("#kindChips").innerHTML = [`<button class="chip ${!state.kind ? "on" : ""}" data-kind="">全部 ${total}</button>`]
      .concat(Object.entries(kinds).map(([k, n]) => `<button class="chip ${state.kind === k ? "on" : ""}" data-kind="${esc(k)}">${esc(k)} ${n}</button>`))
      .join("");
    const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
    if (state.kind) params.set("kind", state.kind);
    if (state.q) params.set("q", state.q);
    const data = await api(`/api/crawls/${state.crawlId}/links?${params}`);
    $("#linkRows").innerHTML = data.items.map((l) => `
      <tr>
        <td class="url"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${esc(l.url)}</a></td>
        <td title="${esc(l.anchor)}">${esc(l.anchor)}</td>
        <td><span class="k">${esc(l.kind)}</span></td>
        <td class="num">${l.refs}</td>
        <td class="found" title="${esc(l.found_on)}">${esc(short(l.found_on))}</td>
      </tr>`).join("") || `<tr><td colspan="5" style="color:var(--muted)">没有数据</td></tr>`;
    const end = Math.min(state.offset + state.limit, data.total);
    $("#pageInfo").textContent = data.total ? `${state.offset + 1}–${end} / ${data.total} 个唯一链接` : "";
    $("#prevBtn").disabled = state.offset === 0;
    $("#nextBtn").disabled = end >= data.total;
  }

  function setView(v) {
    state.view = v;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    $("#view-spider").classList.toggle("on", v === "spider");
    $("#view-data").classList.toggle("on", v === "data");
    $("#spiderCtl").style.visibility = v === "spider" ? "" : "hidden";
    if (v === "data") loadLinks().catch((e) => toast(e.message));
    else world.dirty = true;
  }

  // ---------- events ----------
  $("#crawlForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#startBtn");
    btn.disabled = true;
    try {
      const c = await api("/api/crawls", {
        method: "POST",
        body: JSON.stringify({
          seed_url: $("#seedUrl").value.trim(),
          max_pages: +$("#maxPages").value,
          max_depth: +$("#maxDepth").value,
          same_domain: $("#sameDomain").checked,
        }),
      });
      state.crawls.unshift(c);
      await selectCrawl(c.id);
    } catch (err) {
      toast(`无法开始：${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  $("#crawlList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) selectCrawl(+li.dataset.id).catch((err) => toast(err.message));
  });
  $("#pageList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) openPage(+li.dataset.id).catch((err) => toast(err.message));
  });
  $("#refreshBtn").addEventListener("click", () => loadCrawls());
  $("#stopBtn").addEventListener("click", async () => {
    try { await api(`/api/crawls/${state.crawlId}/stop`, { method: "POST" }); } catch (e) { toast(e.message); }
  });
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
    loadLinks();
  });
  let qT;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qT);
    qT = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; loadLinks(); }, 250);
  });
  $("#prevBtn").addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); loadLinks(); });
  $("#nextBtn").addEventListener("click", () => { state.offset += state.limit; loadLinks(); });
  const exportUrl = (fmt) => {
    if (!state.crawlId) return;
    const p = new URLSearchParams({ fmt });
    if (state.kind) p.set("kind", state.kind);
    window.location.href = `/api/crawls/${state.crawlId}/export?${p}`;
  };
  $("#exportCsv").addEventListener("click", () => exportUrl("csv"));
  $("#exportJson").addEventListener("click", () => exportUrl("json"));

  // ---------- boot ----------
  loadCrawls()
    .then(() => { if (state.crawls[0]) return selectCrawl(state.crawls[0].id); })
    .catch((e) => toast(`后端不可用：${e.message}`));
})();
