# OpenCorpCheck — Context Transfer

> 交接日期：2026-10-27
> 当前阶段：Phase 0 已完成（headless 研究 harness + 7 份美股七姐妹 profile）
> 下一阶段：Phase 1（F10 sidecar → 数据层/搜索 → API/CLI/MCP → dsh ACP sidebar → Docker/Electron）

这份文档给下一个接手的 agent/工程师。先读它，再读：

- [`README.md`](README.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)
- [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md)
- [`phase0/README.md`](phase0/README.md)
- [`config/universe.yaml`](config/universe.yaml)

---

## 1. 项目是什么

OpenCorpCheck 是一个开源的、agentic 的全球公司情报库，目标覆盖：

- A500、恒生指数、S&P 500、NASDAQ-100（约 1,000 家去重后的公司）
- 一个约 24 家公司的 AI watchlist（OpenAI、Anthropic、DeepSeek、Moonshot/Kimi、Zhipu、
  MiniMax、ByteDance、Huawei 等）
- 按需发现的私有公司

长期形态是「provenance-first 公司数据库 + agentic research layer」，通过 Web/Electron、
CLI、MCP、DeepSeek Harness sidebar 暴露。完整设计见 `docs/ARCHITECTURE.md`。

**Phase 0 不是完整平台**，只验证了一件事：

> 最小 DeepSeek Harness（headless）+ 一个蒸馏版 BFS/DFS web-search skill，能产出带引用的
> 公司 profile markdown。

Phase 0 没有 UI、没有数据库、没有 API server、没有 Docker、没有 F10 scraper。这些都在
Phase 1。

---

## 2. 当前状态（2026-10-27）

### 2.1 Phase 0 已完成

- 7 家美股公司 profile 全部由 **DeepSeek Harness headless** 生成。
- 模型：**`deepseek-flash`**（不是 Pro）。
- dsh：`@deepseek-ai/dsh@0.2.1-rc.3`。
- Node：24.18（要求 ≥24.9）。
- 最终校验：**PASS**；5 家 pass，2 家 warn，0 家 fail。

| 公司 | 状态 | 耗时 | 中文字数 | 来源 | Search / Fetch |
|---|---|---:|---:|---:|---:|
| AAPL | pass | 107.6s | 1707 | 12 | 4 / 16 |
| MSFT | pass | 141.4s | 1487 | 9 | 5 / 27 |
| GOOGL | warn | 208.7s | 1347 | 12 | 6 / 17 |
| AMZN | pass | 143.6s | 1095 | 10 | 5 / 20 |
| NVDA | warn | 142.4s | 1323 | 17 | 5 / 16 |
| META | pass | 325.5s | 1376 | 11 | 5 / 14 |
| TSLA | pass | 247.7s | 1444 | 13 | 5 / 21 |

产物：

- [`phase0/out/magnificent-seven.md`](phase0/out/magnificent-seven.md) — 最终交付物（约 68 KB）
- [`phase0/out/run-log.md`](phase0/out/run-log.md) — 模型、耗时、工具调用、token
- [`phase0/out/run-summary.json`](phase0/out/run-summary.json) — 机器可读验收
- `phase0/runs/{TICKER}.jsonl` — 原始 `dsh --json` 事件（本地，已 gitignore）

### 2.2 两个 warn 是什么

GOOGL 和 NVDA 各有 1 个来源是「搜索摘要，未打开原文」，URL 出现在 `web_search` 结果里但
没有被 `web_fetch` 打开；文档已经明确标注来源类型。校验器给 warning，不是 fail。

如果 Phase 1 要继续用这个 validator，建议：

- URL 归一化时去掉 query 参数（`?utm_*`、`?trk=*`）再比较；
- 或在 validator 里把「来源行包含『搜索摘要/未打开原文』」的 URL 归为 `searchOnly`，
  不当作 unverified。

### 2.3 模型配置（重要）

用户明确要求：**所有 DSH 模型都用 DeepSeek V4.1 Flash / `deepseek-flash`，不要用 Pro。**

当前配置：

- `phase0/dsh.patch.yml` → `agent-default-model.model: deepseek-flash`
- `phase0/lib/dsh.mjs` → `DEFAULT_MODEL = "deepseek-flash"`
- 内置 `web-search-deepseek` provider 没有覆盖，使用它自己的默认 `deepseek-v4-flash`
  （同样是 Flash，不是 Pro）
- 不要再把 `deepseek-v4-pro` 写回配置。

### 2.4 数据来源的现状

Phase 0 的 agent 只用了 dsh 内置 `web_search` / `web_fetch`，**没有接 F10 scraper**。

- 事件日志里只有 2 个 `eastmoney.com` URL，都是普通搜索命中，不是 F10 页面；
- 最终 7 份 profile 里 0 次引用 Eastmoney / F10；
- 来源分布大致是 `stockanalysis.com` 36 个 URL、Motley Fool 5 个、The Next Web 4 个、
  Nasdaq 3 个、Microsoft IR 3 个、`sec.gov` 只有 1 个。

所以当前 profile 是 **web-research-grade**，不是 filing-grade。Phase 1 要补 F10 + SEC XBRL，
把财务数字变成可交叉校验的确定性数据。

### 2.5 硬性要求：并行 backfill（用户明确要求）

Phase 0 的 7 家是用 `--concurrency 1` 串行跑的，约 20 分钟；用户明确要求 backfill 必须
并行，不能这么慢。`phase0/run.mjs` 现在默认 `--concurrency 4`，但这只是脚本级并发；
Phase 1 必须把它做成可恢复、可限流的生产级 backfill。

要求：

1. **队列化**：pg-boss（Postgres）建 `crawl` / `research` / `extract` / `embed` 队列；
   每个 company/page 是一个 job；`singletonKey` 去重；retry + backoff + dead-letter。
2. **并发**：worker 池 4–8；LLM 全局并发 4–6；每个搜索 provider 2–4；每个域名 1–2 req/s；
   429 指数退避。
3. **分片/优先级**：按 index/市场/公司权重分片；先跑 index 权重高 + AI watchlist；每个
   company 独立 checkpoint，失败只重跑该公司/该页。
4. **可恢复**：`crawl_jobs` / `research_runs` 记录状态；section/document/fact 幂等写入；
   内容 hash + prompt hash 缓存，重复 backfill 不重复调用 LLM。
5. **可观测**：queue depth、每公司状态、限流命中、token/成本、p95；`run-summary.json`
   继续作为机器可读验收。
6. **F10 sidecar 并发**：sidecar 自己要有 per-domain token bucket 和请求队列；不要用
   Playwright 无限并发；F10 是外部站点，必须限流。
7. **Phase 0 用法**：`npm run research -- --concurrency 4`（默认已是 4）；遇到 429 降到
   1–2；不要为了快而绕过限流。

验收：7 家 backfill 在 concurrency 4 下明显快于串行；100 家公司 backfill 可断点续跑；
单家失败不影响其他；队列/worker 重启后从 checkpoint 继续。

---

## 3. 仓库结构

```text
OpenCorpCheck/
  README.md
  CONTEXT_TRANSFER.md              # 本文件
  .gitignore                       # 忽略 key、.env、runs、sections、live logs
  .dsh/skills/mag7-profile/SKILL.md # Phase 0 的蒸馏版 BFS/DFS skill
  config/universe.yaml             # 4 个指数 + 24 家 AI watchlist
  docs/
    ARCHITECTURE.md                # 完整平台设计（Phase 1+ 的主要参考）
    DATA_SOURCES.md                # 数据源矩阵 + F10 复用方案
    PRIOR_ART.md                   # 竞品/开源生态扫描
  phase0/
    README.md                      # Phase 0 快速开始/排错
    .env.example                   # DEEPSEEK_API_KEY 占位
    package.json                   # 无依赖，只有 scripts
    dsh.patch.yml                  # deepseek-flash + 明文 session JSONL
    search-api.patch.yml           # 可选：直接 Search API 降级
    run.mjs                        # 批量 runner
    lib/
      dsh.mjs                      # spawn headless + 解析 NDJSON + URL/usage 提取
      assemble.mjs                 # sections -> 最终文档
      validate.mjs                 # 结构 + 引用交叉校验
    prompts/
      company.md                   # 单公司研究 brief
      synthesis.md                 # 可选的摘要/跨公司主题
    fixtures/mock-section.md       # --mock 用
    out/
      magnificent-seven.md         # 最终交付物（已提交）
      run-log.md                   # 已提交
      run-summary.json             # 已提交
      sections/{TICKER}.md         # 中间产物（gitignore）
    runs/{TICKER}.jsonl            # 原始事件（gitignore）
```

---

## 4. 如何运行 Phase 0

```bash
cd phase0
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY（不要提交）

npm run research              # 7 家全跑 + 组装 + 校验
npm run research -- --only AAPL --force
npm run research -- --mock    # 不调 API，验证流水线
npm run research -- --synthesize  # 额外跑一次摘要（可选）
npm run validate
```

常用参数：

| 参数 | 作用 |
|---|---|
| `--only AAPL,MSFT` | 只跑指定公司 |
| `--force` | 已有 section 也重跑（会先删旧 section 和旧事件） |
| `--mock` | 用 fixture 跑完整流水线，不调 API |
| `--concurrency N` | 并发公司数，默认 1 |
| `--search-api` | 附加 `search-api.patch.yml`，切直接 Search API |
| `--synthesize` | 额外跑一次摘要/跨公司主题 |

### 4.1 关键实现细节

- `run.mjs` 为每家公司 spawn：

  ```bash
  npx --yes @deepseek-ai/dsh@0.2.1-rc.3 \
    --profile headless \
    --patch /abs/path/phase0/dsh.patch.yml \
    --json -
  ```

- `--json` 事件：`session`、`status`、`text`、`tool_call`、`tool_result`、`final`。
- `final.reason` 在 `turn_end` 里；`run.mjs` 要求 `kind == "completed"`。
- `--json` 对非 final 字符串有 8 KiB 截断；完整工具结果在
  `phase0/.dsh-home/sessions` 的明文 JSONL 里（`dsh.patch.yml` 已关闭 zstd）。
- `DSH_PERMISSION_MODE=read-only` 已被 rc.3 接受；不要用 `--approval-policy`（rc.3 的
  headless help 里没有这个 flag）。
- npm cache 坑：`npm run` 会把 `npm_config_cache` 指向 `~/.npm`，本机那个目录可能不可写。
  `lib/dsh.mjs` 已强制使用 `OCC_NPM_CACHE` 或 `$TMPDIR/occ-npm-cache`。

### 4.2 排错

- **`DEEPSEEK_API_KEY is missing`**：key 放 `phase0/.env` 或 export。
- **npm `EACCES` / `EEXIST` `~/.npm/_cacache`**：`OCC_NPM_CACHE=/tmp/occ-npm-cache`，
  或手动 `npm_config_cache=/tmp/occ-npm-cache npx ...`。
- **没有 `web_search`**：key 缺失时工具会被 withheld；看 `runs/{TICKER}.err` 的
  `MISSING_CREDENTIAL`。
- **skill 没加载**：检查 `.dsh/skills/mag7-profile/SKILL.md` frontmatter `name` 是
  kebab-case；dsh cwd 必须是仓库根目录（skill 只在 `<projectRoot>/.dsh/skills` 下发现）。
- **dsh 版本问题**：当前固定 `0.2.1-rc.3`；异常时试 `0.2.1-rc.4`，改
  `lib/dsh.mjs` 的 `DSH_VERSION`。

---

## 5. Phase 0 做了什么 / 没做什么

### 做了

- dsh headless 批量研究 harness；
- 蒸馏版 `mag7-profile` skill（BFS → 汇合点 → DFS → 证据审计 + 引用纪律）；
- 每家公司一个独立 session，失败隔离；
- `--json` 事件日志、tool call 统计、token 统计；
- 结构与引用交叉校验（来源 URL 必须出现在该公司的 `web_search`/`web_fetch` 事件里）；
- 7 份中文 profile + 摘要 + 方法/局限。

### 没做（Phase 1+）

- UI（Web/Electron）
- Postgres / Qdrant / MinIO / TEI
- API server / `occ` CLI / MCP server
- F10 scraper / SEC XBRL / CNINFO / HKEX 数据管道
- A/HK 覆盖、AI watchlist 的实际 profile
- dsh ACP sidebar / Cordis 插件
- Docker / CI / 多架构镜像
- 混合检索（dense + sparse + RRF/DBSF + rerank）

---

## 6. 下一步任务清单（给下个 agent）

### P1 — 东方财富 F10 sidecar（用户明确要求优先）

**背景**：`finance_analyst`（private repo：`xubowenhaoren/finance_analyst`，Apache-2.0）
里的 `scripts/aif10_scraper.py` **支持 A/HK/US 三地市场**：

- A 股：`HASHES["A"]`，16 个页面（`cwfx` 财务分析、`jyfx` 经营分析、`gsgk` 公司概况、
  `gdyj` 股东研究、`gsds` 公司大事、`hxtc` 核心题材、`yjbg` 研究报告、`thbj` 同行比较、
  `fhrz` 分红融资、`zbyz` 资本运作、`gsgg` 公司高管、`gbjg` 股本结构、`zxgg` 咨询公告、
  `glgg` 关联个股、`cpbd` 操盘必读、`ylyc` 盈利预测）。
- HK：`HASHES["HK"]`，12 个页面（`NewFinancialAnalysis`、`CoreReading`、
  `CompanyProfile`、`MajorShareholder`、`CorporateEvents`、`InvestmentRating`、
  `BusinessExpectation`、`IndustryComparison`、`CapitalStructure`、`CompanyManager`、
  `CompanyNews`、`RelatedWarrants`）。
- US：`HASHES["US"]`，5 个页面（`hxbd` 核心必读、`cwfx` 财务分析、`gbgd` 股本股东、
  `gsds` 公司大事、`gsgk` 公司概况）。

**当前限制**（必须改造成数据库级）：

- 用 `document.body.innerText`，表格被拍平；
- 每页截断 8000 字符（财务页不够）；
- 1 小时本地缓存；
- 没有 JSON 输出、没有结构化 tables、没有重试；
- Python 3.10+（本机默认 Python 3.9.6，需要 `uv`/Python 3.12 或 Docker）；
- Eastmoney 数据是专有的，只能内部 demo + attribution，不可批量重分发。

**建议实现**：

1. 新建 `services/finance-analyst/`，基于
   `mcr.microsoft.com/playwright/python`（或 `python:3.12-slim` + `playwright install
   --with-deps chromium`）。
2. 提供内部 HTTP：
   - `POST /v1/f10/scrape { market, code, pages?, force? }`
   - `POST /v1/edgar/search`、`POST /v1/edgar/filing`
   - `POST /v1/hkex/di`、`POST /v1/hkex/news`
   - `GET /health`
3. `aif10_scraper.py` 改造：
   - `--json` 输出 `{market, code, fetched_at, pages:[{label, hash, url, http_status,
     text, tables, html_sha256, storage_key, warnings}], errors}`；
   - 财务页（`cwfx`、`jyfx`、`gsgk`、`NewFinancialAnalysis`、`CoreReading`、
     `BusinessExpectation`）去掉 8000 字符截断，设 2 MB 安全上限；
   - 抽取 `<table>` 为 `{caption, headers, rows}`；优先抓 XHR/fetch JSON；
   - 生产环境关闭 1h 静默缓存；快照写 MinIO，按 SHA-256 存；
   - 2 次重试 + jitter；每域 5 req/s；并发 2；dismiss cookie/consent；locale `zh-CN`/`en-US`；
   - page presets：A 先跑 `cwfx,jyfx,gsgk,gdyj,gsds,hxtc,yjbg,thbj`；HK 先跑
     `NewFinancialAnalysis,CoreReading,CompanyProfile,MajorShareholder,CorporateEvents,
     InvestmentRating,BusinessExpectation`；US 先跑 `cwfx,gsgk,gbgd,gsds,hxbd`。
4. TS 侧：
   - `packages/sources/eastmoney-f10` adapter，调用 sidecar；
   - MCP tool `f10_scrape(market, code, pages)`，attach 到 dsh；
   - `mag7-profile`/后续 skill 增加来源规则：F10 是 A/HK 覆盖层、US supplementary/cross-check；
     SEC/CNINFO/HKEX 官方 filing 才是引用真相。
5. 验收：
   - AAPL（US）、600519（A）、00700（HK）三个 case 都能返回结构化 JSON；
   - `cwfx` 不再被 8k 截断；
   - F10 财务数字与 SEC/stockanalysis 交叉校验，>1% 差异标注；
   - dsh 能通过 MCP 调用 `f10_scrape`。
6. **并行 backfill（硬性要求）**：F10 sidecar 支持并发请求 + per-domain 限流；用 pg-boss
   把 company/page 拆成 job，worker 池 4–8；不要串行跑 1,000 家。单家失败只重跑该公司。

### P2 — 数据层 + 混合检索

按 `docs/ARCHITECTURE.md` §5–§7：

- Postgres 17 + Drizzle + pg-boss；表：`companies`、`company_ids`、`aliases`、`sources`、
  `documents`、`chunks`、`facts`、`financial_facts`、`products`、`relations`、
  `relation_evidence`、`research_runs`、`research_steps`、`review_queue`、`outbox`。
- Qdrant 1.18：`companies` + `documents` 两个 collection，dense（BGE-M3）+ sparse（自研
  BM25，jieba/Intl.Segmenter）+ RRF/DBSF + bge-reranker-v2-m3。
- MinIO 存原始 HTML/PDF；TEI 跑 BGE-M3/reranker。
- CLI `occ search`、`occ company get` 等；`--explain` 显示 BM25/dense/RRF/rerank 排名。
- backfill 用 pg-boss 队列 + worker 池，按 company/page 分片，支持断点续跑；不要串行。
- 先把 Phase 0 的 7 份 profile 作为 golden baseline，再扩到 A500/HSI/S&P 500/NDX + AI watchlist。

### P3 — API / CLI / MCP / dsh ACP sidebar

- Hono + Zod + OpenAPI + SSE；`/v1/search/companies`、`/v1/companies/{id}`、
  `/v1/research`、`/v1/runs/{id}/events` 等。
- `occ` CLI + `occ mcp --stdio`；MCP tools：`resolve_entity`、`search_companies`、
  `get_company`、`get_financials`、`get_relations`、`get_news`、`search_documents`、
  `propose_fact`、`propose_relation`、`deep_research`。
- dsh ACP sidebar（`@deepseek-ai/dsh-acp` + `@agentclientprotocol/sdk`）；可选 Cordis
  插件 `sidebar.right.pane.tab`。
- Phase 0 的 headless runner 继续用于批量文档生成；ACP 用于交互式 sidebar。

### P4 — A/HK 覆盖 + AI watchlist

- 索引快照：CSI A500（000510）、HSI、S&P 500、NASDAQ-100；存 `as_of` 和权重。
- 实体解析：LEI / CIK / USCC / ISIN / ticker+exchange / Wikidata QID / domain。
- 适配器：SEC EDGAR、CNINFO、HKEXnews、HKEX DION、GLEIF、company site、news。
- `config/universe.yaml` 已有 24 家 AI watchlist；Zhipu 的 `02513.HK` 需对 HKEX 复核，
  MiniMax 的上市状态标了 `verify`。
- F10 sidecar 接入后，A/HK 优先用 F10 做覆盖，官方公告做引用。

### P5 — Docker / Electron

- Compose：postgres/qdrant/minio/tei-embed/tei-rerank/api/worker/finance-analyst/web/
  dsh/jaeger；profiles `infra`、`app`、`agent`、`observability`、`full`。
- 镜像多架构 amd64/arm64；GHCR；Trivy/SBOM。
- Electron thin shell：web-first，electron-vite，VSCode compound launch，debug drawer，
  typed IPC；Desktop backend = Docker/remote，不做 embedded DB。
- 注意：Electron 不跑 crawler/Playwright；那些在 worker/finance-analyst 容器里。

### P6 — 评测 / 质量

- Golden set：中文名、英文名、ticker、错拼、拼音首字母、自然语言。
- 指标：MRR@10、nDCG@10、Recall@50、zero-result rate、p95 延迟。
- Agent eval：Google–Anthropic 关系问题、M7 profile 事实核对、引用精度。
- Phase 0 的 validator 可扩展：URL 去 query 归一化、`searchOnly` 分类、F10/XBRL 交叉校验。

---

## 7. 关键决策（不要轻易推翻）

1. **TypeScript 全栈**，唯一例外是 Python + Playwright 的 F10/HKEX/EDGAR sidecar。
2. **Qdrant** 做 hybrid retrieval，不用 Elasticsearch；pgvector/ParadeDB 是备选。
3. **dsh headless** 用于批量文档；**ACP** 用于未来交互式 sidebar。
4. **`deepseek-flash`**，不是 Pro。
5. **Docker/remote** 作为桌面后端；不做 PGlite/LanceDB embedded mode。
6. **Scope**：4 个指数 + AI watchlist + 按需私有公司，不做 200M 实体。
7. **F10 直接复用**，不重写；Apache-2.0 attribution；Eastmoney 数据不批量重分发。
8. **不完整移植 opportunity-radar**；Phase 0 的 skill 是蒸馏版，保留 BFS/DFS + 引用纪律，
   不做 1–5 裁决/G1–G14/Python XBRL 工具。
9. **Read-only by default**：agent 只能 propose fact/relation，写入进 review queue。
10. **Backfill 必须并行 + 可恢复**：Phase 0 的 `--concurrency 4` 只是脚本级；Phase 1 用
    pg-boss + worker 池 + per-domain 限流 + checkpoint，不能串行跑全量。

---

## 8. 已知坑 / 风险

| 坑 | 处理 |
|---|---|
| dsh 是 developer preview，接口会变 | 固定 `0.2.1-rc.3`；spawn/解析集中在 `lib/dsh.mjs`；异常试 rc.4 |
| npm `~/.npm/_cacache` 不可写 | `lib/dsh.mjs` 用 `OCC_NPM_CACHE` / `$TMPDIR/occ-npm-cache`；不要继承 `npm_config_cache` |
| Python 3.9 vs F10 的 3.10+ | 用 `uv` 装 Python 3.12，或用 Playwright Python Docker 镜像 |
| 串行 backfill 太慢（Phase 0 的 7 家约 20 分钟） | `--concurrency 4`；Phase 1 用 pg-boss + worker 池 + per-domain 限流 + checkpoint |
| API key 泄露风险 | 不要 `pgrep -fl`（会打印 env）；用 `pgrep -f` 只看 PID；key 只放 `.env`/环境变量，绝不提交 |
| Eastmoney 反爬/ToS | 限流、重试、robots、attribution；不批量重分发 |
| dsh `--json` 8 KiB 截断 | 完整结果读 `phase0/.dsh-home/sessions` 明文 JSONL |
| 没有 `--approval-policy`（rc.3） | 用 `DSH_PERMISSION_MODE=read-only`；不要在命令里加不存在的 flag |
| `deepseek-official` 搜索每次是一次模型 turn | 预算控制；必要时用 `search-api.patch.yml` 切直接 HTTP |
| 来源偏 stockanalysis、SEC 少 | Phase 1 接 F10 + SEC XBRL；profile 标注未验证项 |
| GOOGL/NVDA 各 1 个 search-summary 来源 warn | 不是 fail；可在 validator 加 `searchOnly` 分类或去 query 归一化 |

---

## 9. 交接检查清单

- [ ] 仓库是 private，key 没有被 git 跟踪。
- [ ] `phase0/out/magnificent-seven.md` 存在，头部是 `模型：deepseek-flash`。
- [ ] `cd phase0 && npm run validate` 退出码 0。
- [ ] `npm run research -- --mock` 无需 key 可跑通。
- [ ] `.dsh/skills/mag7-profile/SKILL.md` 在仓库根目录且被跟踪。
- [ ] `DEEPSEEK_API_KEY.txt`、`phase0/.env`、`phase0/runs/`、`phase0/out/sections/`
      都被 `.gitignore` 忽略。
- [ ] 下一阶段优先做 F10 sidecar（P1）。
- [ ] 并行 backfill：`--concurrency 4` 起步；Phase 1 用 pg-boss + worker 池，确认可断点续跑。
- [ ] 不要把 `deepseek-v4-pro` 写回配置。
- [ ] 不要提交任何 key、token、cookie、`.env`。

---

## 10. 参考

- Phase 0 原始计划：`/Users/bowenxu/.claude/plans/phase-0-deliverable-ui-minimal-greedy-dove.md`
  （如果下个 agent 能访问本机；本文件已包含下一步任务，不依赖它）
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)
- [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md)
- [`phase0/README.md`](phase0/README.md)
- [`config/universe.yaml`](config/universe.yaml)
- `finance_analyst`（private）：`https://github.com/xubowenhaoren/finance_analyst`
  — Apache-2.0；用 `gh repo clone` / `gh api` 读取；不要提交其数据快照。
- `opportunity-radar`（public, MIT）：`https://github.com/xubowenhaoren/opportunity-radar`
  — Phase 0 skill 的方法来源，不是完整移植。
