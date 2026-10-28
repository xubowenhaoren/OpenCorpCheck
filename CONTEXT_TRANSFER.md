# OpenCorpCheck — Context Transfer

> 交接日期：2026-10-27（P2 更新：2026-10-28；语料清洗 + 评测扩编：2026-10-28）
> 当前阶段：Phase 0 + Phase 1 + P2 + P2.5 已完成。真实语料已与 synthetic fixture
> 隔离（默认只搜索 102 家真实 profile），golden query 扩到 7 个 family、含 MRR@10/
> nDCG@10。Docker 封装全部 TODO。
> 下一阶段：P3（MCP / CLI / dsh ACP sidebar + fact/relation 抽取）或 P4（A500/HSI/SPX
> 快照 + A/HK 全量 backfill），由用户决定。
>
> **本机约束（2026-10-28 用户确认）**：这台电脑是 macOS 虚拟机，**暂时不能跑 Docker**。
> 所有 Docker / Compose / 镜像 / 多架构 / GHCR 封装工作全部标记为 TODO，换机器后再做。
> 本项目剩余开发继续用当前的「散装」方式：
> 本地 Postgres 17（`scripts/dev-db.sh`）、Qdrant 原生二进制（`scripts/dev-qdrant.sh`）、
> `uv` Python sidecars（finance-analyst / embeddings）、Node API/worker/CLI。
>
> **跨平台不是 TODO**：macOS 和 WSL2/Linux 都是 v1 目标；Docker 延期不代表可以写
> 平台相关代码。UI 必须 web-first，不在 renderer 做 OS 分支；路径统一用
> `node:path`/`URL`；npm scripts 不写 shell-specific 命令；本地脚本要同时支持
> Darwin 和 Linux（WSL2）。

这份文档给下一个接手的 agent/工程师。先读它，再读：

- [`README.md`](README.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/SEARCH.md`](docs/SEARCH.md)
- [`docs/EVAL.md`](docs/EVAL.md)
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)
- [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md)
- [`phase0/README.md`](phase0/README.md)
- [`config/universe.yaml`](config/universe.yaml)
- [`config/indices/ndx.yaml`](config/indices/ndx.yaml)

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
  .dsh/skills/
    mag7-profile/SKILL.md          # Phase 0 的蒸馏版 BFS/DFS skill（MAG7 专用）
    company-profile/SKILL.md       # 通用 A/HK/US profile skill（市场感知来源层级 + F10 纪律）
    f10-financials/SKILL.md        # F10 来源层级、页面选择、引用纪律
  config/universe.yaml             # 4 个指数 + 24 家 AI watchlist
  config/indices/ndx.yaml          # NASDAQ-100 成分股快照（官方 Nasdaq，带 as_of/license）
  docs/
    ARCHITECTURE.md                # 完整平台设计（Phase 1+ 的主要参考）
    DATA_SOURCES.md                # 数据源矩阵 + F10 复用方案
    PRIOR_ART.md                   # 竞品/开源生态扫描
  apps/
    cli/                           # MCP stdio server（f10_scrape / f10_pages）
    worker/                        # pg-boss 并行 backfill（research / f10）
  packages/
    core/                          # Zod 契约、类型、ULID
    db/                            # Drizzle schema + migrations
    ingest/                        # section markdown → documents/chunks → Qdrant
    retrieval/                     # tokenizer / BM25 / BGE-M3 / Qdrant / RRF-DBSF
    sources/eastmoney-f10/         # TS adapter：Zod 校验 + summary/full 投影
  services/
    finance-analyst/               # Python sidecar：A/HK/US F10（uv + Playwright）
  scripts/
    dev-db.sh                      # 本地 Postgres 17 init/start/stop
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
| `--concurrency N` | 并发公司数，默认 **4**；遇到 429/限流降到 1–2 |
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

### Phase 0 时点没做（P1/P2 已完成，见 §6；此处保留为历史）

- UI（Web/Electron）
- Postgres / Qdrant / MinIO / TEI
- API server / `occ` CLI / MCP server
- F10 scraper / SEC XBRL / CNINFO / HKEX 数据管道
- A500/HSI/S&P 500/NDX 成分股快照与 AI watchlist 的全量 profile（A/HK 路径已用
  600519/00700 验证，见 §6 P1 进度）
- dsh ACP sidebar / Cordis 插件
- Docker / CI / 多架构镜像
- 混合检索（dense + sparse + RRF/DBSF + rerank）

---

## 6. 下一步任务清单（给下个 agent）

### P1 进度（2026-10-27）

- [x] `services/finance-analyst/` 已落地：FastAPI sidecar + 结构化 scraper
  （表格抽取、XHR JSON 捕获、2 次重试 + jitter、每域 5 req/s、并发上限 2、
  去掉 8k 截断、2 MB 安全上限、`html_sha256` / `storage_key`）。
- [x] 本地工具链：`uv` + Python 3.12 venv + Playwright Chromium（本机无 Docker，
  开发走 uv；容器镜像留到 P5）。
- [x] 验收通过（`uv run python scripts/acceptance.py`）：AAPL(US) / 600519(A) /
  00700(HK) 均返回结构化 JSON；每页 4–10 张表、7–17 个 XHR JSON；
  HK 财务页 10,372 字符，A 股财务页曾达 9,332 字符——8k 截断确认已移除。
- [x] 单测/接口测试：`uv run pytest`（19 passed，无网络）。
- [x] TS 侧：`packages/sources/eastmoney-f10` adapter（Zod 校验、typed error、
  summary/full 投影）+ `apps/cli` MCP stdio server（`f10_scrape`、`f10_pages`）。
- [x] dsh 接入：`phase0/f10-mcp.patch.yml`（`insert` 语法）+ `npm run research -- --f10`；
  skill `.dsh/skills/f10-financials/SKILL.md` 规定 F10 的来源层级与引用纪律。
- [x] dsh 端到端实测：headless 调用 `mcp__occ__f10_pages` 返回 US 页面表；
  调用 `mcp__occ__f10_scrape` 抓 AAPL `gsgk`（2,976 字符）并由模型正确总结。
  `apps/cli` 集成测试 3 passed（stdio handshake + 工具调用 + 投影，无网络）。
- [x] 并行 backfill：`apps/worker`（pg-boss 17 + Postgres 17）。
  - 队列 `research.company` / `f10.page`，逐 company / 逐 page job；死信队列
    `*.dead`；retry + 指数退避；`singletonKey` + 唯一约束去重。
  - Postgres：`backfill_runs` / `backfill_jobs` / `research_cache` / `f10_pages`；
    完成态 checkpoint、prompt hash + section hash 缓存、F10 页面 upsert。
  - 并发：research 4、F10 4（可用 env 调整）；侧车仍是全局 2 页 / 每域 5 req/s。
  - 优先级：AI watchlist 100 > MAG7 60 > 显式 50，财务页加权；`--shard i/n`。
  - 可观测：逐 job JSON 日志（耗时/token/错误）、`status --run` 的 p50/p95/avg
    与死信详情、队列深度直接读 `pgboss.job`。
  - 实测：AAPL+MSFT 并发 4 总耗时 **147s**（单家 128s/145s，串行约 273s）；
    mock 重跑全部 cache hit；sidecar 停机时 4 次尝试后进死信，run 标 failed。
- 数据库分工（2026-10-28 确认）：**Postgres 17 = 真相库 + pg-boss 队列**，不是检索引擎。
  当前只建了 `backfill_runs` / `backfill_jobs` / `research_cache` / `f10_pages`；扩展
  `pg_trgm` 可用（够公司名/ticker 模糊快查）。**Hybrid search 规划是 Qdrant 1.18（P2）**：
  dense BGE-M3 + sparse 自研 BM25 + 服务端 RRF/DBSF；pgvector/ParadeDB 只是备选，不把
  Postgres 改造成检索引擎。
- [x] 通用 A/HK profile skill（2026-10-28）：`.dsh/skills/company-profile/SKILL.md`
  ——市场感知来源层级（A 股：CNINFO > 交易所 > IR > F10 > 财经媒体；HK：HKEXnews >
  IR > F10 > 媒体；US 同 MAG7）、F10 使用纪律（二手标注、>1% 差异双写、工具不可用
  时降级不中断）、币种/报告期口径规则。worker 按 target 选 skill：MAG7 universe 用
  `mag7-profile`，其余（A/HK/US 非 MAG7/AI watchlist）用 `company-profile`；
  `research_cache` 的 prompt hash 含 skill 文件内容，切换 skill 自动失效缓存。
- [x] A/HK live 验收（`--tickers 600519:A,00700:HK --include-f10 --force`）：
  2/2 完成，A 股 202s / 港股 219s，总 wall 221s；两家均正确解析公司全称
  （贵州茅台酒股份有限公司 / 腾讯控股有限公司）、13 章节齐全、F10 被实际调用
  （600519：2 次 `f10_scrape` 覆盖 cwfx/gsgk/jyfx/thbj/hxtc；00700：`f10_pages` +
  2 次 `f10_scrape`）；引用含 F10 attribution（页面 + fetched_at）与官方媒体，
  缺口处写“未验证”。注意：模型会用 bash grep dsh spill 文件读被 `--json` 8KiB 截断的
  完整 F10 结果——这是特性不是 bug。
- [x] P2 数据层（Drizzle/Qdrant）已完成，见 §6 P2。
- [ ] 待办：A500/HSI/SPX 成分股快照（P4；NDX 已完成）、MinIO 快照上传。
- 运行方式见 [`services/finance-analyst/README.md`](services/finance-analyst/README.md)。

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

**进度（2026-10-28）：已实现并通过 live E2E（35/35 checks）。** 详见
[`docs/SEARCH.md`](docs/SEARCH.md)。

- [x] `packages/core`：Zod 查询契约、类型、ULID、错误。
- [x] `packages/db`：Drizzle schema + `0001_init.sql`；`companies`、`company_ids`、
      `aliases`、`securities`、`index_memberships`、`sources`、`documents`、`chunks`、
      `facts`、`financial_facts`、`products`、`relations`、`relation_evidence`、
      `review_queue`、`outbox`。
- [x] `packages/retrieval`：jieba `cut_for_search` + Porter2 分词；FNV-1a 32-bit sparse
      （Qdrant `idf` modifier）；BGE-M3 dense client；Qdrant REST；服务端 RRF/DBSF；
      可选 rerank；indexer。
- [x] `apps/api`：Hono + Zod 搜索 API：`/v1/search/companies`、
      `/v1/search/documents`、`/v1/companies/{id}`、`/v1/health`、`/openapi.json`；
      `explain=true` 返回 BM25/dense 分支排名与融合结果。
- [x] `apps/cli`：`occ migrate|seed|search|documents|company|health`。
- [x] `services/embeddings`：本地 BGE-M3 / bge-reranker-v2-m3 sidecar，TEI 兼容
      `/embed`、`/rerank`（无 Docker 开发用；生产仍走 TEI）。
- [x] 本地工具链：`scripts/dev-qdrant.sh`（Qdrant 1.18 arm64 原生二进制）、
      `scripts/dev-embeddings.sh`、`scripts/e2e-search.sh`。
- [x] 合成 fixture 语料：24 家公司、31 篇文档；全部 `fixture://` + `trust_tier='fixture'`，
      不是真实研究数据。
- [ ] MinIO 快照上传。（worker/F10 → documents/chunks 已由 `packages/ingest` 打通）
- [ ] index constituent 快照（P4）与实体解析。

以下是原始 P2 设计（已完成部分以上方进度为准）：

- Postgres 17 + Drizzle + pg-boss；表：`companies`、`company_ids`、`aliases`、`sources`、
  `documents`、`chunks`、`facts`、`financial_facts`、`products`、`relations`、
  `relation_evidence`、`research_runs`、`research_steps`、`review_queue`、`outbox`。
- Qdrant 1.18：`companies` + `documents` 两个 collection，dense（BGE-M3）+ sparse（自研
  BM25，jieba/Intl.Segmenter）+ RRF/DBSF + bge-reranker-v2-m3。
- MinIO 存原始 HTML/PDF；TEI 跑 BGE-M3/reranker。
- CLI `occ search`、`occ company get` 等；`--explain` 显示 BM25/dense/RRF/rerank 排名。
- backfill 用 pg-boss 队列 + worker 池，按 company/page 分片，支持断点续跑；不要串行。
- 先把 Phase 0 的 7 份 profile 作为 golden baseline，再扩到 A500/HSI/S&P 500/NDX + AI watchlist。

### P2.5 — 已完成（2026-10-28）：QQQ/NDX 100 家 backfill + 质量评测

**进度（2026-10-28）：**

- [x] **成分股快照**：`config/indices/ndx.yaml`，来源为官方 Nasdaq quote API
  （`api.nasdaq.com/api/quote/list-type/nasdaq100`），`as_of: 2026-10-28`，
  101 个证券 / 100 家公司；GOOG/GOOGL 双 class 只回填 GOOGL（`primary` 标记）。
  worker 新增 `--universe ndx`（也接受 `nasdaq100`），priority 70。
- [x] **Ingestion bridge**：新包 `packages/ingest`
  - `parseSectionMarkdown` + `buildChunks`：按 `###` 章节解析，目标 500–800 tokens、
    ~15% overlap，表格按行切分不丢失；
  - 实体解析：先按 `securities(ticker+exchange)`，再按 `company_ids` / slug，
    复用 seed 里已有的 Apple / 茅台 / 腾讯，不重复建公司；
  - 写 `sources` / `documents`（`doc_type=company_profile`）/ `chunks`，
    再删旧 Qdrant points → `indexChunks` → 重新索引 company point；
  - `sha256(section)` 幂等：内容没变时 DB 不写、embedding 不调；
  - 并发安全：Postgres advisory lock + `ON CONFLICT` + `ensureCollections` 容错。
- [x] **CLI**：`occ ingest --sections ... [--index NDX|none] [--tickers ...]
  [--concurrency N] [--force] [--skip-index] [--json]`。实测 600519/00700：
  每家 14 chunks / ~2.3–2.7k tokens，重跑全部 `skipped`，且能按公司/文档搜到。
- [x] **并行 backfill 接入**：新队列 `ingest.company`（默认并发 4，
  3 次 retry + 指数退避 + 死信）。research 完成或 cache-hit 后自动 enqueue；
  `--no-ingest` 关闭，`--ingest-mock` 才 ingest mock section；run 的
  `backfill_jobs` 会追加 ingest 行，`status --run` 一并统计。
- [x] Pilot 5 家（AAPL/ABNB/ADBE/ADI/ADP）live：5/5 research + 5/5 ingest，
  wall **281s**；research p50 131s / p95 234s，ingest p50 13s；285k input /
  78k output tokens；70 chunks 入 Qdrant，0 retry。搜索验收：ticker/英文名 top1，
  “模拟芯片” → ADI top1，“人力资源 薪酬外包” → ADP top1。
- [x] 100 家 backfill：`--universe ndx`，research 并发 6 / ingest 4，
  **200/200 jobs**（100 research + 100 ingest），wall **约 42 分钟**，
  research p50 143s / p95 221s，ingest p50 15s，4.94M input / 1.57M output tokens，
  0 failed / 0 dead letter；1,428 个 profile chunk、100 条 NDX membership。
- [x] Golden query 评测（`scripts/eval-search.mjs`，结果见 `docs/EVAL.md`）：
  hybrid 下 ticker / 英文名 **top1 100%**、natural language top1 78.1% /
  recall@5 100%、pinyin 100%、typo 95.8%；p95 220–383ms。
  顺带修复 exact identifier/alias/fuzzy 排在 BM25 原始分数之后的问题
  （keyword 模式英文名 top1 从 2% → 100%）。
- [x] **语料清洗（fixture isolation，2026-10-28）**：
  - migration `0002_fixture_isolation.sql`：`companies.is_fixture` /
    `documents.is_fixture`；14 家 fixture-only 公司、31 篇 fixture 文档被隐藏，
    102 家真实 profile 保持可见。
  - Qdrant payload 带 `is_fixture`；搜索默认 `must_not is_fixture=true`，
    exact-match planner 也过滤 fixture 公司；`include_fixtures=true` 才返回。
  - `occ sync-fixtures`（`npm run sync:fixtures`）：对旧语料重算 flag、回填
    pinyin alias、修补 Qdrant payload；幂等。
  - 10 家 seed 公司因已有真实 profile 保留可见（8 家 NDX + 600519/00700）；
    另外 14 家（OpenAI/Anthropic/DeepSeek/CATL/Cambricon 等）默认不可见，等
    真实 research 后自动转正。
- [x] **评测扩编（2026-10-28）**：`scripts/golden-queries.mjs` + eval harness
  - 7 个 family：ticker / name（各 100，自动从 NDX 快照生成）、typo 24、
    pinyin 16、natural language 32、zh-name 16、documents 10。
  - 指标补 MRR@10（严格 top10 截断）+ nDCG@10（binary relevance，IDCG=1）。
  - 歧义 query 支持多个正确 ticker（多 expected 集合），避免把合理答案判错。
  - 新增 pinyin alias 派生：中文 alias → 全拼 + 首字母（`英伟达 → ywd`），
    seed 与 ingest 共用 `packages/ingest/src/pinyin.ts`；旧语料由
    `occ sync-fixtures` 回填（46 条更新 / 92 条新增 alias）。
  - 已知缺口：NFLX 无“奈飞”alias、COST 无“好市多”alias，zh-name top1 87.5%；
    `Adboe` typo 排 ADBE 第 3。下一轮补 curated 中文 alias。

**目标**：跑通真实数据闭环，测 backfill pipeline 速度 + hybrid search 质量。

关键事实 / 前置：

- QQQ 跟踪 NASDAQ-100，约 100 家成分股；快照已落在 `config/indices/ndx.yaml`，
  带 `as_of`、官方来源 URL 和 license，不要手抄成分股。
- P2 搜索原先用 synthetic fixture（24 家）；现在 `packages/ingest` 已把
  section markdown 写进 `documents/chunks` 并索引，worker 会自动调用。
- 可选：把 company profile 写入 `companies.profile` / `facts`，并重新索引 company 文本。
- 现有入口：`node apps/cli/dist/occ.js ...`、`node apps/worker/dist/cli.js ...`、
  `node apps/api/dist/server.js`。模型固定 `deepseek-flash`，不要用 Pro。

实施顺序：

1. **成分股快照（已完成）**：`config/indices/ndx.yaml`（官方 Nasdaq API，101 证券 /
   100 公司，`as_of` + license）；`--universe ndx` 已接入 worker。
2. **Ingestion bridge（已完成）**：`packages/ingest` + `occ ingest` + `ingest.company`
   队列；按章节 500–800 token 切块，sha256 幂等，失败可单家重跑。
3. **Pilot 5 家**：先跑 5 家（如 AAPL/MSFT/NVDA/AMZN/META），验证 ingestion + 搜索 +
   引用；`--concurrency 4`。
4. **100 家 backfill**：`--concurrency 4–8`（LLM 全局 4–6，搜索 provider 2–4），记录
   wall time、p50/p95、tokens/成本、失败/重试/死信、cache hit；输出 `run-summary.json`。
5. **搜索质量评测（已完成）**：7 个 family、约 300 条 query（含自动生成的
   100 ticker + 100 英文名、错拼、拼音首字母、自然语言、中文名、document），
   已测 MRR@10、nDCG@10、Recall@5、zero-result、p95；hybrid / keyword /
   semantic 三模式对比，结果见 [`docs/EVAL.md`](docs/EVAL.md)。
6. **验收**：
   - [x] 100 家都有 section；失败公司可单独重跑；
   - [x] 至少 90 家进入 `documents/chunks`（实际 100 家 / 1,428 chunks）；
   - [x] ticker / 英文名 top1 100%；中文名 top1 87.5%（奈飞/好市多缺 alias）；
   - [x] 记录 100 家 backfill wall time（约 42 分钟）与 p50/p95；
   - [x] 搜索 p95（不含 rerank）220–383ms，整体 < 400ms。

注意：本机无 Docker，继续用 `scripts/dev-db.sh` / `scripts/dev-qdrant.sh` /
`scripts/dev-embeddings.sh`；QQQ 成分股会变，快照必须带 `as_of`；真实 F10/SEC 数据的
license 与引用纪律见 [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)。

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

### P5 — Docker / Electron（全部 TODO，换机器后再做）

> **2026-10-28 用户确认**：当前开发机是 macOS 虚拟机，不能跑 Docker。P5 的所有
> Docker/容器/打包工作暂停，标记为 TODO；在换到支持 Docker 的机器之前不要开工。
> 剩余开发继续用「散装」方式：本地 Postgres + Qdrant 原生二进制 + uv sidecars +
> Node 进程。下面内容只作为将来换机器时的清单保留。
>
> **跨平台支持不是 TODO**：macOS 与 WSL2/Linux 都是 v1 目标。Docker 延期不改变这一点。
> UI 设计必须 web-first、响应式、无 OS 分支；Electron 只是薄壳。后端/脚本必须能在
> WSL2 的 Linux 文件系统里跑（repo 不要放 `/mnt/c`），Windows 宿主机通过 WSL2
> localhost forwarding 访问 UI/API。`scripts/dev-qdrant.sh` 已支持 Darwin/Linux
> x86_64/aarch64，`scripts/dev-db.sh` 支持从 PATH 发现 `pg_ctl` 或显式 `PGBIN`。

- **TODO（Docker 封装）**：Compose：postgres/qdrant/minio/tei-embed/tei-rerank/api/
  worker/finance-analyst/web/dsh/jaeger；profiles `infra`、`app`、`agent`、
  `observability`、`full`。
- **TODO（镜像/发布）**：多架构 amd64/arm64；GHCR；Trivy/SBOM。
- **TODO（Electron）**：thin shell，web-first，electron-vite，VSCode compound launch，
  debug drawer，typed IPC；Desktop backend = Docker/remote，不做 embedded DB。
- 注意：Electron 不跑 crawler/Playwright；那些在 worker/finance-analyst 容器里。
- **当前替代方案（不要删）**：`scripts/dev-db.sh`（Postgres 17）、
  `scripts/dev-qdrant.sh`（Qdrant 1.18 原生 arm64）、`scripts/dev-embeddings.sh`
  （BGE-M3 sidecar）、`scripts/e2e-search.sh`。这些就是本机的「散装」运行方式。

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
   **2026-10-28 更新**：本机是 macOS 虚拟机，不能跑 Docker；Docker 封装全部 TODO，
   换机器后再做。当前开发继续用本地 Postgres/Qdrant/uv 的「散装」方式。
6. **Scope**：4 个指数 + AI watchlist + 按需私有公司，不做 200M 实体。
7. **F10 直接复用**，不重写；Apache-2.0 attribution；Eastmoney 数据不批量重分发。
8. **不完整移植 opportunity-radar**；Phase 0 的 skill 是蒸馏版，保留 BFS/DFS + 引用纪律，
   不做 1–5 裁决/G1–G14/Python XBRL 工具。
9. **Read-only by default**：agent 只能 propose fact/relation，写入进 review queue。
10. **Backfill 必须并行 + 可恢复**：Phase 0 的 `--concurrency 4` 只是脚本级；Phase 1 用
    pg-boss + worker 池 + per-domain 限流 + checkpoint，不能串行跑全量。
    **已实现**：`apps/worker`，Postgres 17 + pg-boss，见该目录 README。
11. **默认直接在 `main` 上提交，不开额外 branch**（用户 2026-10-28 明确要求）。
    需要隔离实验时再临时开分支，合并后删除。
12. **Synthetic fixture 与真实语料隔离**：fixture 行保留在库里（供 E2E/流水线），
    但默认搜索不可见；`is_fixture` 同时存在于 Postgres 和 Qdrant payload，搜索默认
    `must_not`，只有 `include_fixtures=true` 才返回。不要用删除 fixture 的方式“清洗”，
    否则 E2E 和 mock 流水线会失去基线。

---

## 8. 已知坑 / 风险

| 坑 | 处理 |
|---|---|
| dsh 是 developer preview，接口会变 | 固定 `0.2.1-rc.3`；spawn/解析集中在 `lib/dsh.mjs`；异常试 rc.4 |
| npm `~/.npm/_cacache` 不可写 | `lib/dsh.mjs` 用 `OCC_NPM_CACHE` / `$TMPDIR/occ-npm-cache`；不要继承 `npm_config_cache` |
| Python 3.9 vs F10 的 3.10+ | 已用 `uv` 装 Python 3.12（`services/finance-analyst/.python-version`）；Docker 镜像 TODO，换机器后再做 |
| **本机是 macOS 虚拟机，不能跑 Docker** | Docker/Compose/镜像全部 TODO；开发用 `scripts/dev-db.sh`、`scripts/dev-qdrant.sh`、`scripts/dev-embeddings.sh` 的「散装」方式 |
| **WSL2 把 repo 放在 `/mnt/c` 会慢、file watch 失效** | repo 放 WSL2 Linux 文件系统（如 `~/OpenCorpCheck`）；Windows 宿主机用 WSL2 localhost forwarding 访问 UI/API |
| **脚本只考虑 macOS** | 新增脚本必须同时支持 Darwin/Linux；`dev-qdrant.sh` 按 `uname -s/-m` 选二进制，`dev-db.sh` 用 `PGBIN` 或从 PATH 找 `pg_ctl`；路径用 `node:path`/`URL` |
| **UI 写死平台分支** | renderer 不做 `navigator.platform` 分支、不依赖 native module/OS keychain；平台能力收在 Electron main/preload 后面 |
| 串行 backfill 太慢（Phase 0 的 7 家约 20 分钟） | `--concurrency 4`；Phase 1 用 pg-boss + worker 池 + per-domain 限流 + checkpoint |
| API key 泄露风险 | 不要 `pgrep -fl`（会打印 env）；用 `pgrep -f` 只看 PID；key 只放 `.env`/环境变量，绝不提交 |
| Eastmoney 反爬/ToS | 限流、重试、robots、attribution；不批量重分发 |
| dsh `--json` 8 KiB 截断 | 完整结果读 `phase0/.dsh-home/sessions` 明文 JSONL |
| 直接跑 dsh 时 `~/.dsh` 里已有 zstd session | 本项目 patch 用 `compression: none`，会报 backend 不匹配；设 `DSH_HOME=phase0/.dsh-home` 或临时目录 |
| MCP 工具不出现 | 先 `corepack pnpm -r build`；sidecar 要在 `:8090`；检查 `--dump-config` 里 `mcp-finance-analyst` 是否被 `insert` 进去 |
| 本机 Postgres 启动失败 `postmaster became multithreaded` | macOS 需要有效 locale：`scripts/dev-db.sh` 已设 `LC_ALL=en_US.UTF-8`；或手动 export |
| F10 enqueue 报 sidecar unreachable | enqueue 需要调 `GET /v1/f10/pages/{market}` 解析 preset；先起 sidecar，或显式传 `--pages cwfx,gsgk` |
| worker 队列深度/`--drain` 数字不对 | worker 直接读 `pgboss.job`，假设默认 `pgboss` schema；换 schema 需同步改 `apps/worker/src/queues.ts` |
| **`scripts/e2e-search.sh` 会 `occ seed --reset`，清空目标 DB + Qdrant** | 不要对真实研究语料运行；`occ seed`（即使不带 `--reset`）也会重写 24 家 seed 公司的 alias 和 company point。用 `node scripts/e2e-search.mjs` 直接跑 live 语料，或把 `DATABASE_URL`/`OCC_QDRANT_*` 指向一次性资源 |
| 旧语料没有 `is_fixture` payload / pinyin alias | 跑一次 `npm run sync:fixtures`（幂等）：重算 flag、回填 pinyin、修补 Qdrant payload |
| 默认搜索搜不到 fixture-only 公司（OpenAI/CATL/Cambricon 等） | 这是设计行为；调试时加 `include_fixtures=true`，真实 research 入库后自动转正 |
| 中文常用名搜不到（奈飞/好市多） | 目前 alias 只从 profile 的 name/ticker 派生；下一轮补 curated 中文 alias，见 `docs/EVAL.md` |
| pinyin alias 依赖 `pinyin-pro` | 只在 ingest/CLI 侧；搜索侧不需要该依赖。新增中文 alias 时用 `pinyinVariants`/`pinyinAliasForms` |
| **phase0 `npm run research -- --mock` 会无条件覆盖 `out/sections/` 并重组 `magnificent-seven.md` 等交付物** | 验证流水线后必须 `git checkout -- phase0/out/` 并删除 mock sections（2026-10-28 踩过，已恢复）；中间 section 想保留时先备份 |
| **旧版 worker 默认把 runs/sections 写进 `phase0/`（2026-10-28 已改）** | 曾覆盖 Phase 0 的 MAG7 事件日志，`phase0 && npm run validate` 因此 FAIL；已提交的 `magnificent-seven.md` 未受影响。现在 worker 默认写 `.occ/runs`、`.occ/sections`（`OCC_WORKER_SECTIONS_DIR`，兼容旧的 `OCC_SECTIONS_DIR`）。要重新校验 Phase 0 只能重跑那 7 家 |
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
- [x] P1 F10 sidecar 已完成；下一步做 P2.5（QQQ/NDX 100 家 backfill + 检索质量）。
- [ ] Docker 封装全部 TODO（本机 macOS 虚拟机不能跑 Docker，换机器后再做）；
      本机用 `scripts/dev-db.sh` / `dev-qdrant.sh` / `dev-embeddings.sh` 散装运行。
- [ ] 跨平台检查：UI 无 OS 分支；路径用 `node:path`/`URL`；脚本同时支持
      macOS + Linux/WSL2（`dev-qdrant.sh` 已按平台选二进制）。
- [ ] 并行 backfill：`--concurrency 4` 起步；Phase 1 用 pg-boss + worker 池，确认可断点续跑。
- [ ] 本地 DB：`scripts/dev-db.sh status` 正常；`node apps/worker/dist/cli.js status` 能看到队列。
- [x] `corepack pnpm -r test` 全绿（adapter 9 + MCP 3 + worker 26 + retrieval 10 +
      db 3 + api 5 + ingest 34）。
- [x] `node scripts/e2e-search.mjs` 通过（43/43；fixture 检查用
      `include_fixtures=true`，默认搜索验证 fixture 不可见）。
- [x] 语料隔离：`occ sync-fixtures` 后默认只返回 102 家真实 profile；
      `include_fixtures=true` 才返回 14 家 fixture-only 公司 / 31 篇 fixture 文档。
- [x] 评测扩编：`scripts/golden-queries.mjs` 7 个 family；hybrid ticker/name
      top1 100%、pinyin 100%、typo 95.8%、natural 78.1%（recall@5 100%）、
      zh-name 87.5%；结果写进 `docs/EVAL.md`。
- [ ] 不要把 `deepseek-v4-pro` 写回配置。
- [ ] 不要提交任何 key、token、cookie、`.env`。

---

## 10. 参考

- Phase 0 原始计划：`/Users/bowenxu/.claude/plans/phase-0-deliverable-ui-minimal-greedy-dove.md`
  （如果下个 agent 能访问本机；本文件已包含下一步任务，不依赖它）
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/SEARCH.md`](docs/SEARCH.md)
- [`docs/EVAL.md`](docs/EVAL.md)
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)
- [`docs/PRIOR_ART.md`](docs/PRIOR_ART.md)
- [`phase0/README.md`](phase0/README.md)
- [`config/universe.yaml`](config/universe.yaml)
- [`config/indices/ndx.yaml`](config/indices/ndx.yaml)
- `finance_analyst`（private）：`https://github.com/xubowenhaoren/finance_analyst`
  — Apache-2.0；用 `gh repo clone` / `gh api` 读取；不要提交其数据快照。
- `opportunity-radar`（public, MIT）：`https://github.com/xubowenhaoren/opportunity-radar`
  — Phase 0 skill 的方法来源，不是完整移植。
