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

## Dual-mode providers (2026-10-31)

| Route | Inference | Search/fetch | Code path |
|---|---|---|---|
| Interactive ACP sidebar | official DeepSeek `deepseek-flash` | `deepseek-official` | `apps/api` + `.dsh/acp.patch.yml` |
| Headless research worker | NVIDIA NIM `deepseek-ai/deepseek-v4.1-flash` via the local retry gateway | Parallel Search MCP (`mcp__psearch__*`) | `apps/worker` + `phase0/dsh.patch.yml` + `phase0/parallel.patch.yml` |
| Hidden reviewer | official DeepSeek, reasoning on | official web tools | `phase0/reviewer.patch.yml` |

The sidebar path is unchanged. `OCC_LLM_PROVIDER=deepseek` rolls the worker
back to the official API (`phase0/dsh-deepseek.patch.yml`); rollback requires
no key resupply because `DEEPSEEK_API_KEY` stays in the repo. The worker passes
an explicit env whitelist to each child: research gets `NVIDIA_API_KEY`, the
reviewer gets `DEEPSEEK_API_KEY`, and neither leaks into the other.

The retry/normalisation gateway lives in `apps/worker/src/nim-gateway.ts` and
listens on `127.0.0.1:4010` by default. It retries 500/502/503/504 and
empty-`content` responses, normalises `reasoning_content → content`, and
enforces `OCC_NIM_RPM` (default 36). `occ-backfill work --queues research,...`
starts it automatically. The reviewer never uses the gateway.

## What exists

| Piece | Package | Responsibility |
|---|---|---|
| ACP client runtime | [`packages/agent`](../packages/agent) | Spawn dsh, initialize ACP, create sessions, map `session/update` to `AgentEvent` |
| Session service | [`apps/api/src/services/agent.ts`](../apps/api/src/services/agent.ts) | One dsh process, in-memory sessions, prompt/cancel/cancel-on-disconnect |
| HTTP surface | [`apps/api/src/app.ts`](../apps/api/src/app.ts) | Session create, SSE prompt, cancel, HTML sidebar |
| Sidebar UI | [`apps/api/src/agent-ui.ts`](../apps/api/src/agent-ui.ts) | Dependency-free debug console (raw tool cards) |
| Consumer sidebar | [`apps/web/src/components/AgentSidebar.tsx`](../apps/web/src/components/AgentSidebar.tsx) | React sidebar: GFM Markdown, one live→static trajectory card above the answer, source ledger |

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
GET  /v1/agent/sessions                 # persisted sessions (history menu)
POST /v1/agent/sessions                 # 201 { data: { sessionId } }
POST /v1/agent/sessions/{id}/prompt     # text/event-stream
POST /v1/agent/sessions/{id}/cancel
GET  /v1/agent/sessions/{id}/replay     # persisted turns + tool cards
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
| `OCC_AGENT_MAX_TOOL_CALLS` | `80` per turn |
| `OCC_AGENT_MAX_REPEATED_TOOL_CALLS` | `4` (same tool + input; `0` disables) |
| `OCC_AGENT_IDLE_TIMEOUT_MS` | `600000` (10 min; `0` disables) |
| `OCC_DSH_VERSION` | `0.2.1-rc.3` |
| `OCC_NPM_CACHE` | `$TMPDIR/occ-npm-cache` |
| `OCC_FINANCE_ANALYST_URL` | `http://127.0.0.1:8090` |
| `DEEPSEEK_API_KEY` / `_FILE` | required (sidebar, ingest/extraction, reviewer) |
| `NVIDIA_API_KEY` / `_FILE` | required for worker research (NIM) |
| `OCC_LLM_PROVIDER` | worker research: `nvidia` default, `deepseek` rollback |
| `OCC_NIM_GATEWAY_PORT` / `OCC_NIM_RPM` | `4010` / `36` |
| `OCC_REVIEW_MAX_CYCLES` | `2` |

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

`DshAcpRuntime.prompt()` enforces three per-turn guards:

- **Wall clock** — `OCC_AGENT_TURN_TIMEOUT_MS`.
- **Search budget** — `OCC_AGENT_MAX_TOOL_CALLS` tool calls (default 80, unique
  `callId`s only). A market-event question legitimately fans out into one
  search followed by 10–20 fetches; the 2026-10-29 “goog 股价大跌” run made 32
  distinct calls in 95 s with no repeats. A flat 30-call cap was therefore a
  false positive, not loop protection.
- **Repetition** — `OCC_AGENT_MAX_REPEATED_TOOL_CALLS` (default 4): stop when
  the same `(tool, kind, canonical input)` repeats. This catches an actual
  loop early without punishing a broad sweep that keeps finding new sources.

When any guard trips, the runtime does **not** just fail: it sends
`session/cancel`, waits up to 5 s for dsh's `stop`, emits a localized `notice`,
then starts a second prompt with tools effectively disabled (“停止调用任何工具，
只根据已收集资料回答”). The user gets a cited answer from the partial evidence
instead of `Turn stopped after 30 tool calls`. If dsh never acknowledges the
cancel, or the follow-up still tries to call a tool, the turn fails with
`agent.limit.failed`. Notices and failures carry a stable `code`
(`agent.limit.budget|repetition|timeout|failed`) so the React sidebar can render
them in Chinese or English; raw runtime strings stay English.

The sidebar counts `tool.called` events per `callId`, so a duplicated ACP event
cannot exhaust the budget. The limit no longer stops the “14 tool calls · 0
sources · no answer” loop silently either: the live activity panel shows the
step and consulted-source counts while the turn runs.

### Cancellation and idle disposal

- Stop button: aborts the SSE fetch **and** calls `/cancel`.
- Closing the browser page/tab: the sidebar sends a `pagehide` beacon to
  `/cancel` as a backup for the aborted fetch.
- Closing the sidebar panel alone does **not** cancel; the turn keeps running
  (deliberate: users often hide the panel while reading).
- When no prompt has run for `OCC_AGENT_IDLE_TIMEOUT_MS`, `AgentService`
  disposes the dsh process (and its `occ` MCP child). The UI keeps its old
  session id; the next prompt **resumes the persisted dsh session** (same id,
  same log, same model memory) when a log exists, and only starts a fresh
  session when there is none or resume fails (see “Session resume” below).

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

One trajectory card ([`AgentTrajectory.tsx`](../apps/web/src/components/AgentTrajectory.tsx))
sits at the top of every assistant bubble and never moves or duplicates. It has
two states of the same element:

- **Live** (researching, no answer text yet) — a rotating orb, “正在研究”, a
  ticking step count/elapsed time/consulted sources, and the group holding the
  active call open with its rows. Finished groups fold; new calls fold the
  previous group.
- **Static** (answer streaming or finished) — the same card in place, no
  spinner: header “工作轨迹 · 13 步 · 58s · 4 个来源”, then one merged group
  line per activity. Groups are closed by default, so 20+ calls never turn into
  20+ cards. Opening a group lists its calls; each search/fetch row opens to
  show the query, status, result count, top domains, hit links (new tab) and
  duration. A “已引用” badge marks a row whose URLs the answer cites.
  “计划与来源” holds the plan, the deduplicated source ledger
  (已引用 / 仅查阅) and token usage.

The card keeps its position when the answer streams in below it, matching
Grok's single-trajectory behaviour; there is no second summary block under the
answer.

- Groups are built by [`groupToolCalls`](../apps/web/src/lib/agent-trace.ts):
  `web_search`, `web_fetch`, shell and each MCP tool get their own bucket.
  A mixed group reports only its failures (“1 个失败”) instead of painting the
  whole group red.
- Cards map ACP data to human labels: `web_search` → 搜索网页 (query, result
  count, domains); `web_fetch` → 打开网页 (URL, HTTP status);
  `mcp__occ__search_companies` → 查找公司; `get_company` → 查看公司资料;
  `search_documents` → 检索资料; `deep_research` → 发起深度研究; `get_run` →
  查询研究进度; F10 tools and `propose_*` have their own labels. Unknown tools
  fall back to 使用工具.
- Status is shown as text (排队中 / 进行中 / 已完成 / 失败 / 已取消), not colour
  alone. There is no raw JSON, token stream or `thought.delta` in the trace;
  tool output is rendered as a summary plus links.
- `packages/agent/src/runtime.ts` caps tool payloads before SSE (4 KB input /
  16 KB output, shape-preserving) so a fetched page cannot flood the browser.
  dsh sends ACP tool results as `content` blocks
  (`[{type:"content",content:{type:"text",text}}]`) and leaves `rawOutput`
  unset, so the runtime forwards `content` when `rawOutput` is absent; without
  this the browser cards have no links or result counts.
- Animations respect `prefers-reduced-motion`; while live the title is a polite
  `role="status"` live region and the ticking stats are `aria-hidden` to avoid
  screen-reader chatter.
- `deep_research` stays a tool card. A first-class sub-agent card with
  `get_run` progress polling is **deferred (2026-10-30: not needed for this
  project)**; see [`CONTEXT_TRANSFER.md`](../CONTEXT_TRANSFER.md) §8 decision 27.

### Session persistence and replay (2026-10-30)

dsh owns persistence. Every ACP session is an append-only `SessionEvent` log at
`<DSH_HOME>/sessions/<project>/<session-id>/session.v4.jsonl.zstd`; the header
(version, cwd, lineage, `delegationDepth`) sits beside the log. The official
`@deepseek-ai/dsh-acp` server supports `session/list` and `session/resume` but
**not** `session/load`, delete, fork or transcript replay — replaying history
over ACP is deliberately out of scope upstream.

We therefore read dsh's log directly and project it onto the same tool-call
shape the SSE stream produces:

- `packages/agent/src/session-log.ts` — locate the log by session id, decode
  the concatenated zstd frames, fold `user/message`, `assistant/message`,
  `tool/call`, `tool/result` and `turn/end` into turns with
  `{prompt, answer, status, startedAt, endedAt, calls}`. Inputs/outputs are
  capped (4 KB / 16 KB) exactly like live SSE. Read-only; it never writes to
  `DSH_HOME`.
- `listPersistedSessions` scans the session directories, reads dsh's projection
  cache for the first question and prompt count (no log decompression for the
  menu), skips subagent child sessions (`origin=subagent` /
  `delegationDepth>0`) and other `cwd`s, and returns newest first.
- `GET /v1/agent/sessions` — list persisted sessions for the history menu.
- `GET /v1/agent/sessions/{id}/replay` — returns those turns; `404` when the
  session has no persisted log.
- `apps/web` — stores the dsh session id in `localStorage`
  (`occ.agent.sessionId`) after creating a session, restores it on mount, and
  renders each replayed turn with the same `AgentTrajectory` card plus GFM
  Markdown. The clock button opens a Claude-Code-style history popover
  (search + title + relative age + prompt count); picking a row loads that
  session. The header’s“新对话”button cancels the session, clears the stored
  id and returns to the greeting. A 404 clears a stale id automatically.

### Session resume (2026-10-30)

Replay restores the transcript; `session/resume` restores the **model's memory**.
The pinned `dsh@0.2.1-rc.3` advertises
`agentCapabilities.sessionCapabilities.resume = {}` (verified with a 10-line
`initialize` probe), so we use the official method.

- `DshAcpRuntime.resumeSession(sessionId)` in
  [`packages/agent/src/runtime.ts`](../packages/agent/src/runtime.ts) sends
  `session/resume` with the same `cwd` and `occ` MCP spec as `session/new`,
  then attaches the response to the SDK's update router. The stable SDK’s
  `attachSession` is private, so one narrow cast keeps resume confined to that
  method; the response has no `sessionId`, so the requested id is used and must
  be injected before attaching. A session already live in this process returns
  immediately without a second resume.
- `AgentService.prompt` calls `findSessionLog` on a `resolveSession` miss:
  a persisted log → resume (same id / same log / same memory); no log →
  `createSession`. If resume throws, it falls back to a fresh session and emits
  a `notice` with `code: "agent.resume.failed"` **before** `run.started`; it
  never fails the prompt.
- The web localizes that code and renders it as a highlighted yellow box
  between the question and the answer, so the UI never silently pretends the
  previous context survived.

Verified live: one turn → API restart → “请原样复述我上一条问题” returned the
original question; replay showed 2 turns and the history menu one row. Repeated
with `OCC_AGENT_IDLE_TIMEOUT_MS=1000` (idle dispose). A deliberately corrupt log
produced the yellow notice followed by a normal answer.

Limitations:

- Replay and resume are per dsh session; both now stay on one id and one log
  after an API restart or idle dispose. A corrupt / unsupported log falls back
  to a fresh session with the notice above.
- Only the parent session is replayed; `subagent` child sessions
  (`delegationDepth=1`) are not rendered. dsh never replays child steps over
  ACP either.
- The prompt shown in the bubble strips the API’s injected context and the
  web’s company line; the raw log keeps both.

Build size after the activity panel: main JS 400.2 KB (gzip 123 KB); lazy
Markdown chunk 162.7 KB (gzip 49 KB); CSS 45.5 KB (gzip 9.3 KB).

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
- Budget-fix regression (2026-10-29 PM): the question that previously tripped
  `OCC_AGENT_MAX_TOOL_CALLS` (“goog 今天股价大跌，是什么原因？”) now finishes
  in **57 s / 15 tool calls / 7 sources** with a Markdown answer, six citation
  chips and no limit notice. The failed session had made 32 distinct calls; the
  runtime no longer treats breadth as a loop.
- Deterministic SSE replay (mock events, 1440×1100 + 390×900) verified the live
  activity panel, group folding, mixed-group “1 个失败” label, one-line final
  summary, expanded trace and `scrollWidth == innerWidth`; no console errors.

## Limits / next

- Session ids survive an API restart / idle dispose: `AgentService` resumes the
  persisted dsh session (same memory and log). Only a missing or unreadable log
  causes a fresh dsh session, in which case the UI shows the yellow
  `agent.resume.failed` notice.
- One ACP process hosts all sessions; there is no per-session resource quota,
  but each turn has a wall-clock and tool-call cap (see Configuration).
- The dsh process is disposed after `OCC_AGENT_IDLE_TIMEOUT_MS` of inactivity;
  there is no background token consumption once a turn stops or is cancelled.
- The API also serves a local console (`/v1/agent/ui`). That console is a
  dependency-free debug view: it still shows raw tool names/JSON and does not
  render Markdown. The consumer experience is `apps/web`.
- **Fixed 2026-10-29: the flat 30-call cap stopped legitimate research.** A
  broad market question made 32 distinct calls (18 `web_fetch`, 6 `bash`,
  5 `web_search`, 3 MCP) in 95 s and was cancelled before answering. The
  session log (`.occ/dsh-acp-home/sessions/.../c643c443-…`) showed no repeated
  `(tool, input)` pair — it was breadth, not a loop. The budget is now 80 calls
  plus a repetition guard and a forced-answer follow-up (see
  “Turn budget and the ACP patch”). Re-running the same question with the new
  runtime completed in 57 s / 15 calls and produced a cited answer with no
  limit notice.
- The live activity panel replaced the permanent collapsed block: each tool
  call appears transiently, finished groups fold to one line, repeated calls
  merge, and the answer starts with a single summary line. Event persistence
  and replay are implemented; a first-class sub-agent card is **deferred (not
  needed for v1, 2026-10-30)**.
- **Trajectory is client-side while live; replay reads dsh's log.**
  Tool cards, plan and the source ledger are built from the live SSE stream;
  dsh persists the underlying events, and
  `GET /v1/agent/sessions/{id}/replay` folds them back into the same cards on
  reload (see “Session persistence and replay”). `thought.delta` is deliberately
  not rendered. A first-class sub-agent card (deep-research job status via
  `get_run`, nested tool timeline) is **deferred — not needed for v1**
  ([`CONTEXT_TRANSFER.md`](../CONTEXT_TRANSFER.md) §8 decision 27).
- `additionalDirectories`, client filesystem, terminals and elicitation are not
  advertised; dsh rejects additional directories by design.
- **Separate DSH_HOME is mandatory.** The ACP profile stores zstd-compressed
  `session.v4.jsonl.zst`; `phase0/.dsh-home` contains plain `.jsonl` from the
  Phase 0 patch. Sharing it fails `session/new` with a compression-backend
  mismatch, so the API uses `.occ/dsh-acp-home`.
