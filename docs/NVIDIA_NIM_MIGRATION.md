# Headless NIM + Parallel migration — P0 (revised 2026-10-31: dual-mode)

> Status: **historical migration record (2026-10-31)**. NIM + Parallel was
> implemented headless-only, then **retired as the default at 14:16** after
> sustained per-model 429s. Official DeepSeek (`deepseek-flash` + official
> `web_search`/`web_fetch`) is the default; NIM remains opt-in with
> `OCC_LLM_PROVIDER=nvidia`. The interactive ACP sidebar is unchanged
> (official DeepSeek). Keep this document as the measured cost/latency record,
> not as current configuration.
>
> Revised **2026-10-31**: the migration is now
> **headless-only**. The interactive ACP sidebar keeps the official DeepSeek
> API and `deepseek-official` search/fetch; only the **local worker pool**
> (headless `dsh --profile headless`) moves to NVIDIA NIM + Parallel. The
> repo's DeepSeek key **stays**. Current config is in
> [`CONTEXT_TRANSFER.md`](../CONTEXT_TRANSFER.md) §2.
>
> Goal: run **unattended local backfill** on
> [NVIDIA NIM](https://build.nvidia.com) (`deepseek-ai/deepseek-v4.1-flash`) and
> **Parallel's free Search MCP** (`https://search.parallel.ai/mcp`, keyless,
> streamable HTTP). Near-zero marginal cost matters only for batch;
> the sidebar's interactive latency and quality are not traded away.
> The Claude Code coding session's own DeepSeek key lives outside this repo and
> must not be touched.

---

## 0. Non-negotiable constraints

1. **Do not touch the interactive path.** The ACP `acp` row, `reasoningEffort`,
   `OCC_AGENT_TURN_TIMEOUT_MS`, `apps/api/src/services/agent.ts`'s ACP env,
   `apps/web/src/lib/agent-trace.ts` and the sidebar's prompt/skills stay on
   official DeepSeek + `deepseek-official`. No model, timeout or tool-name
   changes there.
2. **Do not touch the coding session.** `~/.claude/`, `~/.claude.json`,
   `~/.ccs/`, shell profiles and global env are out of scope.
3. **No secrets in git.** Two keys, both gitignored:
   `DEEPSEEK_API_KEY.txt` (sidebar, already present) and
   `NVIDIA_API_KEY.txt` (worker, added to `.gitignore` on 2026-10-31).
   Parallel needs **no key**.
4. **The DeepSeek key stays.** It is still required by the sidebar. The worker
   must **not** inherit it accidentally: pass an explicit env whitelist to
   spawned dsh processes.
5. **No silent paid fallback** for the headless path. Use step-level retry plus
   plain-HTTP fetch; if Parallel is down the batch fails loudly.
6. **The repo's DeepSeek *content* is not the target.** Fixtures, the AI
   watchlist entry for 深度求索, and historical docs may keep mentioning
   DeepSeek; only the **headless** provider routes move.

---

## 1. What NVIDIA NIM gives us (checked + measured 2026-10-30/31)

| Item | Value |
|---|---|
| Base URL | `https://integrate.api.nvidia.com/v1` (OpenAI-compatible) |
| Model ID | `deepseek-ai/deepseek-v4.1-flash` |
| Context | 1M tokens (model card) |
| Capabilities | tool calling, streaming, image input, `reasoning_content` |
| Auth | `Authorization: Bearer $NVIDIA_API_KEY` (`nvapi-…`) |
| Free tier | no card; **~40 requests/minute per key**; TPM not published |
| Positioning | evaluation / prototyping, **no SLA**, endpoint may disappear |

`GET /v1/models` returns **85 models**, including `z-ai/glm-5.3-flash`,
`moonshotai/kimi-k2.6`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` and the
two DeepSeek ones. The older `deepseek-v4-flash` route is gone.

### 1.1 Measured behaviour (2026-10-30/31, this machine, ~35 RPM)

Same 10 prompts per model, streaming and non-streaming, plus tool/JSON probes:

| | DeepSeek v4.1-flash | GLM-5.3-flash |
|---|---|---|
| Streaming 10× | 9/10 with content (1 empty), p50 **14.3 s**, p95 27.4 s | 7/10 empty `content`, p50 4.6 s, +1× 120 s timeout |
| Non-stream 10× @256 | 0 failures, p50 **17.0 s**, p95 34.8 s | 30% empty `content`, p50 4.5 s |
| Long answer @1024 | 5.5–8.2 s | **67 s / 118 s / >150 s timeout** |
| JSON mode | ❌ JSON lands in `reasoning_content`, `content` empty | ✅ correct in `content` |
| `thinking:false` | ✅ honoured, reasoning tokens = 0 | ⚠️ 60 s timeouts; `chat_template_kwargs` works but still reasons |
| Tool calling | 3/3, 7–13 s | 3/3, 5–9 s |
| HTTP 500 | **episodic**: 3/10, then 0/10, 0/10 | none, but long-answer timeouts |

**Verdict: DeepSeek v4.1-flash only.** GLM is fast on trivial calls but needs
1–2 minutes for Chinese long-form, which is unusable for an 18-step research
run. The DeepSeek path needs four pieces of defensive code (§4.3):

1. **Step-level retry (3 attempts, backoff).** 500s return in <3 s, so retries
   are cheap. One 500 must not fail an 18-step company job.
2. **`thinking:false` for structured output.** With it, `response_format:
   json_object` returns valid JSON in `content` (1.4 s in the probe).
3. **Generous `max_tokens`.** Reasoning tokens count against the budget; a small
   cap yields an empty `content`. Use ≥512 for extraction, more for research.
4. **Normalise `reasoning_content → content`** when `content` is empty.

Measured latency means a company run now takes **≈3–8 min** instead of the
143 s p50 on the official API. That is acceptable for unattended batch only,
which is exactly why the sidebar does not move.

**Pilot measurement (2026-10-31, `HK:00700`):** one research turn took
**289 s** with ~99 k input / 6 k output tokens; ingest 27 s; the reviewer
(official DeepSeek) took ~73 s per cycle. The gateway aborted one hung call
after the 600 s timeout and the retry completed; the final profile was ingested
and the reviewer correctly ended `needs_review` after 2 revisions.

> **Open risk:** the free tier is for development/evaluation, has no SLA and
> already throws episodic 500s. There is no full-index sweep (§2); an
> operator-run batch of ≤20 is far below the rate ceiling.

---

## 2. Capacity math (measured in this repo, not guessed)

From `phase0/runs/*.jsonl` (102 companies) and `backfill_jobs` (102 completed
`research.company` jobs):

| Metric | Measured |
|---|---|
| LLM steps per company | avg **18.1**, p50 16.5, max 39 |
| Research job wall time | p50 **143 s**, p95 221 s, avg 153 s |
| Effective request latency | ~8.5 s |
| Transcript size | ~135 k chars / company |

**Decision 2026-10-31: no full A500/SPX backfill and no in-app research.** Both
indices stay placeholder-only; data is filled by an explicit, capped **operator
batch** run locally through the worker pool. The placeholder feature is
implemented ([`CONTEXT_TRANSFER.md`](../CONTEXT_TRANSFER.md) §10 P1.1) — this
doc only covers the provider/cost side. The numbers below are kept as the *reason*: they
describe the sweep we are **not** running. A capped batch is ~18 requests and
~3–8 minutes per company on NIM (see §1.1); the **research** step costs **¥0**
(NIM + Parallel free tiers). Reviewer and relation extraction stay on the paid
official API, so a batch is not literally free — see §5.4. The dominant costs
are wall-clock time and free-tier risk.

For reference, **if a full A500 + S&P 500 sweep (~1,000 companies) were ever
run**:

- ~**18,000 requests**. At 40 RPM that is **~7.5 h** at theoretical line rate.
- At the current `OCC_RESEARCH_CONCURRENCY=4`, throughput is ~28 RPM →
  **~10.5–11 h**. Raising concurrency to ~6 saturates 40 RPM.
- Token volume: roughly **390 k cumulative input tokens per company**,
  ~**400 M input tokens** for 1,000 companies. At concurrency 4 that averages
  **~600 k input tokens/minute**.

**Conclusion:** requests/minute is *not* the binding constraint at current
concurrency; the real limits are **tokens/minute (unpublished) and the free
tier's terms**. On-demand volume is far below all of them, which is why the
migration no longer needs a bulk-rate plan. Do not add a full-index sweep
without a new decision and a fresh cost estimate.

---

## 3. Current DeepSeek touchpoints (headless-only migration surface)

**Rule: if a file is only used by the ACP sidebar, do not touch it.**

| Area | File | What to change |
|---|---|---|
| Headless model route | [`phase0/dsh.patch.yml`](../phase0/dsh.patch.yml) `agent-default-model` | `provider: deepseek-official`, `model: deepseek-flash` → NIM route |
| **ACP sidebar route** | `@deepseek-ai/dsh-acp-app` bundle (`acp` row) | **NO CHANGE** — stays `deepseek-official` / `deepseek-flash` |
| **ACP reasoning** | [`.dsh/acp.patch.yml`](../.dsh/acp.patch.yml) `llm-deepseek` | **NO CHANGE** — `reasoningEffort: low` stays |
| **API config** | [`apps/api/src/config.ts:114`](../apps/api/src/config.ts#L114) | **NO CHANGE** — the API serves the sidebar and keeps `deepseekApiKey` |
| **ACP runtime env** | [`apps/api/src/services/agent.ts:223,260`](../apps/api/src/services/agent.ts#L223) | **NO CHANGE** — keeps `DEEPSEEK_API_KEY` preflight |
| CLI config | [`apps/cli/src/config.ts:57`](../apps/cli/src/config.ts#L57) | **NO CHANGE** — `occ extract` keeps official DeepSeek; the CLI only gains an NVIDIA key if it spawns headless research |
| **Relation extraction** | [`packages/extract/src/relations/llm.ts`](../packages/extract/src/relations/llm.ts) | **NO CHANGE** (decision 2026-10-31) — official DeepSeek, reasoning **on**; quality over cost for the fact/relation layer |
| **CLI extraction** | [`apps/cli/src/extract-command.ts:94`](../apps/cli/src/extract-command.ts#L94) | **NO CHANGE** |
| Worker config | [`apps/worker/src/config.ts:84`](../apps/worker/src/config.ts#L84) | add the NIM key for research jobs **alongside** the DeepSeek key used by ingest/extraction |
| Worker preflight | [`apps/worker/src/backfill.ts:56`](../apps/worker/src/backfill.ts#L56) | research requires `NVIDIA_API_KEY`; ingest/extraction still require `DEEPSEEK_API_KEY` |
| Worker dsh env | [`apps/worker/src/research/dsh.ts:96`](../apps/worker/src/research/dsh.ts#L96) | explicit per-job env whitelist: **research** child gets `NVIDIA_API_KEY` only; **reviewer** child gets `DEEPSEEK_API_KEY` only |
| **Worker ingest** | [`apps/worker/src/jobs/ingest.ts:154`](../apps/worker/src/jobs/ingest.ts#L154) | **NO CHANGE** — relation extraction stays on official DeepSeek |
| Phase 0 launcher | [`phase0/run.mjs:60`](../phase0/run.mjs#L60), [`phase0/lib/dsh.mjs:8`](../phase0/lib/dsh.mjs#L8) | NIM key preflight, `DEFAULT_MODEL = "deepseek-ai/deepseek-v4.1-flash"` |
| Model defaults | [`apps/worker/src/config.ts:80-81`](../apps/worker/src/config.ts#L80), [`apps/cli/src/config.ts:59`](../apps/cli/src/config.ts#L59) | `OCC_RESEARCH_MODEL` / `OCC_EXTRACT_MODEL` default to the NIM model id; leave API-side defaults alone |
| Web search/fetch (headless) | [`phase0/dsh.patch.yml`](../phase0/dsh.patch.yml), [`phase0/search-api.patch.yml`](../phase0/search-api.patch.yml) | replace `deepseek-official` / `deepseek-search-api` with the Parallel MCP mount — see §5 |
| **Web search/fetch (ACP)** | `.dsh/acp.patch.yml` | **NO CHANGE** — the sidebar keeps official search/fetch |
| Docs / templates | [`.env.example:39`](../.env.example#L39), [`docs/AGENT.md`](AGENT.md), [`docs/EXTRACT.md`](EXTRACT.md), READMEs | document the dual mode: sidebar = DeepSeek, worker/CLI = NIM + Parallel |

Headless `DEEPSEEK_*` reads to remove:
`grep -rn --exclude-dir=node_modules --exclude-dir=dist "DEEPSEEK" apps/worker apps/cli packages phase0`
Sidebar reads to keep: `apps/api`, `.dsh/`, `apps/web`.

---

## 4. Migration design

### 4.1 Register the NIM provider

dsh's model layer is `llm-pi-ai`. Register one provider route (ID `nvidia`):

```yaml
llm-pi-ai:
  providers:
    nvidia:
      apiKeyEnv: NVIDIA_API_KEY
      api: openai-completions        # not openai-responses
      baseURL: https://integrate.api.nvidia.com/v1
      models:
        - id: deepseek-ai/deepseek-v4.1-flash
          contextWindow: 1000000
          maxTokens: 32768            # verify against the NIM model card
          input: [text, image]
```

In a patch, `config` **replaces the whole row** — run `dsh --dump-config`
first and copy the existing `llm-pi-ai` fields into the patch. Same rule for
the `acp` and `agent-default-model` rows.

### 4.2 Point the headless profile at it (ACP unchanged)

Headless (`phase0/dsh.patch.yml`):

```yaml
- id: agent-default-model
  config:
    provider: nvidia
    model: deepseek-ai/deepseek-v4.1-flash
```

That is the only model row this migration touches. The ACP app does **not**
read `agent-default-model`, which is exactly why the sidebar stays on
`deepseek-official` without any patch change: `.dsh/acp.patch.yml`,
`reasoningEffort: low` and `OCC_AGENT_TURN_TIMEOUT_MS = 180000` remain as-is.

### 4.3 Environment and code (headless surface only)

- Add `NVIDIA_API_KEY` / `NVIDIA_API_KEY_FILE` (`NVIDIA_API_KEY.txt`, gitignored)
  and the NIM base URL/model as **new** config for the worker and the phase0
  launcher. Do **not** rename the API side's `deepseekApiKey` — the sidebar
  still uses it.
- **Two keys coexist in the worker**: research runs on NIM, while
  relation extraction (ingest) and the reviewer keep official DeepSeek with
  reasoning on. Do not collapse them into one key or one base URL.
- Pass an **explicit per-job env whitelist** to spawned dsh processes: the
  research child gets `NVIDIA_API_KEY` and **not** `DEEPSEEK_API_KEY`; the
  reviewer child gets `DEEPSEEK_API_KEY` and not `NVIDIA_API_KEY`. Today
  `runDshResearch` inherits `...process.env`, so a globally exported key would
  leak into the wrong child. Never unset anything in the user's shell.
- `packages/extract` is **not migrated**: `DeepSeekClient`, reasoning on, and
  the existing retry stay as they are. Keep its key path working.
- Worker preflight: research requires `NVIDIA_API_KEY`; ingest/extraction and
  the reviewer require `DEEPSEEK_API_KEY`.
- Reviewer profile: spawn `dsh --profile headless` with a **DeepSeek model row**
  (no NIM, no Parallel) and parse `{verdict, issues, fix_instructions}` from
  `content`. Reasoning stays on; no `response_format` dependency.
- Update `.env.example`, `docs/AGENT.md` (dual-mode section) and READMEs in the
  same commit. `docs/EXTRACT.md` only needs a note that extraction is unchanged
  and paid.

### 4.4 Rate limiting, 500s and timeouts

The 40 RPM budget is **per key**. Only the worker pool uses the NIM key now, so
a single in-process token bucket is enough; a Postgres/advisory-lock bucket is
only needed if worker shards run in separate processes.

- **Preferred:** a small local OpenAI-compatible gateway (LiteLLM or a ~100-line
  Fastify service) in front of NIM that enforces a token bucket
  (`OCC_NIM_RPM`, default 20; 36 caused 429s), **retries 500/502/503** with backoff, normalises
  `reasoning_content → content`, and logs tokens. Point headless dsh and the
  extract client at `http://127.0.0.1:4010/v1`. This is the only place retry
  logic needs to live, and it fixes the measured 500 rate in one shot.
  **Implemented:** `apps/worker/src/nim-gateway.ts`;
  `node apps/worker/dist/nim-gateway-server.js` runs it standalone so it can
  outlive any single worker process.
- **Minimum:** step-level retry in the dsh adapter plus a shared bucket.
- Timeouts: NIM p95 is ~60 s per call, so one company can take several minutes.
  Raise the headless research timeout; do **not** change
  `OCC_AGENT_TURN_TIMEOUT_MS` (sidebar only).
- An empty `content` with non-empty `reasoning_content` should be treated as a
  **retryable** condition for structured calls, not a valid empty answer.

---

## 5. Search/Fetch: Parallel Search MCP (headless profile only)

### 5.1 Decision

**All headless web search and fetch — Chinese and English — moves to Parallel's
free Search MCP.** The interactive sidebar keeps `deepseek-official`; that path
is faster and fresher for Chinese/HK news, and its volume is tiny. The quality
loss is accepted only for **backfilled data**, in exchange for zero marginal
cost. No full A500/SPX backfill (§2), so volume stays low.

### 5.2 What Parallel provides

| Item | Detail |
|---|---|
| Endpoint | `https://search.parallel.ai/mcp` (Streamable HTTP MCP) |
| Auth | **none** — keyless, no account |
| Tools | `web_search` (objective + `search_queries[]`, ranked URLs + ~2.4 k-char excerpts); `web_fetch` (up to 20 URLs, clean Markdown, JS/PDF) |
| Pricing | free for hobby/personal agents; paid API for production scale |
| Limits | no published quota, rate limit or SLA |

Verified live on **2026-10-30** from this machine: `initialize`, `tools/list`,
`web_search`, `web_fetch` all work without credentials, and two `dsh` headless
runs (`@deepseek-ai/dsh-mcp-client`, streamable-http) completed successfully.

### 5.3 Measured comparison (2026-10-30)

Four company-news queries (NVIDIA, 贵州茅台, 腾讯, Apple), 10 results each, plus
four page fetches:

| | DeepSeek Search/Fetch | Parallel MCP |
|---|---|---|
| Search latency | **0.55–0.58 s** | 0.79–1.37 s |
| Fetch latency | 3.4–19.9 s | **0.16 s** typical; 15.9 s on one anti-bot page |
| Chinese/HK freshness | **better** (Tencent 10/28–29 news; Maotai 上证报/证券时报) | usable, but Tencent top results included 2022 homepages |
| US/English sources | mixed (some odd domains) | **better** (NVIDIA newsroom, apple.com, Bloomberg) |
| Snippet depth | 0.6–1.2 k chars | ~2.4 k chars |
| Fetch content | cleaner on some pages | faster, handles pages plain HTTP/Jina cannot |

Maotai's “1309.71 亿” vs “1332.84 亿” is a revenue-caliber difference
(营业收入 vs 总营收), not an error. **Verdict: comparable enough for a demo;
Chinese quality is the accepted tradeoff.**

SearXNG was also evaluated via `uv` (Python 3.12, localhost, JSON enabled):
Baidu/Bing/DuckDuckGo failed (CAPTCHA/parsing), Sogou was intermittent, Brave
rate-limited, snippets were 40–160 chars and most results had no date. It was
**rejected** — not worth the operational cost, even as a fallback.

### 5.4 Cost

| Line | Cost |
|---|---|
| Parallel search/fetch (research) | **¥0** |
| NIM inference (research) | **¥0** |
| Reviewer (official DeepSeek, reasoning on) | paid, 1–3 runs per company |
| Relation extraction (official DeepSeek) | paid, unchanged from today |
| Sidebar (official DeepSeek) | unchanged paid usage, tiny volume |

Research itself is free; the quality gate is not. That is deliberate: the
reviewer's job is judgment, and NIM only returns reliable structured output
with `thinking:false` — the opposite of what a reviewer needs. Volume is small
(≈1–3 extra runs per company), so the paid share stays minor.

A hypothetical 1,000-company sweep would still be ~10 h and hit free-tier
limits, but it is not planned. A capped batch is ~18 requests / 3–8 min per
company. Record the real latency/500/failure numbers in the pilot.

### 5.5 Integration shape

Mount Parallel with the first-party MCP client (already present in the base):

```yaml
- insert:
    - id: mcp-parallel
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: psearch
        transport: streamable-http
        url: https://search.parallel.ai/mcp
        toolCallTimeoutMs: 90000
        failOnStartupError: false
```

Consequences to handle in the same change:

- Tool names become **`mcp__psearch__web_search`** and
  **`mcp__psearch__web_fetch`**. Update **headless only**: `phase0` prompts,
  the worker research prompt/skills, `phase0/lib/validate.mjs` tool counts,
  `phase0/lib/dsh.mjs` URL extraction (fetch input is a `urls` array) and their
  tests. **Do not change `apps/web/src/lib/agent-trace.ts`** — the sidebar still
  emits `web_search` / `web_fetch`.
- Remove/disable `deepseek-official` and `deepseek-search-api` **in the headless
  patch only**; leave the ACP patch untouched. `phase0/parallel.patch.yml` also
  disables `tool-web` so the model sees only `mcp__psearch__*` (the `web`
  service stays mounted, so there is no startup warning).
- Apply the MCP row to the **headless profile** (`phase0/dsh.patch.yml` or a
  separate `phase0/parallel.patch.yml`).
- **Fallback:** one retry on empty/error, then the built-in
  `dsh-web-fetch-http` tool for non-JS pages. No paid fallback — if Parallel is
  down, the batch fails loudly rather than silently spending money.
- **Risk accepted:** the free tier is hobby-grade, may rate-limit or vanish,
  and has no SLA. Acceptable for unattended backfill; the sidebar is unaffected.

---

## 6. Phased plan (headless only)

**Implementation status (2026-10-31): B, C and D are wired.** The provider row,
gateway, Parallel MCP mount, env whitelist and worker preflight are in the
repo. Verified probes: dsh on NIM, `mcp__psearch__web_search`,
`mcp__occ__f10_scrape` on HK, and a reviewer turn on official DeepSeek.
Phase E (capped batch) is the remaining measurement.

**Phase A — spike. ✅ Done 2026-10-30/31.** Direct API smoke test (chat,
streaming, tool calling, JSON mode, latency, error shapes) plus a head-to-head
against `z-ai/glm-5.3-flash`. Results in §1.1. DeepSeek v4.1-flash is the only
viable option; GLM was rejected on long-answer latency.

**Phase B — headless cutover.** Patch `agent-default-model`, env plumbing,
extract client, worker preflight; run a **quality sample** of 10 MAG7 + 5 A500 +
5 SPX companies one at a time (not a scheduled batch); diff profile structure,
citations and tool counts against the DeepSeek baseline; record
tokens/company, latency and 500 counts.

**Phase C — retry/normalisation layer.** Gateway (preferred) or adapter-level
step retry: 3 attempts + backoff on 500/502/503 and empty `content`, plus
`reasoning_content → content`. Inject a 500 and verify an 18-step run survives.

**Phase D — headless search/fetch cutover.** Mount Parallel MCP in the headless
profile, update prompt/skills/tool-count/URL-extraction for `mcp__psearch__*`
(§5.5), disable `deepseek-official` / `deepseek-search-api` there, and run one
US + one A + one HK company. Verify citations, fetch failures and retry
behaviour.

**Phase E — operator batch pilot.** Run 10–20 companies across US/A/HK as one
explicit capped batch at ≤ 36 RPM. Record per-company tokens, latency,
search/fetch failures, 500s and paid spend (research should be ¥0; reviewer +
extraction are paid). **No full index sweep** — A500/SPX have none by design
(§2). The sidebar is verified unchanged, not migrated.

**Phase F — docs + cleanup.** Remove `DEEPSEEK_*` reads only from the
**research** spawn path (env whitelist), keep them for ingest/extraction and
the reviewer. Update `docs/AGENT.md` and READMEs. `docs/EXTRACT.md` only needs
the "unchanged / still paid" note.

---

## 7. Rollback

Keep both **inference** routes registered for one release and select the
headless route with `OCC_LLM_PROVIDER=nvidia|deepseek`. Rollback = set the env
var back and restart the worker; the DeepSeek key is still present, so no key
resupply is needed. The ACP sidebar is never part of this switch.

For search, rollback is: remove the Parallel MCP row from the headless patch and
use plain HTTP fetch; there is no DeepSeek search fallback for the worker by
design. If Parallel is unavailable, fail loudly rather than silently spending
money. The sidebar keeps `deepseek-official` regardless.

---

## 8. Acceptance criteria

- **The ACP sidebar is untouched**: same model row, `reasoningEffort`,
  `OCC_AGENT_TURN_TIMEOUT_MS = 180000`, same search/fetch tools, same
  `agent-trace.ts` mapping. A normal question, a follow-up and
  resume-after-restart still answer correctly.
- `DEEPSEEK_API_KEY.txt` **still exists** and is gitignored;
  `NVIDIA_API_KEY.txt` is gitignored and absent from `git status`.
- Parallel Search MCP is mounted in the **headless profile only**;
  `mcp__psearch__web_search` / `mcp__psearch__web_fetch` are the only
  search/fetch tools used by the worker.
- Headless prompt, skills, `validate.mjs` and URL extraction recognize the MCP
  tool names; the web UI tools are unchanged.
- **Research** resolves `deepseek-ai/deepseek-v4.1-flash` on NIM; **reviewer,
  ingest/extraction, `apps/api` and `.dsh`** still resolve the official
  DeepSeek model.
- Env isolation: the **research** dsh child receives `NVIDIA_API_KEY` but not
  `DEEPSEEK_API_KEY`; the **reviewer** child receives `DEEPSEEK_API_KEY` but
  not `NVIDIA_API_KEY`.
- The reviewer runs with reasoning **on**; extraction is unchanged and also
  runs with reasoning on.
- `corepack pnpm -r --workspace-concurrency=1 test` is green.
- Live research works for one US, one A-share and one HK company with
  citations; relation extraction works on 5 companies.
- **Retry:** an injected 500 or an empty-`content` response is retried and an
  18-step company run completes; a 10-minute run at ≤ 36 RPM leaves no dead
  jobs.
- No API route, CLI command or schedule can enqueue the **full A500/SPX
  constituent set**; any batch is explicit, capped (`OCC_RESEARCH_BATCH_MAX`)
  and previewed before enqueueing. There is no in-app research endpoint.
- Paid spend: research is **¥0**; reviewer + extraction are paid but small.
  Record Parallel failure/retry counts and any NIM 500/429s in the handoff.
- The **coding session is unaffected**: the user's Claude Code still starts with
  its own DeepSeek key; no changes under `~/.claude*` or shell profiles.

---

## 9. Open questions (answered 2026-10-31 where measured)

1. ~~Does NIM accept `response_format: json_object`? Does it stream
   `reasoning_content`?~~ **Answered.** It accepts it but returns the JSON in
   `reasoning_content` with an empty `content`; with `thinking:false` the JSON
   lands in `content` correctly. `reasoning_content` streams normally in
   non-structured calls.
2. ~~Real TPM limit / 429 behaviour?~~ **Partly answered.** No `x-ratelimit-*`
   headers are exposed. The observed failure mode is **episodic HTTP 500**
   (~30% in one batch, 0% in others), not 429. Treat 500 as retryable.
3. ~~Does the ACP bundle expose the `acp` row?~~ **No longer relevant** — the
   ACP profile is not migrated.
4. Is Parallel's free MCP stable enough for unattended batch, and what happens
   on outage? Add retry + HTTP fetch fallback and log failures.
5. Does `mcp__psearch__web_fetch` need a larger timeout for anti-bot pages
   (one page took 15.9 s)? Does the 20-URL cap matter for our prompts?
6. ~~Is NIM's free tier acceptable for on-demand volume?~~ **Answered.** It is
   not acceptable for interactive use (p95 ≈ 60 s/call, episodic 500s), which
   is why only unattended backfill uses it. For a capped 10–20 company batch it
   is fine.

---

## References

- NVIDIA NIM model catalog: `https://build.nvidia.com/models`
- OpenAI-compatible endpoint: `https://integrate.api.nvidia.com/v1`
- Parallel Search MCP (free, keyless): `https://search.parallel.ai/mcp`,
  [announcement](https://parallel.ai/blog/free-web-search-mcp)
- dsh MCP client (streamable-http): [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md)
- dsh custom providers / `llm-pi-ai`: [DeepSeek Harness config guide](https://news.qiniu.com/archives/1788398802300)
- dsh ACP app provider/model row: `@deepseek-ai/dsh-acp-app` (npm)
- SearXNG (evaluated 2026-10-30, rejected): [source](https://github.com/searxng/searxng)
