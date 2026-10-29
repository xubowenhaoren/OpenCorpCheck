# OpenCorpCheck — Context Transfer

> 交接日期：2026-10-27（P3.4 tool trajectory + Markdown：2026-10-29）
> 当前阶段：Phase 0 + P1 + P2 + P2.5 + P3.1/P3.2 + P3.3 + P3.4（tool trajectory /
> Markdown）+ P3.5 已完成；sub-agent 卡片与事件持久化仍为预留。真实语料
> 已与 synthetic fixture 隔离（默认只搜索 102 家真实 profile），golden query 扩到 7
> 个 family、含 MRR@10/nDCG@10；公司卡片 API + CLI + MCP 已能读 cited 财务/事实/关系，
> 关系抽取走 deepseek-flash + 审核队列。中文 curated alias 已接入（zh-name top1
> 100%）；审核队列支持批量 accept/reject + 本地 HTML console；section/F10 快照已写入
> S3 兼容存储（本地 MinIO）。
>
> **P3.3（2026-10-29）**：`deep_research` MCP 入队（API → pg-boss → worker）、
> dsh ACP sidebar（`OCC_AGENT_DSH_HOME` + `occ` MCP 已实测调用）、Google News RSS
> 新闻文档入库（`doc_type='news'`，可搜索、进公司卡片 events）。Docker 封装仍全部 TODO。
>
> **P3.4（2026-10-29 部分实现）**：agent tool-use trajectory（折叠式工具卡片 /
> 计划 / 来源账本）和侧栏 GFM Markdown 已实现；sub-agent 卡片、事件持久化和
> 重放仍是预留设计。详见 §6 P3.4。
>
> **P3.5（2026-10-29）**：`apps/web` 已实现 docs/UI.md 的公开 UI（首页 / 搜索 /
> 公司页 5 tabs / 全局图谱 / NDX 100 家成分页 / 真实 ACP AI 助手侧栏），并补齐
> `/v1/graph`、`/v1/indices/:code`、`/v1/sectors`、搜索 `sector` 过滤。agent
> tool-use trajectory 与 Markdown 渲染随后在 P3.4 补齐（2026-10-29）。
>
> 下一阶段：P4（A500/HSI/SPX 快照 + A/HK 全量 backfill）或 P6（评测/质量），由用户决定。
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
- [`docs/UI.md`](docs/UI.md)
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

## 2. 当前状态（2026-10-29）

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
  config/aliases/zh.yaml           # curated 中文 alias（奈飞/好市多/茅台…）
  docs/
    ARCHITECTURE.md                # 完整平台设计（Phase 1+ 的主要参考）
    EXTRACT.md                     # P3：财务/事实/关系抽取、审核队列与读取方式
    AGENT.md                       # P3.3：dsh ACP sidebar、SSE 事件、权限
    NEWS.md                        # P3.3：Google News RSS 新闻入库
    DATA_SOURCES.md                # 数据源矩阵 + F10 复用方案
    PRIOR_ART.md                   # 竞品/开源生态扫描
    UI.md                          # P3.5：企查查式公司页 / 图谱 / 助手设计
  apps/
    web/                           # P3.5：React 19 + Vite 8 UI（docs/UI.md）
    cli/                           # MCP stdio server（F10 / 公司 / deep_research / get_run）
    worker/                        # pg-boss 并行 backfill（research / ingest / news / f10）
  packages/
    agent/                         # ACP client runtime（spawn dsh、事件归一化）
    core/                          # Zod 契约、类型、ULID
    db/                            # Drizzle schema + migrations
    ingest/                        # section markdown / news → documents/chunks → Qdrant
    extract/                       # section markdown → financials/facts/relations
    jobs/                          # 共享 pg-boss 队列 + backfill run store（API/worker）
    retrieval/                     # tokenizer / BM25 / BGE-M3 / Qdrant / RRF-DBSF
    storage/                       # S3/MinIO snapshot store（@aws-sdk/client-s3）
    sources/eastmoney-f10/         # TS adapter：Zod 校验 + summary/full 投影
    sources/news/                  # Google News RSS adapter（link-only）
  services/
    finance-analyst/               # Python sidecar：A/HK/US F10（uv + Playwright）
  prototypes/
    ui/index.html                  # 已确认的静态原型（mock 数据；npm run preview:ui）
  scripts/
    dev-db.sh                      # 本地 Postgres 17 init/start/stop
    dev-qdrant.sh                  # Qdrant 1.18 原生二进制
    dev-embeddings.sh              # BGE-M3 / reranker sidecar
    dev-minio.sh                   # 本地 MinIO（brew install minio 或 MINIO_BIN）
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
- [x] MinIO/S3 快照上传（2026-10-28，`packages/storage` + `occ snapshots`）。
- [ ] 待办：A500/HSI/SPX 成分股快照（P4；NDX 已完成）。
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
- [x] MinIO/S3 快照上传（2026-10-28）。worker/F10 → documents/chunks 已由
      `packages/ingest` 打通；section 与 F10 JSON 快照由 `packages/storage` 上传。
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
  hybrid 下 ticker / 英文名 / typo / pinyin / zh-name **top1 100%**、
  natural language 81.3%（recall@5 96.9%）、documents 80%（recall@5 100%）；
  公司 family p95 218–300ms，documents p95 366–473ms。
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
  - 已知缺口（2026-10-28 已修复）：原 NFLX 无“奈飞”alias、COST 无“好市多”alias，
    zh-name top1 87.5%，`Adboe` 排 ADBE 第 3；现由
    `config/aliases/zh.yaml` + `occ aliases sync` 补到 100%。

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
   - [x] ticker / 英文名 / 中文名 top1 100%（中文名由 curated alias 补齐）；
   - [x] 记录 100 家 backfill wall time（约 42 分钟）与 p50/p95；
   - [x] 搜索 p95（不含 rerank）220–383ms，整体 < 400ms。

注意：本机无 Docker，继续用 `scripts/dev-db.sh` / `scripts/dev-qdrant.sh` /
`scripts/dev-embeddings.sh`；QQQ 成分股会变，快照必须带 `as_of`；真实 F10/SEC 数据的
license 与引用纪律见 [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)。

### P3 — API / CLI / MCP / dsh ACP sidebar

**进度（2026-10-29）：P3.1 + P3.2 + P3.3 已完成。** 详见 [`docs/EXTRACT.md`](docs/EXTRACT.md)、
[`docs/AGENT.md`](docs/AGENT.md)、[`docs/NEWS.md`](docs/NEWS.md)。

- [x] `packages/extract`：确定性抽取 + deepseek-flash 关系抽取。
  - 财务表格（US/A/HK 单位与期间写法）、公司快照、分部收入、近 12 个月大事；
  - 引用解析（Markdown link 与东方财富裸 URL）、每行带 `source_refs` 与真实 URL；
  - 关系类型参考 Wikidata/schema.org + 开源供应链 KG；只允许库内公司；
    quote 必须是原文子串、ref 必须存在，否则丢弃；
  - 关系写 `status='inferred'` + `relation_evidence` + `review_queue`；
  - `extraction_cache` 按 section hash + prompt hash 缓存，重跑不重复调用 LLM。
- [x] DB：migration `0003_extraction.sql`（`period_kind/period_label/source_refs`、
  `review_queue.dedupe_key`、`extraction_cache`、evidence 唯一约束）。
- [x] API：`GET /v1/companies/:id?include=...` 公司卡片（ticker/slug/ULID）；
  `POST /v1/review/proposals`（201/重复 200）；`GET /v1/review/queue`。
- [x] CLI：`occ company <ref> --include ...`、`occ review list`、
  `occ propose fact|relation`、`occ extract --all|--index ndx|--tickers ...`。
- [x] MCP：新增 `search_companies`、`get_company`、`search_documents`、
  `propose_fact`、`propose_relation`（加 F10 共 7 个工具）。
- [x] worker：ingest 成功后跑确定性抽取（失败不影响入库）；
  `OCC_EXTRACT_RELATIONS=llm` 可开启 LLM 关系（默认 none）。
- [x] worker 产物目录隔离：默认 `.occ/runs` / `.occ/sections`。
- 验收（2026-10-28，live）：102 家、0 错误；2,834 条 `financial_facts`、
  1,200 条 `facts`、64 条 `inferred` 关系（35 家公司有边，ARM 8 条）；
  每条关系都有 evidence + 待审核条目，无自环；AAPL FY2025 营收 416,161 百万美元，
  600519 2025 营收 1,721 亿元；AAPL→GOOGL `buys_from` 带来源 URL；
  不加 `--force` 重跑命中关系缓存、不再调 LLM。
- [x] 运维补缺（2026-10-28）：
  - **curated 中文 alias**：`config/aliases/zh.yaml` + `occ aliases sync`
    （插 alias + pinyin 形式，并重索引 company point）。82 个 ticker / 81 家公司，
    新增 281 条 alias；zh-name eval 87.5% → **100%**（奈飞/好市多 top1）。
  - **审核队列批量**：`occ review approve|reject --ids|--kind|--company|--all --yes`
    （`--dry-run` 预览）；API `POST /v1/review/items/{id}/decision`、
    `POST /v1/review/batch`；本地 console `GET /v1/review/ui`。accept 抽取关系
    → `verified`、reject → `rejected`；accept fact proposal → `facts` 行 +
    `trust_tier='proposal'` source；只有 pending 迁移，重复调用幂等。
  - **MinIO/S3 快照**：`packages/storage`（`@aws-sdk/client-s3`）+
    `occ snapshots upload|check|list` + `scripts/dev-minio.sh`。102/102 section
    已上传为 `sections/<slug>/<sha256>.md`；ingest 对新/变更 section 自动上传。
    F10 页面以结构化 JSON 上传为 `f10/<market>/<code>/<page>/<sha>.json`；
    `documents.storage_key` / `f10_pages.storage_key` 现在是真实 `s3://` URI。
    raw HTML 仍待 sidecar 返回 bytes。
  - 验收：`pnpm -r test` 全绿；`node scripts/e2e-search.mjs` 43/43；hybrid eval
    ticker/name/typo/pinyin/zh-name 全 100%、natural 81.3%（recall@5 96.9%）、
    documents 80%（recall@5 100%）；快照重跑 0 上传 / 102 existing。

- [x] **P3.3（2026-10-29）**：
  - **`deep_research` MCP 入队**：`POST /v1/research` → `@occ/jobs` 创建
    `backfill_runs/backfill_jobs` 行 + pg-boss `research.company` job；MCP 工具
    `deep_research` 返回 `runId/jobKey`，`get_run` 轮询 `GET /v1/runs/{id}`。
    API 进程自己持有 PgBoss，不 spawn worker CLI；worker 无需任何特殊分支。
    只支持有可识别交易所 listing 的公司；私有公司（无 ticker）返回 400。
  - **共享 queue/run store**：新包 `packages/jobs`（`QUEUES`、`ensureQueues`、
    `JobStore`）由 API 和 worker 共用，避免两套 SQL；migration `0005_runtime_runs.sql`
    把 `backfill_runs/backfill_jobs/research_cache/f10_pages` 纳入 `occ migrate`。
  - **dsh ACP sidebar**：`packages/agent` 的 `DshAcpRuntime` spawn
    `dsh --profile acp`，`initialize` + `session/new`（stdio MCP = `occ`），把
    `session/update` 归一化成 `AgentEvent`；API 端点
    `POST /v1/agent/sessions`、`POST /v1/agent/sessions/{id}/prompt`（SSE）、
    `.../cancel`、`GET /v1/agent/ui`（无构建步骤的 HTML sidebar）。
    **必须用独立 `OCC_AGENT_DSH_HOME`（默认 `.occ/dsh-acp-home`）**：ACP profile 用
    zstd session，`phase0/.dsh-home` 是明文 `.jsonl`，共享会 `session/new` 失败。
  - **新闻文档入库**：新包 `packages/sources/news` 抓 Google News RSS（link-only，
    10 条/公司、30 天、每公司 1 次请求）；worker 新队列 `news.company`；
    `packages/ingest` 的 `ingestNews` 写 `documents(doc_type='news')` + 1 chunk +
    Qdrant；标题+摘要 sha256 幂等；公司卡片 `events` 和 `search_documents?doc_type=news`
    都能读到。命令：`occ-backfill enqueue news --tickers AAPL --max-items 10`。
  - **验收（live）**：AAPL deep_research 入队并 `get_run` 返回 queued；ACP session
    创建后 `只回复 OK` 正常流式返回，第二轮 `search_companies 苹果` 实际调用
    `mcp__occ__search_companies` 并回答 `AAPL — Apple Inc.`；AAPL 新闻 5 篇入库、
    重跑 5 条全部 skipped、0 embedding；新闻可被 documents 搜索和公司卡片 events 读取。
  - `corepack pnpm -r --workspace-concurrency=1 test` 全绿（news 4 + API 22 + CLI 7 +
    worker 26 + ingest 39 + extract 22 等）。并行 `pnpm -r test` 在本机会因共享
    `node_modules/.vitest-cache` 偶发 `ENOTEMPTY`，串行跑即可。

原始 P3 设计（保留）：

- Hono + Zod + OpenAPI + SSE；`/v1/search/companies`、`/v1/companies/{id}`、
  `/v1/research`、`/v1/runs/{id}/events` 等。
- `occ` CLI + `occ mcp --stdio`；MCP tools：`resolve_entity`、`search_companies`、
  `get_company`、`get_financials`、`get_relations`、`get_news`、`search_documents`、
  `propose_fact`、`propose_relation`、`deep_research`。
- dsh ACP sidebar（`@deepseek-ai/dsh-acp` + `@agentclientprotocol/sdk`）；可选 Cordis
  插件 `sidebar.right.pane.tab`。
- Phase 0 的 headless runner 继续用于批量文档生成；ACP 用于交互式 sidebar。

### P3.4（2026-10-29：tool trajectory + Markdown 已实现；sub-agent/持久化预留）— Agent trajectory

> **实现状态（2026-10-29）**：`apps/web` 侧栏已支持
> 折叠式 tool-use trajectory（计划 + 工具卡片 + 来源账本 + 用量）和 GFM Markdown
> 渲染。纯前端，不依赖持久化；`deep_research` 目前以「发起深度研究」工具卡片呈现。
> 子代理专属卡片、`get_run` 进度轮询、事件持久化/重放仍按下文预留设计。
>
> 2026-10-29 用户提出：UI 设计要为 dsh agent 的 trajectory 预留空间，重点是
> **tool use（主要是 web search）** 和 **sub-agent（主要是 agentic web search 查公司
> 信息）**。目标用户仍是股民/普通金融从业者，所以默认
> 界面保持「答案 + 来源」，执行过程是**可展开的渐进披露**，不是默认展开的调试面板。

**现状（已经有的，不要重复造）**

- `packages/agent/src/events.ts` 已把 ACP `session/update` 归一化为 `AgentEvent`：
  `tool.called` / `tool.updated` 带 `callId`、`title`、`tool`、`kind`、`status`、
  `input`、`output`；另有 `plan`、`thought.delta`、`usage`、`notice`、
  `permission.requested`、`session.update`、`run.completed` / `run.failed`。
- ACP v1 的 `ToolKind` 已包含 `search` / `fetch` / `execute` / `other`，
  `ToolCallStatus` 是 `pending|in_progress|completed|failed`，`rawInput`/`rawOutput`
  是 unknown。web_search 预计是 `kind='search'`，web_fetch 是 `kind='fetch'`；
  MCP 工具通常是 `kind='other'`，`title`/`name` 里带 `mcp__occ__*`。
- `apps/api` 通过 SSE 把 `AgentEvent` 逐条推给 `/v1/agent/ui`，但**没有持久化**；
  `AgentService` 的 session 只在内存里，API 重启即丢。
- `deep_research` MCP 工具已经能把研究任务入队到 pg-boss（`research.company`），
  由 worker 跑 headless dsh + `company-profile`/`mag7-profile` skill；`get_run`
  轮询进度。它不是 dsh 的同步 sub-agent，但**是公司研究子任务的现成载体**。
- 当前 UI 设计（`docs/UI.md` §8）刻意不显示工具名/JSON/token，只显示
  “查了公司资料 · 看了 3 个来源”。这是默认形态，不要改。

**已知 bug（2026-10-29 用户实测，当日已修复）**

- **现象**：在 `apps/web` 的 AI 助手侧栏问「goog 今天股价大跌，是什么原因？」后，
  侧栏长时间没有回答，只显示「查了 14 次资料 · 0 个来源」，看起来卡在 thinking。
- **原因**：dsh ACP profile 的 reasoning effort 是适配器默认的 `high`；单轮没有
  turn / tool-call / 超时上限，工具循环可以一直跑。关闭侧栏不会取消，只有停止按钮会。
- **修复（2026-10-29）**：
  - `.dsh/acp.patch.yml` 通过 `--patch` 注入 ACP profile，patch `llm-deepseek`
    条目设 `reasoningEffort: low`。**重要**：ACP 会话的模型路由来自 `dsh-acp`
    自己的 `provider`/`model` config，**不读 `agent-default-model`**；DeepSeek
    适配器只接受 `off|low|high|max`，**没有 `medium`**。`dsh --patch` 是整块替换
    `config`（非深合并）。headless 仍用 `phase0/dsh.patch.yml`。
  - `DshAcpRuntime.prompt()` 加每轮硬上限：`OCC_AGENT_TURN_TIMEOUT_MS`（默认 180s）
    和 `OCC_AGENT_MAX_TOOL_CALLS`（默认 30）；超限先 `session/cancel`，等 5s 的
    `stop`，再发 `notice` + `run.failed`，不再静默卡死。
  - `AgentService` 空闲 `OCC_AGENT_IDLE_TIMEOUT_MS`（默认 10 分钟）后 dispose dsh
    进程和 MCP 子进程；UI 持有的旧 session id 由 alias 透明映射到新会话。
  - 关网页（`pagehide`）用 `sendBeacon` 补发 cancel；关侧栏仍然不取消（用户确认）。
  - 验证：`packages/agent` 3 个 turn-limit 单测、`apps/api` 4 个 AgentService
    单测（空闲 dispose / prompt 中不 dispose / alias 重映射 / cancel 映射）全绿；
    `dsh --dump-config` 确认 patch 合并；会话日志 `request/header` 确认实际请求为
    `deepseek-v4-flash + reasoningEffort=low`。
  - **真实 UI 实测**（Playwright 打开 `:5173` 侧栏，同一问题「goog 今天股价大跌，
    是什么原因？」）：`high` 76.9s / 15 次工具 / 11 个来源（已完成）；
    `low` 61.8s / 13 次工具 / 4 个来源（已完成）。两次都远低于 180s 上限。
- **已实现（2026-10-29）**：tool-use trajectory——折叠行「执行过程 N 步 · M 个来源 ·
  42s」；展开显示 plan、每个 `tool.called/tool.updated` 一张人话卡片
  （搜索网页 / 打开网页 / 查找公司 / 查看公司资料 / 检索资料 / 发起深度研究 /
  查询研究进度 / F10 / propose_*）、去重来源账本（已引用 / 仅查阅）和 token 用量。
  不显示原始 JSON、token 流或 `thought.delta`。实现见
  [`agent-trace.ts`](apps/web/src/lib/agent-trace.ts)、
  [`AgentTrace.tsx`](apps/web/src/components/AgentTrace.tsx)、
  [`AgentSidebar.tsx`](apps/web/src/components/AgentSidebar.tsx)。
  `packages/agent/src/runtime.ts` 在 SSE 前把 `rawInput/rawOutput` 截到 4 KB / 16 KB
  （保持形状），避免整页 HTML 进浏览器。
- **仍未实现**：sub-agent 专属卡片（`deep_research` 目前只是一张工具卡片，
  没有 `get_run` 状态轮询/嵌套轨迹）、事件持久化/重放、侧栏「仍在思考/即将超时」
  独立状态。

**已知问题（2026-10-29 用户实测，下一轮处理）**

1. **Trajectory 不够“灵动”**：现在是答案下方一个永久存在的折叠块，展开后把
   31 张工具卡片一次性铺出来。用户希望像 Grok Web 那样：
   - 每次触发新的 tool call，先在答案区域**临时出现**一张活动卡片（运行中转圈）；
   - 该调用完成后**自动收起**成一行摘要，不长期占空间；
   - 新一轮调用出现时，上一轮自动折叠；同一类调用（如 4 次 `web_search`）合并成
     「执行了 4 次搜索」+ 缩进子行，而不是 4 张等高卡片；
   - 整轮结束后收成一行「工作了 13s · 执行了 4 次搜索 · 打开 6 个网页」，
     默认不再展开；用户主动点开才看完整时间线。
   - 参考视觉：用户提供的 Grok 截图（“工作了 13s”“执行了 4 次搜索”
     “已搜索网络 为 …”）。不要照搬品牌，只借交互节奏。
   - 实现建议（纯前端即可）：每个 tool call 增加 `active/completed` 状态机；
     新调用到来时关闭上一张卡片；完成 300–500ms 后自动折叠；按 `tool/kind`
     分组合并；答案开始流式输出时把活动区收成一行。
   - **不要**把“自动收起”做成信息丢失：展开后仍能看到完整工具卡片、来源账本
     和用量。默认视图只保留答案 + 来源 + 一行摘要。

2. **30 次工具上限误伤正常深度研究**：2026-10-29 16:03 用户问
   「goog 今天股价大跌，是什么原因？」，侧栏显示
   `Turn stopped after 30 tool calls to avoid an endless loop
   (OCC_AGENT_MAX_TOOL_CALLS).`，没有最终答案。
   - **现场 session**：
     `.occ/dsh-acp-home/sessions/--Users-bowenxu-Downloads-Projects-OpenCorpCheck---/c643c443-c390-4f17-bef9-d1ae10a6cebf/session.v4.jsonl.zstd`
     （16:03，约 95s；`turn/end` 为 `{kind:"aborted", reason:{kind:"user"}}`，
     即被 runtime 的 cancel 终止）。
   - **已观测**：该 turn 共 32 次 tool call：
     18 `web_fetch` / 6 `bash` / 5 `web_search` /
     1 `mcp__occ__search_companies` / 1 `get_company` / 1 `search_documents`；
     不是同一个 query 的死循环，而是广度高、持续换源的 research：
     先搜新闻 → 抓 4 个媒体页 → bash 查 SEC 8-K → 抓 IR/SEC → 再搜再抓 10+ 个域名。
     工具结果没有明显 `isError=true`（需要下个 agent 再核对原始 result 文本与 HTTP
     状态；不要只信 `isError`）。
   - **怀疑的 root cause（按优先级，下个 agent 用 session 验证）**：
     1. `OCC_AGENT_MAX_TOOL_CALLS=30` 对所有工具一视同仁，且网络研究天然是
        search → fetch ×N；上一次同类问题 13–15 次，这次 32 次，30 的阈值太低。
     2. 模型不知道剩余预算，runtime 只在超限后 cancel，没有“还剩 N 次”的提示；
        dsh 没有 budget-aware prompt。
     3. `SYSTEM_CONTEXT` 要求“所有数字和关系都要带引用”，促使模型不断补来源。
     4. 媒体付费墙/反爬（401/403/JS challenge）或 `web_fetch` 截断可能让模型
        换 URL 重试；需要用原始 `tool/result` 文本确认。
     5. `reasoningEffort: low` 是否降低规划效率（重复补搜）需要 A/B；
        历史上 low 61.8s/13 calls，high 76.9s/15 calls，尚未复现 30+。
     6. 计数器是否把同一 callId 的重复 `tool.called` 重复计数：对比 session 的
        32 次 vs 侧栏的 31 张卡片 vs runtime 的 30 次上限，确认 ACP 是否多发；
        当前证据更支持“确实调用了 30+ 次”，不是重复计数。
   - **排查命令**（本机）：
     ```bash
     SID=c643c443-c390-4f17-bef9-d1ae10a6cebf
     F=.occ/dsh-acp-home/sessions/--Users-bowenxu-Downloads-Projects-OpenCorpCheck---/$SID/session.v4.jsonl.zstd
     zstd -dc "$F" | python3 -c '…统计 tool/call、tool/result、turn/end…'
     ```
     重点看：`request/header`（实际 model / reasoningEffort / tools）、
     `turn/start` → `step/start` → `tool/call` → `tool/result` → `assistant/message`、
     `turn/end`、每个 result 的 `isError`/HTTP 状态/truncated 标记。
   - **建议修复方向**（不要只调大数字）：
     - 把“防死循环”从绝对次数改成**预算 + 重复检测**：相同
       `(tool, normalized input)` 重复出现 N 次才判定 loop；总预算可按问题类型
       配置（如普通问答 30、深研 60–80）。
     - 超限前先给模型一次“预算将尽，请基于已有证据作答”的 notice/prompt；
       或让 dsh 在接近上限时收到摘要提示。
     - UI 在运行中显示「已查阅 N 个来源 / 已执行 M 步」，超限时明确告知
       “已停止继续搜索，基于现有资料回答”，而不是只报错。
     - `0 个来源` 的显示有误导：本次 18 个网页已抓取，但摘要只统计“已引用”；
       运行中/失败时应显示“已查阅”，并在 trace 里保留 ledger。
   - **验收**：同一问题在调整后能给出带引用的答案；若仍超预算，UI 显示
     “已查阅 N 个来源”并允许一键“继续研究”；session 里不出现同一 query
     的连续重复；`turn/end` 不是被 runtime 强制 abort（除非用户点停止）。

**已修复（2026-10-29）：侧栏不渲染 Markdown**

- **原现象**：侧栏回答原样显示模型输出的 Markdown 源码——`## 一句话结论`、
  `**搜索广告增速放缓**`、`| 项目 | 数值 |` 表格、`---` 分隔线、
  `[StockAnalysis](https://…)` 都是字面文本。
- **根因**：`AgentSidebar` 的 `Linkified` 只切 URL；`apps/web` 没有 Markdown 依赖；
  `.msg .bubble { white-space: pre-wrap; }` 是按纯文本设计的。
- **修复**：
  - 新增 [`MarkdownMessage.tsx`](apps/web/src/components/MarkdownMessage.tsx)：
    `react-markdown@10` + `remark-gfm@4`，由 `AgentSidebar` 用
    `lazy(() => import(...))` 懒加载；主 bundle 不含解析器。
  - GFM：标题、粗体/斜体、列表、引用、表格、分隔线、行内代码、代码块、链接。
    表格包在 `.md-table-wrap` 里横向滚动；390px 下页面无横向滚动。
  - 流式：`AgentSidebar` 每 ~90ms 合并一次 `assistant.delta` 再 setState，避免
    每个 token 重新解析整段；未闭合 ``` / 半张表格不会崩。
  - 安全：不使用 `dangerouslySetInnerHTML`；react-markdown 默认转义原始 HTML；
    图片覆盖为 alt 文本（不远程加载）；链接只放行 http/https 并带
    `target=_blank rel="noopener noreferrer"`；`javascript:` 链接降级为文本。
  - 样式：新增 `.md` 系列规则，沿用 CSS tokens（深浅色都可读）；
    `.msg.user/.msg.system` 仍是 `pre-wrap` 纯文本。
- **验收（2026-10-29）**：
  - 真实 ACP 会话（Playwright，`goog 今天股价大跌…`）：13–31 次工具调用，
    答案按 Markdown 渲染，trace 折叠行显示「执行过程 N 步 · M 个来源 · 49s」。
  - 确定性 mocked SSE（覆盖模型不一定输出的语法）：`h2`、`strong`、2 行 GFM 表格、
    列表、引用、`hr`、行内代码全部正确；可见文本中无字面 `**` / `## ` / `|---|` /
    ```；注入 `<script>`、`<img onerror>`、`[x](javascript:…)` 均不执行，
    DOM 中无 `img/script`、无 javascript 链接；无 console error。
  - 未闭合代码块：渲染为 `pre`，不出现字面 ```，不崩溃。
  - 390×900：`document.scrollWidth == innerWidth`，宽表格在气泡内横向滚动。
  - 构建：主 JS 393 KB（gzip 121 KB），Markdown 懒加载 chunk 163 KB（gzip 49 KB），
    CSS 40 KB（gzip 8 KB）。
  - 单测：`apps/web` 8 个 trajectory helper 测试（工具描述、计数、来源账本、
    URL 提取、plan、duration）；`packages/agent` 6 个测试含 payload 截断。
    `corepack pnpm -r --workspace-concurrency=1 test` 全绿。
- **保留未做**：`apps/api/src/agent-ui.ts` 的零依赖 debug console 仍用
  `textContent`（不渲染 Markdown），它是内部排错页，不是面向用户侧栏。


**目标形态（用户看到什么）**

运行中（live，Grok-like；本轮未实现）：

- 每次新 tool call 临时出现一行活动卡片（运行中显示 spinner + 人话动作）。
- 调用完成 300–500ms 后自动收起到一行；下一次调用出现时，上一张自动收起。
- 同类调用合并：「执行了 4 次搜索」+ 缩进的查询子行；网页抓取同理。
- 答案开始流式输出时，整个活动区收成一行「工作了 13s · 执行了 4 次搜索 ·
  打开 6 个网页」；用户点开仍能看到完整时间线。

默认（collapsed）：

- 答案 + 引用 chips。
- 一行摘要：「执行过程 6 步 · 3 个来源 · 42s」+ 展开箭头。
- 失败/权限/子代理运行中：摘要行显示状态，不打断答案。

展开（trajectory）：

1. **计划/步骤**（`plan.entries`）：短句，如
   “查公司资料 → 搜最近新闻 → 核对来源”。
2. **工具卡片**：
   - `web_search`：查询词、结果数、域名 top 3、耗时、“已引用 2 条”。
   - `web_fetch`：页面标题、域名、是否成功、“已引用”。
   - MCP：`search_companies` / `get_company` / `search_documents` /
     `deep_research` / `get_run` / F10，显示人话标题（“查公司资料”“查财报”
     “发起深研”），不显示 JSON；展开可看输入/输出的**摘要**和来源。
   - `propose_fact` / `propose_relation`：显示“已提交审核”，不显示写入成功。
3. **子代理卡片（sub-agent）**：
   - 名称：如“公司研究子代理（agentic web search）”。
   - 任务：一句话，如“为 Apple 搜集最新业务、财务和关系”。
   - 状态：排队 / 运行中 / 完成 / 失败 / 取消。
   - 进度：步数或 job progress（deep_research 用 done/total）；当前步骤。
   - 展开：嵌套的子轨迹（它自己的 web_search / web_fetch / MCP 调用），
     最多显示一级嵌套，更深层折叠为“查看全部”。
   - 完成：摘要 + 引用数 + “查看研究结果 / 公司页”链接。
   - 失败：人话错误 + 重试/取消。
4. **来源账本（source ledger）**：去重后的 URL 列表，分“已引用 / 仅查阅”，
   带标题、域名、抓取时间；点击打开现有来源浮层。
5. **预算/用量**：步数、tokens、耗时；默认折叠在“详情”里，不干扰普通用户。

规则：

- **默认不显示 `thought.delta`（原始思考链）**。只显示 plan 摘要和动作；
  调试模式（local only）才显示原始事件流。
- 移动端：trajectory 放在答案下方，默认折叠；子代理嵌套最多一级。
- 工具卡片和子代理卡片都用 `details/summary` 或等价组件，键盘可达；状态不只靠颜色。

**事件模型（预留扩展，保持向后兼容）**

在 `AgentEvent` 上增加：

```ts
| { type: "tool.progress"; callId: string; progress?: number; message?: string }
| { type: "subagent.started"; subagentId: string; parentCallId?: string;
    name: string; task: string;
    kind: "web_research" | "deep_research" | "other" }
| { type: "subagent.event"; subagentId: string; event: AgentEvent }
| { type: "subagent.completed"; subagentId: string;
    status: "completed" | "failed" | "cancelled";
    summary?: string; citations?: Citation[]; usage?: Usage }
| { type: "citation"; url: string; title?: string; quote?: string;
    retrievedAt?: string; stepId?: string }
```

- `tool.called` / `tool.updated` 继续用 ACP 字段；在 runtime 里按 `kind` 映射成
  人话：`search` → 搜网页，`fetch` → 打开网页，`other` + `mcp__occ__*` → 内部工具。
- 子代理来源优先级：
  1. 若 dsh 暴露 `task` / `subagent` / `agent` 工具或嵌套 session，按
     `parentCallId` 归一化成 `subagent.*`；
  2. 否则把 `deep_research` 的 pg-boss job 当作第一种子代理：入队时发
     `subagent.started`，进度来自 `get_run` / job 状态，完成时带 run id 和
     profile 链接。
- 不要把 `session.update` 的原始 payload 直接给 UI；只在 debug 模式保留。
- 原始工具输出先摘要化：白名单字段 + 长度上限，绝不把整页 HTML/JSON 塞进 DOM。

**持久化（预留）**

- 新增表（或复用 ARCHITECTURE §5.1 的 `research_runs` / `research_steps` 设计）：
  - `agent_sessions`：id、question、model、status、started_at、completed_at、
    stop_reason、usage、cost。
  - `agent_steps`：session_id、seq、parent_step_id、kind（plan/tool/subagent/
    citation/notice）、tool_name、tool_kind、status、input_summary、
    output_summary、latency_ms、error、started_at、completed_at。
  - `agent_citations`：session_id、step_id、url、title、quote、retrieved_at。
- API：
  - `GET /v1/agent/sessions/{id}`：会话摘要 + steps 树。
  - `GET /v1/agent/sessions/{id}/events`：重放（SSE 或 JSON）。
  - `GET /v1/runs/{id}` 增加 steps/events（deep_research 子代理）。
- 保存的是**摘要**，不是完整网页/原始 prompt；原始网页仍走 snapshots/S3。
- 会话重放需要 `seq` 和 `parent_step_id`，保证子代理嵌套顺序稳定。
- 关闭侧栏是否结束会话：目前是「关闭即结束，下次新会话」；持久化后可以改为
  “保留最近一次会话，重新打开可回放”。

**UI 预留（在现有侧栏里留位置）**

- 侧栏 420px；答案消息下方预留一个 `.agent-trace` 折叠块（默认 collapsed）。
- 折叠行高度固定（约 32px），不改变消息气泡宽度；展开时在消息内滚动，不撑破侧栏。
- 子代理卡片用缩进 + 左边线表示层级；最多一级嵌套，更多用“查看全部”。
- 来源 chip 复用现有 `SourceSheet`；trajectory 里的 URL 也打开同一个浮层。
- 状态颜色：running 蓝、completed 绿、failed 红、cancelled 灰；同时给文字状态。
- 不把 trajectory 放进公司页主内容；它属于助手侧栏。

**后端/协议缺口**

1. 用一次 live session 记录 dsh 0.2.1-rc.3 对 web_search/web_fetch 实际发出的
   `tool_call` 字段（`kind`、`name`、`rawInput`、`rawOutput` 形状）；如果字段不稳定，
   在 runtime 里做 defensive mapping，不要让 UI 绑到 dsh 原始 payload。
2. 确认 dsh 是否有 sub-agent/task 工具；没有就把 `deep_research` 当第一种 sub-agent。
3. 事件持久化 + 重放端点。
4. 工具输出摘要化（白名单 + 截断 + 错误脱敏）。
5. 取消传播：取消主 session 时，子代理/队列 job 也要能取消或标记 abandoned。
6. 安全：web 内容是 untrusted；工具输出按文本渲染，不解析 HTML；`propose_*`
   只进审核队列；不展示原始 CoT。

**未来验收（P4/P6 再做，不在本轮）**

- 问「Apple 最近和谁合作？」：默认看到答案 + 4 个来源 + 「执行过程 7 步」折叠行；
  展开看到 2 次 web_search、3 次 web_fetch、1 次 get_company、1 个子代理；
  子代理展开有自己的 3 次搜索和摘要；每个来源可点开原文；不出现原始 JSON、
  token、tool name 或思考链。
- 问「帮我研究一下宁德时代」：触发 deep_research 子代理；卡片显示
  queued → running → completed；完成后可跳到 run 详情/公司页；失败可重试。
- 取消：主 session 取消后，子代理显示 cancelled，不再追加事件。
- 关闭再打开侧栏（持久化后）：trajectory 可回放，顺序和来源不丢。

**实现顺序（未来）**

1. 先加事件模型和 runtime mapping（web_search/web_fetch/tool kind）。
2. 再做折叠式 tool timeline（纯前端，不依赖持久化）。
3. 加 `deep_research` 子代理卡片（job 状态 + get_run 轮询）。
4. 加事件持久化 + 重放端点。
5. 最后接 dsh 原生 sub-agent/task（如果存在）。
6. 始终保留默认「答案 + 来源」形态；trajectory 是可选展开。

### P3.5（2026-10-29）— Web UI 已实现（tool trajectory + Markdown 随后补齐）

**状态**：`apps/web` 已按 [`docs/UI.md`](docs/UI.md) 落地。首页、搜索结果、公司页
5 个 tab（基本资料 / 财务数据 / 关系图谱 / 新闻动态 / 资料来源）、全局图谱、
NASDAQ-100 成分页、AI 助手侧栏都可用。侧栏的 tool-use trajectory 和 GFM
Markdown 渲染已在 P3.4 补齐；sub-agent 卡片与持久化仍为预留设计。

**技术栈**：React 19 + Vite 8 + TypeScript + React Router 7 +
TanStack Query 5；样式沿用原型 CSS tokens（暖灰 + 绿色），**未引入**
Tailwind / shadcn/ui。Vite dev server 绑定 `127.0.0.1:5173`，`/v1` 代理到
`127.0.0.1:8787`；生产静态托管仍 TODO。

**命令**：

```bash
# API 必须先在 8787 运行
node apps/api/dist/server.js
corepack pnpm dev:web          # http://127.0.0.1:5173
corepack pnpm build:web        # apps/web/dist
```

**页面与行为**：

- `/` 首页：hero 搜索、热门公司、A/HK/US 市场入口、NASDAQ-100（100 家）入口、
  最近查看（localStorage）。顶部导航在首页隐藏搜索框，避免和 hero 重复。
- `/search?q=`：公司混合搜索，支持 market / index / sector 过滤；
  每行显示名称、ticker、国家、行业、指数、两行描述；不显示 score/matchType。
- `/c/:ref`：页头 + 5 tab。`ref` 接受 ticker、slug、中文 alias、ULID。
  - 基本资料：一句话介绍、收入分部条、关键数字、基本信息、最近动态、右栏
    主要股东/对外投资/相关公司；无关系时显示“暂无公开关系数据”+ 让助手去查。
  - 财务数据：6 个指标卡 + 按 statement 分组的年度/季度表，行级来源按钮，
    单元格可点击打开来源浮层；数字按原币种格式化（中/英文单位不同）。
  - 关系图谱：1/2 层、类型筛选、只看已核实、图谱/列表切换、缩放/拖拽、
    节点/边 inspector、证据 quote + 来源、无数据空状态。
  - 新闻动态：时间线，来源按钮打开浮层。
  - 资料来源：按 trust tier 分组、去重、引用计数、复制全部引用、打开原文。
- `/graph?company=`：全局图谱；无 company 时显示公司选择器；已选公司时显示
  切换搜索和“问一问”。
- `/indices/NDX`：100 家 QQQ 成分股（公司、ticker、行业、国家、指数、操作），
  支持文本和行业筛选；A500/HSI/SPX 未加载时显示空状态。
- AI 助手侧栏：真实 `POST /v1/agent/sessions` + SSE prompt/cancel；
  桌面 420px、右侧滑出、主内容让位、无遮罩；手机全屏；支持公司上下文、
  建议问题、停止、来源 URL 转 chip。回答渲染 GFM Markdown；tool-use
  trajectory 默认折叠（展开可见 plan / 工具卡片 / 来源账本 / 用量）。
  **不显示原始 JSON、token 流或思考链。**
- 主题：浅色/深色，`data-theme` + localStorage；语言：中/英切换（UI chrome
  和数字格式切换，公司数据保持原文）。

**后端新增（与 UI 一起提交）**：

- `GET /v1/graph?company=&depth=1|2&status=&types=&limit=`：
  ego network；返回 `center`、`nodes`、`edges`、`depth`、`truncated`。
  depth 2 最多展开 40 个邻居，边按 status/confidence 排序并截断。
- `GET /v1/indices/:code`：指数成分；NDX 返回 100 家公司，带 ticker /
  sector / markets / as_of；`index_code` 大小写不敏感。
- `GET /v1/sectors`：搜索行业过滤值（fixture 隐藏）。
- `GET /v1/search/companies` 新增 `sector` 过滤；Qdrant `must` + 内存
  `matchesCompanyFilters` 双侧生效。
- `@occ/db` 新增 `listIndexCompanyIds`（按 company 去重、取最新 as_of）和
  `listSectors`。
- `@occ/core` 新增 `CompanyGraphQuerySchema` / `CompanyGraphView` /
  `IndexMemberView` / `IndexView`；`SearchCompaniesQuery` 增加 `sector`。

**验收（2026-10-29，live）**：

- `corepack pnpm --filter @occ/web typecheck` 通过；`build` 通过
  （JS ~376 KB，gzip ~115 KB）。
- Playwright 1440×1100 / 390×900：
  - 首页、搜索、公司页 5 tabs、NDX 100 行、全局图谱、图谱空状态均正常；
  - 无 console error，无横向滚动；
  - AI 助手真实 SSE：公司页打开侧栏，输入「只回复 OK」→ 回复 OK；
  - 浅色/深色、中/英切换正常。
- 搜索相关性 guard：短中文查询无 exact/alias 且 top dense < 0.35 时，
  UI 显示“没找到 + 问助手”，避免向量近邻把无关公司当结果。实测：
  `宁德` / `宁德时代`（当前可见语料没有 CATL）→ 空状态；`白酒` → 贵州茅台
  top1；`Apple` → Apple top1。
- 图谱实测：AAPL 3 边、ARM 8 边、NVDA 14 边；环形布局按节点数自适应
  （≤6 节点放大视图，>6 节点 960×720），标签不再重叠；2 层 NVDA 26 个节点。
- 财务：AAPL 年度 3 期、季度 1 期；每个数字有来源浮层；无来源行显示 `—`。
- 指数：NDX 100 家，`as_of 2026-10-28`（日期按 date-only 格式化，不受时区影响）。

**已知限制 / 下一步**：

- **投资/股权关系仍然稀疏**：当前 relations 只有
  `partners_with` / `supplies` / `other` / `buys_from` / `licenses_to` /
  `joint_venture_with`，没有 `invests_in` / `owns` / `parent_of`。所以
  “投资股权”计数大多是 0，图谱有空状态但没有投资边。需要 P4 的
  GLEIF / SEC 13F / 股东数据补强；UI 不要伪造。
- 行业字段覆盖不全：NDX 中不少公司 `sector` 为 null，指数页显示 `—`。
- 英文模式只翻译 UI chrome 和数字格式；公司描述、分部名等数据保持原文。
- 未引入 Tailwind / shadcn/ui；如要迁移，先保持 CSS tokens 不变。
- 生产静态托管未做：开发用 Vite proxy；生产需 API/nginx 同源托管。
- AI 助手侧栏是 P3.3 的真实 SSE；tool-use trajectory 与 Markdown 已实现
  （2026-10-29）。**sub-agent 专属卡片（deep_research job 进度/嵌套轨迹）和
  事件持久化仍未实现**，不要把它们当成已完成。
- 构建体积（2026-10-29）：主 JS 393 KB（gzip 121 KB）、Markdown 懒加载 chunk
  163 KB（gzip 49 KB）、CSS 40 KB（gzip 8 KB）。
- 首页热门公司是前端静态列表；没有运营后台。
- `apps/web` 没有单测；目前用 Playwright 手动验收。后续 P6 加 UI smoke。

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
>
> **UI 不受 Docker 阻塞（2026-10-29）**：`apps/web` 是 web-first 的 React 应用，
> 可直接用 Vite + 本机 API 开发；设计见 [`docs/UI.md`](docs/UI.md)。Electron 壳
> 和 Docker 打包仍留在 P5，等换机器。当前只有 `/v1/agent/ui`、`/v1/review/ui`
> 两个零依赖 HTML console。
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
  （BGE-M3 sidecar）、`scripts/dev-minio.sh`（MinIO；`brew install minio` 或
  `MINIO_BIN`）、`scripts/e2e-search.sh`。这些就是本机的「散装」运行方式。

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
13. **中文常用名走 curated 文件**：`config/aliases/zh.yaml` + `occ aliases sync`，
    不要在代码里硬编码，也不要指望模型从英文 profile 里“猜”出奈飞/好市多。新增
    中文名只改 YAML，再跑一次 sync（会顺带重索引 company point）。
14. **快照存储是可选 S3 兼容层**：未配置 `OCC_S3_*` 时 ingest/worker 完全不变；
    配置后 section markdown 和 F10 JSON 都会上传，上传失败只告警、不阻塞入库。
    F10 raw HTML 需要 sidecar 未来返回 bytes，当前快照是结构化 page JSON。
15. **API 与 worker 共用 `@occ/jobs`**：`backfill_runs/backfill_jobs` 和 pg-boss
    队列只有一份实现；API 的 `deep_research` 直接创建同样的 run/job 并 send，
    worker 不需要区分来源。新增队列/run kind 时先改 `packages/jobs`。
16. **ACP 与 headless 用不同 `DSH_HOME`**：headless 的 patch 是 `compression: none`
    （`phase0/.dsh-home`），ACP profile 是 zstd（`.occ/dsh-acp-home`），不能混用。
17. **新闻是 link-only 覆盖层**：Google News RSS 只存标题/摘要/链接，不抓正文、
    不批量重分发；需要正文时新增 adapter 写同样的 `documents` 形状，不要把 RSS
    摘要当审计事实。
18. **Agent trajectory 是渐进披露，不是调试面板**：默认只显示答案 + 来源 + 一行
    「执行过程 N 步」；展开才显示 tool calls / web search / sub-agent。不显示原始
    JSON、token 或思考链（`thought.delta`）；原始事件只留给 local debug。子代理
    优先复用 `deep_research` 的 pg-boss job，不新造一套同步 sub-agent 协议。
    **2026-10-29 已实现** tool cards / plan / 来源账本（纯前端，无持久化）；
    sub-agent 卡片仍按此原则预留。
19. **Web UI 先落地，不引入 Tailwind/shadcn**：`apps/web` 用 React 19 + Vite 8 +
    React Router 7 + TanStack Query 5，样式沿用原型的 CSS tokens，保证和已确认的
    视觉一致。后续要迁 Tailwind/shadcn 时先保持 tokens 不变；Electron/Docker 仍在 P5。
20. **搜索相关性 guard 放在 UI 层**：短中文查询（≤8 字）没有 exact/alias/fuzzy
    命中，且 top dense score < 0.35 时，UI 显示“没找到 + 问助手”，不展示向量
    近邻的无关公司。API/CLI 的原始结果不变，方便 eval 继续观测；示例：
    `宁德` / `宁德时代` 在当前可见语料（没有 CATL）下为空，`白酒` 仍返回茅台 top1。
21. **图谱布局按节点数自适应**：≤6 个节点放大视图（800×640），>6 个节点用
    960×720；直接邻居按等角环形排布，不再按固定类别扇区排（固定扇区在某一类
    有 7–10 个节点时会重叠）。颜色仍按关系类别分组。
22. **ACP 侧栏必须有硬上限**（2026-10-29）：`.dsh/acp.patch.yml` patch
    `llm-deepseek` 设 `reasoningEffort: low`（ACP 不读 `agent-default-model`；
    适配器无 `medium`）。每轮有 `OCC_AGENT_TURN_TIMEOUT_MS` +
    `OCC_AGENT_MAX_TOOL_CALLS`，超限先 `session/cancel` 再发 `notice` +
    `run.failed`；空闲 `OCC_AGENT_IDLE_TIMEOUT_MS` 后 dispose dsh。
    关侧栏**不**取消（用户明确要求），关网页用 `pagehide` beacon 取消。

---

## 8. 已知坑 / 风险

| 坑 | 处理 |
|---|---|
| dsh 是 developer preview，接口会变 | 固定 `0.2.1-rc.3`；spawn/解析集中在 `lib/dsh.mjs`；异常试 rc.4 |
| **dsh 侧栏长时间 thinking / 0 来源无回答** | 已修复（2026-10-29）：ACP patch 在 `llm-deepseek` 设 `reasoningEffort: low`（无 medium 档）；`OCC_AGENT_TURN_TIMEOUT_MS` / `OCC_AGENT_MAX_TOOL_CALLS` 超限自动 cancel；空闲 dispose。见 §6 P3.4「已知 bug」 |
| **正常深度研究被 30 次工具上限打断** | 待排查（2026-10-29）：问题「goog 今天股价大跌」触发 `OCC_AGENT_MAX_TOOL_CALLS`，session `c643c443-…`，32 次调用（18 fetch / 6 bash / 5 search）。这不是明显死循环，更像阈值太低 + 无预算提示。排查步骤和建议见 §6 P3.4「已知问题 2」；不要只把数字调大 |
| **侧栏把 Markdown 当纯文本显示** | 已修复（2026-10-29）：`apps/web` 用懒加载的 `react-markdown` + `remark-gfm`，`.md` 样式 + 表格横向滚动；`AgentSidebar` 90ms 合并流式文本。不要改回 `dangerouslySetInnerHTML`；`agent-ui.ts` debug console 仍是纯文本 |
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
| `f10.page` 有 1 个 failed / 死信 | 那是 2026-10-27 的 **FAILCO 假 ticker 负向测试**（sidecar 停机时验证死信）；sidecar 起来后直接抓 FAILCO 仍会 `EmptyRender`，不是真实故障。真实重跑用 `enqueue f10 --tickers AAPL:US --pages cwfx,gsgk --force` |
| worker 队列深度/`--drain` 数字不对 | worker 直接读 `pgboss.job`，假设默认 `pgboss` schema；换 schema 需同步改 `apps/worker/src/queues.ts` |
| **`scripts/e2e-search.sh` 会 `occ seed --reset`，清空目标 DB + Qdrant** | 不要对真实研究语料运行；`occ seed`（即使不带 `--reset`）也会重写 24 家 seed 公司的 alias 和 company point。用 `node scripts/e2e-search.mjs` 直接跑 live 语料，或把 `DATABASE_URL`/`OCC_QDRANT_*` 指向一次性资源 |
| 旧语料没有 `is_fixture` payload / pinyin alias | 跑一次 `npm run sync:fixtures`（幂等）：重算 flag、回填 pinyin、修补 Qdrant payload |
| 默认搜索搜不到 fixture-only 公司（OpenAI/CATL/Cambricon 等） | 这是设计行为；调试时加 `include_fixtures=true`，真实 research 入库后自动转正 |
| 中文常用名搜不到 | 先加到 `config/aliases/zh.yaml`，再跑 `occ aliases sync`（它会重索引 company point）；只改文件不跑 sync 不生效 |
| MinIO 官方下载 410 | 2026-10 起 `dl.min.io` 返回 410；本机用 `brew install minio`，或设 `MINIO_BIN` 指向任意 S3 兼容二进制；`scripts/dev-minio.sh` 会优先用 PATH 里的 `minio` |
| 快照上传报 hash mismatch | `documents.sha256` 与 section 文件不一致：先 `occ ingest --force` 再 `occ snapshots upload`，不要强行上传不同内容 |
| 审核 accept/reject 语义 | 只有 `pending` 会迁移；accept 抽取关系→`verified`、accept fact proposal→写 `facts` + proposal source；reject 关系→`rejected`（不删行）。批量必须有 `--ids/--kind/--company/--all --yes` |
| pinyin alias 依赖 `pinyin-pro` | 只在 ingest/CLI 侧；搜索侧不需要该依赖。新增中文 alias 时用 `pinyinVariants`/`pinyinAliasForms`，`occ aliases sync` 已自动生成 |
| **phase0 `npm run research -- --mock` 会无条件覆盖 `out/sections/` 并重组 `magnificent-seven.md` 等交付物** | 验证流水线后必须 `git checkout -- phase0/out/` 并删除 mock sections（2026-10-28 踩过，已恢复）；中间 section 想保留时先备份 |
| **旧版 worker 默认把 runs/sections 写进 `phase0/`（2026-10-28 已改）** | 曾覆盖 Phase 0 的 MAG7 事件日志，`phase0 && npm run validate` 因此 FAIL；已提交的 `magnificent-seven.md` 未受影响。现在 worker 默认写 `.occ/runs`、`.occ/sections`（`OCC_WORKER_SECTIONS_DIR`，兼容旧的 `OCC_SECTIONS_DIR`）。要重新校验 Phase 0 只能重跑那 7 家 |
| `occ extract --relations llm` 报 key 缺失 | 用 `DEEPSEEK_API_KEY_FILE=DEEPSEEK_API_KEY.txt` 或 export `DEEPSEEK_API_KEY`；模型固定 `deepseek-flash`（`OCC_EXTRACT_MODEL` 可改，但不要用 Pro） |
| 关系是 `inferred`，不是审计事实 | API/MCP 都返回 `status`；引用要给 `evidence.quote` + source URL；人工审核前不要当 verified |
| 财年结束日同时是 Q4 结束日 | `financial_facts_uq` 已含 `period_kind`（migration 0004），确定性 id 也含 period_kind；不要退回四列唯一键 |
| 没有 `--approval-policy`（rc.3） | 用 `DSH_PERMISSION_MODE=read-only`；不要在命令里加不存在的 flag |
| `deepseek-official` 搜索每次是一次模型 turn | 预算控制；必要时用 `search-api.patch.yml` 切直接 HTTP |
| 来源偏 stockanalysis、SEC 少 | Phase 1 接 F10 + SEC XBRL；profile 标注未验证项 |
| GOOGL/NVDA 各 1 个 search-summary 来源 warn | 不是 fail；可在 validator 加 `searchOnly` 分类或去 query 归一化 |
| **ACP `session/new` 报 `Internal error`，stderr 说 session 用了 `.jsonl` 但后端是 zstd** | ACP 用独立 `OCC_AGENT_DSH_HOME`（默认 `.occ/dsh-acp-home`）；不要把 `phase0/.dsh-home` 给 ACP（那里是 `compression: none` 的明文 session） |
| **dsh ACP session 创建失败但只看到 `Internal error`** | `packages/agent` 会把 dsh stderr 尾部附在错误里；再不行用原始 JSON-RPC 脚本发 `initialize` + `session/new` 看 `error.data.details` |
| **`deep_research` 对 OpenAI/Anthropic 等私有公司返回 400** | 当前要求公司有可识别交易所的 `securities`；私有公司 profile 走 CLI/backfill，等 P4 实体解析后再开放 |
| **`deep_research` 是异步的，立刻 `get_company` 看不到新 profile** | 用 `get_run` 轮询到 completed；research 完成后 worker 会自动 enqueue `ingest.company` |
| **新闻入库报 `company not found`** | 先 ingest 该公司 research profile；news job 按 ticker 解析已存在的 company |
| **Google News RSS 是 link-only、约 10 条/公司** | 不抓正文、不做批量重分发；feed terms 限个人/非商业阅读。需要正文时另建 adapter 写同样的 `documents` 形状 |
| **新闻重跑显示 `skipped=5`** | 这是幂等：标题+摘要 sha256 未变，不重写、不重 embedding；不是故障 |
| **`pnpm -r test` 偶发 `ENOTEMPTY: node_modules/.vitest-cache`** | 多个 package 并行启 vitest 抢同一个 cache 目录；用 `pnpm -r --workspace-concurrency=1 test` |
| **API 进程会持有 pg-boss 连接** | 关 API 用 SIGTERM（会 stop boss + close job store）；不要直接 `kill -9`，否则 pgboss job 可能停在 active 直到 expire |

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
      top1 100%、pinyin 100%、typo 100%、natural 81.3%（recall@5 96.9%）、
      zh-name 100%；结果写进 `docs/EVAL.md`。
- [x] 中文 alias：`config/aliases/zh.yaml` 覆盖 NDX + A/HK；`occ aliases sync`
      插入 281 条并重索引 77 家公司；奈飞/好市多/开市客等 top1。
- [x] 审核队列：`occ review approve|reject` 批量 + `POST /v1/review/batch` +
      `/v1/review/ui`；accept 关系→verified、accept fact→materialize，幂等。
- [x] 快照：`packages/storage` + `occ snapshots upload|check|list`；
      102/102 section、2 个 F10 page JSON 已上传；重跑 0 新上传。
- [x] `corepack pnpm -r test` 全绿；`node scripts/e2e-search.mjs` 43/43。
- [x] P3.1/P3.2：`packages/extract` + migration `0003/0004` + 公司卡片 API +
      `occ company/review/propose/extract` + 5 个 MCP 公司工具；
      `docs/EXTRACT.md` 记录命令、关系类型、校验规则和已知限制。
- [x] P3 剩余（2026-10-29 完成）：`deep_research` MCP 入队、dsh ACP sidebar、
      新闻文档入库；见 [`docs/AGENT.md`](docs/AGENT.md)、[`docs/NEWS.md`](docs/NEWS.md)。
- [x] P3.5 Web UI（2026-10-29）：`apps/web` 实现 docs/UI.md 的公开 UI
      （首页 / 搜索 / 公司页 5 tabs / 全局图谱 / NDX 100 家 / AI 助手侧栏）；
      `pnpm --filter @occ/web typecheck` + `build` 通过；Playwright 桌面/手机
      和真实 ACP 聊天验收通过；后端新增 `/v1/graph`、`/v1/indices/:code`、
      `/v1/sectors`、搜索 `sector` 过滤。
- [x] P3.4 bug（2026-10-29）：ACP patch 在 `llm-deepseek` 设 `reasoningEffort: low`
      （ACP 不读 `agent-default-model`；适配器无 medium 档）；
      每轮 `OCC_AGENT_TURN_TIMEOUT_MS` / `OCC_AGENT_MAX_TOOL_CALLS` 上限；
      空闲 dispose dsh；关网页自动 cancel（关侧栏不 cancel）。
- [x] AI 助手侧栏 Markdown 渲染（2026-10-29）：`react-markdown` + `remark-gfm`
      懒加载、90ms 流式合并、GFM 表格横向滚动、原始 HTML 不执行、链接白名单；
      真实 ACP + mocked SSE + 390px Playwright 验收通过。
- [x] P3.4 tool-use trajectory（2026-10-29）：折叠行 + 计划 + 工具人话卡片 +
      来源账本 + 用量；`packages/agent` 对 tool payload 做 4KB/16KB 截断。
- [ ] P3.4 剩余：sub-agent 专属卡片（`deep_research` 状态轮询/嵌套轨迹）、
      事件持久化与重放。
- [ ] P3.4 UX v2（2026-10-29 用户要求，未实现）：Grok-like 临时活动卡片，
      单次调用完成即自动收起、同类合并、整轮结束后一行摘要；见 §6 P3.4
      「已知问题 1」。
- [ ] P3.4 预算 bug（2026-10-29 待排查）：正常深度研究触发
      `OCC_AGENT_MAX_TOOL_CALLS`；先查 session `c643c443-…` 和 §6 P3.4
      「已知问题 2」，再决定预算/重复检测方案。
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
