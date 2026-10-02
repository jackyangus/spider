/* Procedural spiders that crawl over the rendered page and "eat" its links.
 *
 * Coordinates: everything lives in *content space* = px relative to #page's top-left,
 * so positions survive scrolling. Drawing converts to canvas space each frame.
 */
(function () {
  "use strict";

  const PALETTES = [
    { leg: "#38e1ff", joint: "#ff2e88", body: "#14205a", head: "#38e1ff", ink: ["#ff2e88", "#38e1ff", "#7cf0ff"] },
    { leg: "#ff7a3c", joint: "#4dff9a", body: "#3a1a0c", head: "#ffb347", ink: ["#ff9a3c", "#ff2e88", "#ffd23c"] },
    { leg: "#6c5cff", joint: "#ffcc33", body: "#1d1450", head: "#ffcc33", ink: ["#6c5cff", "#ff2ec4", "#38a0ff"] },
  ];
  const FONTS = [
    'Georgia, "Times New Roman", serif',
    '"Courier New", Courier, monospace',
    '"Helvetica Neue", Arial, sans-serif',
    '"Times New Roman", Times, serif',
    "Menlo, Monaco, monospace",
  ];
  // Hip angle (deg, relative to heading) and reach multiplier, per leg on one side, front → back.
  const LEG_LAYOUT = [[38, 1.15], [78, 1.0], [112, 0.95], [148, 1.1]];
  const MAX_TROPHIES = 70;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

  class Spider {
    constructor(world, idx, x, y) {
      this.world = world;
      this.idx = idx;
      this.pal = PALETTES[idx % PALETTES.length];
      this.x = x;
      this.y = y;
      this.vx = 0;
      this.vy = 0;
      this.heading = Math.PI / 2 + rand(-0.4, 0.4);
      this.size = rand(0.9, 1.15);
      this.baseSpeed = rand(120, 160);
      this.state = "seek";
      this.timer = 0;
      this.target = null;
      this.queue = []; // live-crawl priority targets
      this.carry = null; // {el, x, y, until}
      this.wanderT = 0;
      this.legs = [];
      let i = 0;
      for (const side of [-1, 1]) {
        LEG_LAYOUT.forEach(([deg, k], j) => {
          const leg = {
            side,
            ang: side * (deg * Math.PI) / 180,
            len: 62 * k * this.size,
            group: (j + (side > 0 ? 1 : 0)) % 2, // alternating tetrapod gait
            step: -1,
            fx: 0, fy: 0, sx: 0, sy: 0, tx: 0, ty: 0,
          };
          const [ix, iy] = this.idealFoot(leg);
          leg.fx = ix;
          leg.fy = iy;
          this.legs.push(leg);
          i++;
        });
      }
    }

    idealFoot(leg, lead = 0) {
      const a = this.heading + leg.ang;
      const r = leg.len * 0.92;
      return [this.x + Math.cos(a) * r + this.vx * lead, this.y + Math.sin(a) * r + this.vy * lead];
    }

    update(dt) {
      const w = this.world;
      const speed = this.baseSpeed * w.speed;

      if (this.state === "seek") {
        if (!this.target || this.target.item?.taken) this.target = w.pickTarget(this);
        const t = this.target;
        if (t) {
          const tx = t.x, ty = t.y;
          const d = dist(this.x, this.y, tx, ty);
          const want = Math.atan2(ty - this.y, tx - this.x);
          const turn = 5.5 * w.speed * dt;
          const da = angDiff(this.heading, want);
          this.heading += Math.max(-turn, Math.min(turn, da));
          // slow down when facing away / near the target
          const v = speed * Math.min(1, d / 60 + 0.25) * (0.35 + 0.65 * Math.max(0, Math.cos(da)));
          this.vx = Math.cos(this.heading) * v;
          this.vy = Math.sin(this.heading) * v;
          if (d < 10 + 6 * w.speed) {
            this.vx = this.vy = 0;
            if (t.item) {
              this.state = "mark";
              this.timer = 0.28 / Math.sqrt(w.speed);
              w.mark(this, t.item);
            } else {
              this.target = null; // wander point reached
            }
          }
        } else {
          this.vx *= 0.9;
          this.vy *= 0.9;
        }
      } else if (this.state === "mark") {
        this.timer -= dt;
        // tiny jitter while "biting"
        this.heading += Math.sin(performance.now() / 40) * 0.02;
        if (this.timer <= 0) {
          const trophy = w.eat(this, this.target.item);
          if (trophy) {
            this.dropCarry();
            this.carry = { el: trophy, x: trophy._x, y: trophy._y, until: performance.now() + rand(1400, 3200) / w.speed };
          }
          this.target = null;
          this.state = "seek";
        }
      }

      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.x = Math.max(10, Math.min(w.width - 10, this.x));
      this.y = Math.max(10, Math.min(w.height - 10, this.y));

      // Carried trophy trails behind the abdomen on a spring.
      if (this.carry) {
        const back = this.heading + Math.PI;
        const ax = this.x + Math.cos(back) * 34 * this.size;
        const ay = this.y + Math.sin(back) * 34 * this.size;
        const k = Math.min(1, dt * 6);
        this.carry.x += (ax - this.carry.x) * k;
        this.carry.y += (ay - this.carry.y) * k;
        this.carry.el.style.left = this.carry.x + "px";
        this.carry.el.style.top = this.carry.y + "px";
        if (performance.now() > this.carry.until) this.dropCarry();
      }

      this.updateLegs(dt);
    }

    dropCarry() {
      if (!this.carry) return;
      this.carry.el.style.transition = "opacity 1.2s";
      this.carry = null;
    }

    updateLegs(dt) {
      const moving = Math.hypot(this.vx, this.vy) > 4;
      const stepDur = 0.11 / Math.sqrt(this.world.speed);
      const activeGroup = this.legs.some((l) => l.step >= 0 && l.group === 0) ? 0
        : this.legs.some((l) => l.step >= 0 && l.group === 1) ? 1 : -1;
      for (const leg of this.legs) {
        if (leg.step >= 0) {
          leg.step += dt / stepDur;
          const t = Math.min(1, leg.step);
          const e = t * t * (3 - 2 * t);
          leg.fx = leg.sx + (leg.tx - leg.sx) * e;
          leg.fy = leg.sy + (leg.ty - leg.sy) * e;
          if (t >= 1) leg.step = -1;
          continue;
        }
        const [ix, iy] = this.idealFoot(leg);
        const off = dist(leg.fx, leg.fy, ix, iy);
        const threshold = leg.len * (moving ? 0.42 : 0.22);
        if (off > threshold && (activeGroup === -1 || activeGroup === leg.group) || off > leg.len * 1.3) {
          const [tx, ty] = this.idealFoot(leg, 0.14);
          leg.sx = leg.fx; leg.sy = leg.fy;
          leg.tx = tx + rand(-3, 3); leg.ty = ty + rand(-3, 3);
          leg.step = 0;
        }
      }
    }

    draw(ctx, ox, oy) {
      const p = this.pal;
      const h = this.heading;
      const cos = Math.cos(h), sin = Math.sin(h);
      const X = (x) => x + ox, Y = (y) => y + oy;

      // threads: to target and to carried trophy (the long lines in the reference video)
      ctx.lineWidth = 1;
      if (this.target && this.target.item) {
        ctx.strokeStyle = p.leg + "55";
        ctx.beginPath();
        ctx.moveTo(X(this.x), Y(this.y));
        ctx.lineTo(X(this.target.x), Y(this.target.y));
        ctx.stroke();
      }
      if (this.carry) {
        ctx.strokeStyle = p.joint;
        ctx.beginPath();
        ctx.moveTo(X(this.x - cos * 14 * this.size), Y(this.y - sin * 14 * this.size));
        ctx.lineTo(X(this.carry.x), Y(this.carry.y));
        ctx.stroke();
      }

      // legs: 2-bone IK, knee bent outward
      const dots = [];
      ctx.strokeStyle = p.leg;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const leg of this.legs) {
        const ha = h + leg.ang * 0.55;
        const hx = this.x + Math.cos(ha) * 7 * this.size;
        const hy = this.y + Math.sin(ha) * 7 * this.size;
        const a = leg.len * 0.58, b = leg.len * 0.62;
        let dx = leg.fx - hx, dy = leg.fy - hy;
        let d = Math.hypot(dx, dy) || 0.001;
        const dc = Math.min(d, a + b - 0.01);
        const base = Math.atan2(dy, dx);
        const cosA = (a * a + dc * dc - b * b) / (2 * a * dc);
        const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)));
        const ka = base - leg.side * alpha;
        const kx = hx + Math.cos(ka) * a, ky = hy + Math.sin(ka) * a;
        ctx.moveTo(X(hx), Y(hy));
        ctx.lineTo(X(kx), Y(ky));
        ctx.lineTo(X(leg.fx), Y(leg.fy));
        dots.push(kx, ky, leg.fx, leg.fy);
      }
      ctx.stroke();

      ctx.fillStyle = p.joint;
      for (let i = 0; i < dots.length; i += 2) {
        ctx.beginPath();
        ctx.arc(X(dots[i]), Y(dots[i + 1]), i % 4 === 0 ? 2.4 : 3.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // body: abdomen box + head
      ctx.save();
      ctx.translate(X(this.x), Y(this.y));
      ctx.rotate(h);
      const s = this.size;
      ctx.fillStyle = p.body;
      ctx.strokeStyle = p.leg;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(-22 * s, -5.5 * s, 22 * s, 11 * s);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.rect(-2 * s, -4 * s, 9 * s, 8 * s);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.head;
      ctx.beginPath();
      ctx.arc(10 * s, 0, 3.6 * s, 0, Math.PI * 2);
      ctx.fill();
      if (this.state === "mark") {
        ctx.strokeStyle = p.joint;
        ctx.beginPath();
        ctx.arc(10 * s, 0, 7 * s + Math.sin(performance.now() / 50) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  class SpiderWorld {
    constructor({ stage, page, canvas, onEat, onOpenPage }) {
      this.stage = stage;
      this.page = page;
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.onEat = onEat || (() => {});
      this.onOpenPage = onOpenPage || (() => {});
      this.spiders = [];
      this.items = [];
      this.byLid = new Map();
      this.trophies = [];
      this.speed = 1;
      this.follow = true;
      this.paused = false;
      this.count = 3;
      this.width = 800;
      this.height = 600;
      this.eaten = 0;
      this.userScrollUntil = 0;
      this.dirty = false;
      this.last = performance.now();

      const userScroll = () => { this.userScrollUntil = performance.now() + 3500; };
      stage.addEventListener("wheel", userScroll, { passive: true });
      stage.addEventListener("touchmove", userScroll, { passive: true });
      stage.addEventListener("keydown", userScroll);
      page.addEventListener("load", () => { this.dirty = true; }, true); // images settle layout
      // Double-click drops the spiders where you point (e.g. straight into the references).
      stage.addEventListener("dblclick", (e) => {
        const pr = page.getBoundingClientRect();
        this.spiders.forEach((s, i) => {
          if (s.target?.item) s.target.item.claimedBy = -1;
          s.x = e.clientX - pr.left + (i - 1) * 50;
          s.y = e.clientY - pr.top - 20 * i;
          s.target = null;
          s.queue = [];
          s.state = "seek";
        });
        this.userScrollUntil = performance.now() + 1500;
      });
      new ResizeObserver(() => { this.resize(); this.dirty = true; }).observe(stage);
      this.resize();
      requestAnimationFrame((t) => this.frame(t));
      setInterval(() => { if (this.dirty) this.measure(); }, 1200);
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.stage.getBoundingClientRect();
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      this.canvas.style.width = r.width + "px";
      this.canvas.style.height = r.height + "px";
      this.dpr = dpr;
    }

    /** Call after #page innerHTML changes. linkMeta: array indexed by data-lid ({url, kind, page_id}). */
    load(linkMeta) {
      this.trophies.forEach((t) => t.remove());
      this.trophies = [];
      this.eaten = 0;
      this.onEat(0);
      this.items = [];
      this.byLid = new Map();
      for (const el of this.page.querySelectorAll("a[data-lid]")) {
        const lid = +el.dataset.lid;
        const meta = (linkMeta && linkMeta[lid]) || {};
        const item = { el, lid, url: el.getAttribute("href"), kind: el.dataset.kind, pageId: meta.page_id || null,
                       x: 0, y: 0, w: 0, h: 0, taken: false, claimedBy: -1 };
        this.items.push(item);
        this.byLid.set(lid, item);
      }
      this.measure();
      this.stage.scrollTop = 0;
      this.respawn();
    }

    measure() {
      this.dirty = false;
      const pr = this.page.getBoundingClientRect();
      this.width = this.page.scrollWidth;
      this.height = this.page.scrollHeight;
      for (const it of this.items) {
        const r = it.el.getClientRects()[0] || it.el.getBoundingClientRect();
        it.x = r.left - pr.left;
        it.y = r.top - pr.top;
        it.w = r.width;
        it.h = r.height;
        it.hidden = r.width === 0 && r.height === 0;
      }
    }

    respawn() {
      this.spiders = [];
      const visTop = this.stage.scrollTop;
      for (let i = 0; i < this.count; i++) this.addSpider(i, visTop);
    }

    addSpider(i, top = this.stage.scrollTop) {
      const w = Math.min(this.width, this.stage.clientWidth);
      const s = new Spider(this, i, w * (0.3 + 0.2 * i), top + 120 + 60 * i);
      this.spiders.push(s);
    }

    setCount(n) {
      this.count = n;
      while (this.spiders.length > n) {
        const s = this.spiders.pop();
        s.dropCarry();
        if (s.target?.item) s.target.item.claimedBy = -1;
      }
      while (this.spiders.length < n) this.addSpider(this.spiders.length);
    }

    pickTarget(sp) {
      // 1. live crawl targets have priority
      while (sp.queue.length) {
        const it = sp.queue.shift();
        if (!it.taken && !it.hidden) return this.claim(sp, it);
      }
      // 2. nearest uneaten link, biased to keep moving down the page like a reader
      let best = null, bestScore = Infinity;
      for (const it of this.items) {
        if (it.taken || it.hidden || (it.claimedBy >= 0 && it.claimedBy !== sp.idx)) continue;
        const cx = it.x + Math.min(it.w, 60) / 2, cy = it.y + it.h / 2;
        const dy = cy - sp.y;
        if (dy < -260 || dy > 900) continue;
        let score = Math.hypot(cx - sp.x, dy * 1.4);
        if (dy < -20) score += 300 - dy * 2; // going back up is expensive
        score *= rand(0.75, 1.25); // a bit of personality, and spreads spiders out
        if (score < bestScore) { bestScore = score; best = it; }
      }
      if (best) return this.claim(sp, best);
      // 3. nothing near: wander down the page
      const ny = sp.y + rand(150, 400) > this.height - 40 ? rand(40, this.height * 0.3) : sp.y + rand(150, 400);
      return { item: null, x: rand(40, Math.max(60, this.width - 40)), y: ny };
    }

    claim(sp, it) {
      it.claimedBy = sp.idx;
      return { item: it, x: it.x + Math.min(it.w, 40) / 2, y: it.y + it.h / 2 };
    }

    mark(sp, it) {
      it.el.style.setProperty("--c", pick(sp.pal.ink));
      it.el.classList.add("marked");
    }

    /** Apply one of the "eaten" effects. Returns a trophy element if one was ripped off. */
    eat(sp, it) {
      if (it.taken) return null;
      it.taken = true;
      it.el.classList.remove("marked", "fetching");
      this.eaten++;
      this.onEat(this.eaten);

      const roll = Math.random();
      const color = pick(sp.pal.ink);
      if (roll < 0.25) {
        it.el.style.setProperty("--f", pick(FONTS));
        it.el.style.setProperty("--c", color);
        it.el.classList.add("restyled");
        this.dirty = true;
        return null;
      }
      if (roll < 0.45) {
        it.el.style.setProperty("--c", color);
        it.el.classList.add("dyed");
        this.dirty = true;
        return null;
      }

      // Rip the link out of the text as a big, rotated, re-typeset trophy.
      it.el.style.setProperty("--c", color);
      it.el.classList.add("eaten");
      const t = document.createElement("a");
      t.className = "trophy";
      t.textContent = it.el.textContent.trim().slice(0, 80) || it.url;
      t.href = it.url;
      t.target = "_blank";
      t.rel = "noopener noreferrer";
      t.title = it.url;
      const font = pick(FONTS);
      const size = Math.round(rand(18, 46) * (t.textContent.length > 40 ? 0.6 : 1));
      const rot = Math.random() < 0.45 ? 0 : rand(-38, 38);
      const style = Math.random();
      t.style.fontFamily = font;
      t.style.fontSize = size + "px";
      t.style.color = color;
      if (font.includes("mono") || font.includes("Courier")) t.style.letterSpacing = "0.08em";
      if (style < 0.3) { t.classList.add("filled"); t.style.background = color; }
      else if (style < 0.55) t.classList.add("boxed");
      t.style.transform = `rotate(${rot.toFixed(1)}deg)`;
      t._x = it.x;
      t._y = it.y - size * 0.3;
      t.style.left = t._x + "px";
      t.style.top = t._y + "px";
      if (it.pageId) this.markCrawled(t, it.pageId);
      t._item = it;
      this.page.appendChild(t);
      this.trophies.push(t);
      if (this.trophies.length > MAX_TROPHIES * 0.6) this.trophies[this.trophies.length - Math.round(MAX_TROPHIES * 0.6)]?.classList.add("old");
      while (this.trophies.length > MAX_TROPHIES) this.trophies.shift().remove();
      return t;
    }

    markCrawled(trophy, pageId) {
      trophy.classList.add("crawled");
      trophy.title = "已爬取 — 点击在蜘蛛视图中打开";
      trophy.onclick = (e) => { e.preventDefault(); this.onOpenPage(pageId); };
    }

    // ---- live crawl hooks ------------------------------------------------

    fetching(lid, worker) {
      const it = this.byLid.get(lid);
      if (!it || it.taken) return;
      const sp = this.spiders[worker % Math.max(1, this.spiders.length)];
      it.el.style.setProperty("--c", sp ? sp.pal.joint : "#4dff9a");
      it.el.classList.add("fetching");
      if (sp && sp.queue.length < 12) sp.queue.push(it);
    }

    crawled(url, pageId) {
      for (const it of this.items) {
        if (it.url !== url) continue;
        it.pageId = pageId;
        it.el.classList.remove("fetching");
      }
      for (const t of this.trophies) if (t._item && t._item.url === url) this.markCrawled(t, pageId);
    }

    // ---- frame loop ---------------------------------------------------------

    frame(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (!this.paused && this.items.length) for (const s of this.spiders) s.update(dt);

      // camera
      const lead = this.spiders[0];
      if (lead && this.follow && !this.paused && now > this.userScrollUntil && this.items.length) {
        const want = lead.y + this.page.offsetTop - this.stage.clientHeight * 0.45;
        const cur = this.stage.scrollTop;
        const next = cur + (want - cur) * Math.min(1, dt * 2.2);
        if (Math.abs(next - cur) > 0.5) this.stage.scrollTop = next;
      }

      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (this.items.length || this.spiders.length) {
        const pr = this.page.getBoundingClientRect();
        const cr = this.canvas.getBoundingClientRect();
        const ox = pr.left - cr.left, oy = pr.top - cr.top;
        for (const s of this.spiders) s.draw(ctx, ox, oy);
      }
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  window.SpiderWorld = SpiderWorld;
})();
