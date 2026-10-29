# Agent sidebar (dsh ACP)

> Status: P3 · 2026-10-29
> Related: [Architecture](ARCHITECTURE.md) §8 · [Company facts](EXTRACT.md) · [News](NEWS.md)

The sidebar is a thin ACP client around DeepSeek Harness. It does not embed dsh's
web UI and does not call the model API directly:

```text
Browser sidebar (/v1/agent/ui)
   │  POST /v1/agent/sessions/:id/prompt  (SSE)
   ▼
apps/api AgentService
   │  spawn: dsh --profile acp (stdio, NDJSON JSON-RPC)
   ▼
DshAcpRuntime (packages/agent)
   │  session/new  mcpServers: [{ name: "occ", command: node, args: [apps/cli/dist/mcp.js] }]
   ▼
occ MCP server → OpenCorpCheck API / finance-analyst sidecar
```

## What exists

| Piece | Package | Responsibility |
|---|---|---|
| ACP client runtime | [`packages/agent`](../packages/agent) | Spawn dsh, initialize ACP, create sessions, map `session/update` to `AgentEvent` |
| Session service | [`apps/api/src/services/agent.ts`](../apps/api/src/services/agent.ts) | One dsh process, in-memory sessions, prompt/cancel/cancel-on-disconnect |
| HTTP surface | [`apps/api/src/app.ts`](../apps/api/src/app.ts) | Session create, SSE prompt, cancel, HTML sidebar |
| Sidebar UI | [`apps/api/src/agent-ui.ts`](../apps/api/src/agent-ui.ts) | Dependency-free debug console (raw tool cards) |
| Consumer sidebar | [`apps/web/src/components/AgentSidebar.tsx`](../apps/web/src/components/AgentSidebar.tsx) | React sidebar: GFM Markdown, collapsed tool trajectory, source ledger |

The `occ` MCP server exposes nine tools to the agent: `search_companies`,
`get_company`, `search_documents`, `deep_research`, `get_run`, `propose_fact`,
`propose_relation`, `f10_pages`, and `f10_scrape`. See
[apps/cli/README.md](../apps/cli/README.md).

## Run it

```bash
# 1. build packages + MCP server + API
corepack pnpm -r build

# 2. local services
scripts/dev-db.sh start
scripts/dev-qdrant.sh start
scripts/dev-embeddings.sh start
node apps/api/dist/server.js

# 3. open the sidebar
open http://127.0.0.1:8787/v1/agent/ui
```

The F10 tools need the Python sidecar:

```bash
cd services/finance-analyst && uv run occ-f10 serve --port 8090
```

The agent needs a DeepSeek key. `apps/api` reads, in order:

1. `DEEPSEEK_API_KEY` in the environment,
2. the file named by `DEEPSEEK_API_KEY_FILE`,
3. `DEEPSEEK_API_KEY.txt` in the repo root (gitignored).

## API

```bash
POST /v1/agent/sessions                 # 201 { data: { sessionId } }
POST /v1/agent/sessions/{id}/prompt     # text/event-stream
POST /v1/agent/sessions/{id}/cancel
GET  /v1/agent/ui                       # local HTML sidebar
```

`prompt` streams one SSE frame per normalized event:

| Event | Payload |
|---|---|
| `run.started` | `sessionId`, full prompt |
| `thought.delta` | `text` |
| `assistant.delta` | `text`, `messageId` |
| `tool.called` | `callId`, `title`, `kind`, `status`, `input` |
| `tool.updated` | `callId`, `status`, `input`, `output` |
| `usage` | `used`, `size`, optional `cost` |
| `notice` | `severity`, `title`, `description` |
| `permission.requested` | `callId`, `title`, `option` |
| `session.update` | raw unknown ACP update |
| `run.completed` | `stopReason`, raw response |
| `run.failed` | `error` |

Raw ACP types never reach the browser. If dsh changes its update payloads, only
`packages/agent/src/runtime.ts` changes. `tool.called.input` and
`tool.updated.output` are capped at 4 KB / 16 KB (shape-preserving, with a
`…[truncated]` marker) before they are sent over SSE; the sidebar further
reduces them to human summaries and links.

## Configuration

| Env | Default |
|---|---|
| `OCC_AGENT_ENABLED` | `true` |
| `OCC_AGENT_DSH_HOME` | `.occ/dsh-acp-home` |
| `OCC_AGENT_PERMISSION_MODE` | `read-only` |
| `OCC_AGENT_DSH_PATCH` | `.dsh/acp.patch.yml` (`none` disables) |
| `OCC_AGENT_TURN_TIMEOUT_MS` | `180000` (3 min per turn) |
| `OCC_AGENT_MAX_TOOL_CALLS` | `30` per turn |
| `OCC_AGENT_IDLE_TIMEOUT_MS` | `600000` (10 min; `0` disables) |
| `OCC_DSH_VERSION` | `0.2.1-rc.3` |
| `OCC_NPM_CACHE` | `$TMPDIR/occ-npm-cache` |
| `OCC_FINANCE_ANALYST_URL` | `http://127.0.0.1:8090` |
| `DEEPSEEK_API_KEY` / `_FILE` | required |

### Turn budget and the ACP patch

The sidebar is interactive, not batch research, so the API passes
`.dsh/acp.patch.yml` to `dsh --patch`. It patches the `llm-deepseek` provider
entry with `reasoningEffort: low` (the shipped default is `high`, which made a
single market-event question run 15+ tool calls). Two dsh details matter:

- The ACP bridge routes sessions with its own `provider`/`model` config and
  never consults `agent-default-model`; setting effort there is a no-op.
- The DeepSeek adapter accepts `off` / `low` / `high` / `max` only — there is
  no `medium`. `low` is the closest usable value.

`dsh --patch` replaces an entry's `config` wholesale (it does not deep-merge),
so any field you want to keep must be repeated. Headless backfill keeps using
`phase0/dsh.patch.yml`.

Measured 2026-10-29 with the same question (“goog 今天股价大跌，是什么原因？”):
`high` 76.9 s / 15 tool calls / 11 sources; `low` 61.8 s / 13 tool calls / 4
sources. Both finish well inside the 180 s turn cap.

`DshAcpRuntime.prompt()` enforces two hard limits per turn: wall-clock
`OCC_AGENT_TURN_TIMEOUT_MS` and `OCC_AGENT_MAX_TOOL_CALLS` tool calls. When a
limit is hit the runtime sends `session/cancel`, waits up to 5 s for dsh's
`stop`, then emits a `notice` plus `run.failed` instead of hanging silently.
The sidebar counts `tool.called` events, so the limit also stops the
"14 tool calls · 0 sources · no answer" loop.

### Cancellation and idle disposal

- Stop button: aborts the SSE fetch **and** calls `/cancel`.
- Closing the browser page/tab: the sidebar sends a `pagehide` beacon to
  `/cancel` as a backup for the aborted fetch.
- Closing the sidebar panel alone does **not** cancel; the turn keeps running
  (deliberate: users often hide the panel while reading).
- When no prompt has run for `OCC_AGENT_IDLE_TIMEOUT_MS`, `AgentService`
  disposes the dsh process (and its `occ` MCP child). The UI keeps its old
  session id; the next prompt transparently starts a fresh dsh session under
  that id (conversation history is lost).

### Trajectory and Markdown (2026-10-29)

The React sidebar (`apps/web`) renders assistant answers as GitHub-flavored
Markdown and exposes tool use as progressive disclosure. Raw model output is
never injected as HTML.

**Markdown**

- `react-markdown` + `remark-gfm`, imported lazily from
  [`MarkdownMessage.tsx`](../apps/web/src/components/MarkdownMessage.tsx). The
  parser is a separate chunk and does not load until an answer renders.
- Supports headings, bold/italic, lists, blockquotes, tables, rules, inline
  code, fenced code and links. Tables are wrapped in a horizontally scrollable
  container so a 420 px sidebar (or 390 px phone) never scrolls the page.
- Streaming is throttled to one text flush per ~90 ms (`TEXT_FLUSH_MS`), so the
  parser does not re-run per token. Unclosed code fences and half tables render
  without crashing; React re-renders land at most ~11 times per second.
- Safety: raw HTML is escaped by react-markdown (no `rehype-raw`); images are
  replaced by their alt text (no remote fetch); anchors are restricted to
  `http(s)` and carry `target="_blank" rel="noopener noreferrer"`.
  `javascript:` links become plain text. Verified with injected
  `<img onerror>` / `<script>` / `[x](javascript:…)` payloads.

**Trajectory**

- A collapsed `<details class="agent-trace">` under each answer summarises
  “执行过程 N 步 · M 个来源 · 42s”; expanding it shows:
  1. plan entries (`plan` event),
  2. one card per `tool.called` / `tool.updated` call,
  3. a deduplicated source ledger split into 已引用 / 仅查阅,
  4. token usage when dsh reports it.
- Cards map ACP data to human labels (`apps/web/src/lib/agent-trace.ts`):
  `web_search` → 搜索网页 (query, result count, domains); `web_fetch` → 打开网页
  (URL, HTTP status); `mcp__occ__search_companies` → 查找公司;
  `get_company` → 查看公司资料; `search_documents` → 检索资料;
  `deep_research` → 发起深度研究; `get_run` → 查询研究进度; F10 tools and
  `propose_*` have their own labels. Unknown tools fall back to 使用工具.
- Status is shown as text (排队中 / 进行中 / 已完成 / 失败 / 已取消), not colour
  alone. There is no raw JSON, token stream or `thought.delta` in the trace;
  tool output is rendered as a summary plus links.
- `packages/agent/src/runtime.ts` caps `rawInput`/`rawOutput` before SSE
  (4 KB / 16 KB, shape-preserving) so a fetched page cannot flood the browser.
- `deep_research` appears as a tool card; a first-class sub-agent card with
  `get_run` progress polling and event persistence is still reserved (see
  [`CONTEXT_TRANSFER.md`](../CONTEXT_TRANSFER.md) §6 P3.4).

Build size after adding Markdown: main JS 393 KB (gzip 121 KB); lazy Markdown
chunk 163 KB (gzip 49 KB); CSS 40 KB (gzip 8 KB).

## Permissions and safety

- dsh runs with `DSH_PERMISSION_MODE=read-only`; it cannot edit the repo.
- The ACP client auto-selects `allow_once` (then `allow_always`) when dsh asks,
  and cancels when neither exists. This is a local single-user tool; there is no
  per-request prompt in the first slice.
- Tools that write (`propose_fact`, `propose_relation`) only enqueue review
  items. `deep_research` queues a job; it never writes verified facts.
- Web content is untrusted input; the model is instructed to cite sources and
  label `status=inferred` relations as unreviewed.

## Live verification (2026-10-29)

- `POST /v1/agent/sessions` created `e3f7a821-…` in ~6 s.
- Prompt `只回复 OK` streamed `assistant.delta: OK`, `usage 9093/1,000,000`,
  and `run.completed: end_turn`.
- Prompt asking for `search_companies 苹果` produced
  `tool.called mcp__occ__search_companies {"query":"苹果","limit":5}` and the
  answer `AAPL — Apple Inc.` — the stdio MCP attachment is working.

## Limits / next

- Sessions are in-memory. Restarting the API invalidates session ids; the UI
  creates a new one on the next send, and `AgentService` remaps an old id to a
  fresh dsh session after an idle dispose.
- One ACP process hosts all sessions; there is no per-session resource quota,
  but each turn has a wall-clock and tool-call cap (see Configuration).
- The dsh process is disposed after `OCC_AGENT_IDLE_TIMEOUT_MS` of inactivity;
  there is no background token consumption once a turn stops or is cancelled.
- The API also serves a local console (`/v1/agent/ui`). That console is a
  dependency-free debug view: it still shows raw tool names/JSON and does not
  render Markdown. The consumer experience is `apps/web`.
- **Known issue (2026-10-29): the 30-call cap can stop legitimate research.**
  A broad market question made 32 calls (18 `web_fetch`, 6 `bash`,
  5 `web_search`) and was cancelled by `OCC_AGENT_MAX_TOOL_CALLS` before it
  produced an answer. The session log
  (`.occ/dsh-acp-home/sessions/.../c643c443-…/session.v4.jsonl.zstd`) is kept
  for root-cause work; details and investigation steps are in
  [`CONTEXT_TRANSFER.md`](../CONTEXT_TRANSFER.md) §6 P3.4 “已知问题 2”. Do not
  simply raise the number: add repetition detection / a budget warning first.
- The trajectory is currently a permanent collapsed block. The next UX pass
  should make each tool call appear transiently and auto-collapse on completion
  (Grok-like), merging repeated calls into one activity line.
- **Trajectory is client-side only.** Tool cards, plan and the source ledger are
  built from the live SSE stream; nothing is persisted. `thought.delta` is
  deliberately not rendered. A first-class sub-agent card (deep-research job
  status via `get_run`, nested tool timeline), event persistence and replay are
  still reserved in [`CONTEXT_TRANSFER.md`](../CONTEXT_TRANSFER.md) §6 P3.4.
- `additionalDirectories`, client filesystem, terminals and elicitation are not
  advertised; dsh rejects additional directories by design.
- **Separate DSH_HOME is mandatory.** The ACP profile stores zstd-compressed
  `session.v4.jsonl.zst`; `phase0/.dsh-home` contains plain `.jsonl` from the
  Phase 0 patch. Sharing it fails `session/new` with a compression-backend
  mismatch, so the API uses `.occ/dsh-acp-home`.
