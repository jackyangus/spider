/* Local persistence: crawl JSON documents in IndexedDB (falls back to memory-only).
 * The JSON file the user downloads is the durable copy; this just survives reloads. */
(function () {
  "use strict";

  const DB = "pachong-spider", META = "meta", DOCS = "docs";
  const mem = new Map();
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(META, { keyPath: "id" });
          req.result.createObjectStore(DOCS, { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbp;
  }

  const metaOf = (c) => ({
    id: c.id, seed_url: c.seed_url, max_pages: c.max_pages, max_depth: c.max_depth,
    status: c.status, pages_done: c.pages_done, links_found: c.links_found, created_at: c.created_at,
  });

  function tx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const out = fn(t);
      t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const Store = {
    async list() {
      const db = await open();
      if (!db) return [...mem.values()].map(metaOf).sort((a, b) => b.id - a.id);
      try {
        const rows = await tx(db, [META], "readonly", (t) => t.objectStore(META).getAll());
        return rows.sort((a, b) => b.id - a.id);
      } catch {
        return [...mem.values()].map(metaOf).sort((a, b) => b.id - a.id);
      }
    },
    async get(id) {
      if (mem.has(id)) return mem.get(id);
      const db = await open();
      if (!db) return null;
      try { return (await tx(db, [DOCS], "readonly", (t) => t.objectStore(DOCS).get(id))) || null; } catch { return null; }
    },
    async put(crawl) {
      mem.set(crawl.id, crawl);
      const db = await open();
      if (!db) return;
      try {
        await tx(db, [META, DOCS], "readwrite", (t) => {
          t.objectStore(META).put(metaOf(crawl));
          t.objectStore(DOCS).put(crawl);
        });
        mem.delete(crawl.id); // persisted; don't hold two copies once it's on disk
      } catch (e) {
        console.warn("IndexedDB save failed; crawl kept in memory only", e);
      }
    },
    async remove(id) {
      mem.delete(id);
      const db = await open();
      if (!db) return;
      try {
        await tx(db, [META, DOCS], "readwrite", (t) => {
          t.objectStore(META).delete(id);
          t.objectStore(DOCS).delete(id);
        });
      } catch {}
    },
  };

  window.PachongStore = Store;
})();
