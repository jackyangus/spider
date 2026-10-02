# Pachong Spider 爬虫

一个"看得见"的网页爬虫：后端广度优先抓取网页、解析并分类所有链接写入 SQLite；前端把抓到的页面以暗色模式渲染出来，几只程序化生成的蜘蛛（IK 腿、交替步态）在页面上爬行，把链接一个个"吃掉"——描框、撕下、换字体放大旋转、拖着走。实时爬取时，后端正在抓哪个链接，对应颜色的蜘蛛就会爬过去。

线上纯前端版：**https://spider.qooeo.com**

## 两个版本

| | 纯前端版 `web/` | 服务端版 `backend/` + `frontend/` |
|---|---|---|
| 爬取在哪跑 | 浏览器里 | Python 后端 |
| 能爬什么 | 维基百科等 MediaWiki 站点（走开放 API）；其他站点需允许 CORS 或配置代理 | 任意公开网页 |
| 数据 | 浏览器 IndexedDB 暂存；**下载 JSON 自己保存**，可再打开/拖入回放 | SQLite |
| 部署 | 静态托管（Cloudflare Pages） | 需要运行服务 |

### 纯前端版

```bash
./scripts/build-web.sh                 # 组装 dist/（复用 frontend/spider.js 与 style.css）
python3 -m http.server -d dist 8790    # 本地预览
npx wrangler pages deploy dist --project-name spider --branch main   # 手动部署
```

推送到 `main` 会通过 GitHub Actions 自动部署（需在仓库 Secrets 中设置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`）。

JSON 文件格式：`{app:"pachong-spider", version:1, id, seed_url, max_pages, max_depth, same_domain, status, pages:[{id, url, title, depth, html, text_len, error, fetched_at, links:[{url, anchor, kind, internal}]}]}`，`links[i]` 对应 `html` 中的 `data-lid="i"`。打开 JSON 时会重新清洗 HTML。

## 服务端版运行

```bash
./run.sh            # 首次会创建 .venv 并安装依赖
open http://localhost:8765
```

输入起始 URL（默认 `https://en.wikipedia.org/wiki/Spider`），设置页数/深度，点 **开始爬取**。

- **蜘蛛视图**：蜘蛛数量 1–3、速度、镜头跟随、暂停/重置；**双击页面任意位置**把蜘蛛放到那里（比如直接放进参考文献区）。被爬取过的链接"战利品"带 ↗，点击即在蜘蛛视图中打开该页。
- **数据**：按类型（page / doi / isbn / pmid / pmc / bibcode / s2cid / issn / oclc / jstor / archive / pdf / external / meta）筛选、搜索、分页，导出 CSV / JSON。
- 左侧：任务列表、已抓页面、实时日志（SSE）。

测试：`.venv/bin/python -m pytest -q tests`

## 结构

```
backend/app/
  db.py        SQLite（WAL）：crawls / pages / links 三张表
  parse.py     正文提取 + 白名单清洗 HTML + 链接分类，<a> 带 data-lid 对应 links 行
  crawler.py   asyncio + httpx，3 个 worker 的 BFS；robots.txt、请求间隔、SSRF 防护；EventBus 推送事件
  main.py      FastAPI：REST + SSE，同时托管前端
frontend/
  index.html / style.css / app.js   界面、API、SSE
  spider.js    蜘蛛模拟与"吃链接"效果（canvas 叠加层 + DOM 战利品）
tests/         解析、分类、SSRF、爬虫（MockTransport）、API 全流程
data/pachong.db
```

### API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/crawls` | `{seed_url, max_pages, max_depth, same_domain}` 开始爬取 |
| GET | `/api/crawls` / `/api/crawls/{id}` | 任务列表 / 详情（含各类型链接计数） |
| POST | `/api/crawls/{id}/stop` | 停止 |
| DELETE | `/api/crawls/{id}` | 删除任务及其数据 |
| GET | `/api/crawls/{id}/pages` | 已抓页面 |
| GET | `/api/pages/{id}` | 页面清洗后 HTML + 链接（下标 = data-lid） |
| GET | `/api/crawls/{id}/links?kind=&q=&distinct=&limit=&offset=` | 链接查询（默认按 URL 去重并统计引用数） |
| GET | `/api/crawls/{id}/export?fmt=csv\|json&kind=` | 导出 |
| GET | `/api/crawls/{id}/events` | SSE：`status` / `fetching` / `page` / `page_error` / `skip` |

### 约定与限制

- 只抓 `text/html`，单页 ≤ 6MB；遵守 robots.txt；每个 worker 请求间隔 0.6s。
- 拒绝解析到内网/回环地址的 URL（每一跳都检查）。
- User-Agent 可用环境变量 `PACHONG_UA` 覆盖（Wikimedia 要求 UA 可识别）；数据库路径 `PACHONG_DB`。
- 服务重启时，未完成的任务标记为 `stopped`（爬取状态在内存中，不做断点续爬）。
