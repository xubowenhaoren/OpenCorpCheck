# OpenCorpCheck Web UI

React 19 + Vite 8 + TypeScript UI for the OpenCorpCheck API.

> Status: implemented 2026-10-29 · agent trajectory is **not** implemented
> (reserved in [docs/UI.md](../../docs/UI.md) §8.4 and
> [CONTEXT_TRANSFER.md](../../CONTEXT_TRANSFER.md) §6 P3.4).

## Run it

The API must be running on `127.0.0.1:8787`; Vite proxies `/v1` to it.

```bash
# repo root
scripts/dev-db.sh start
scripts/dev-qdrant.sh start
scripts/dev-embeddings.sh start
node apps/api/dist/server.js     # terminal 1

corepack pnpm dev:web            # terminal 2
open http://127.0.0.1:5173
```

Build:

```bash
corepack pnpm build:web
```

The output is `apps/web/dist`. Production hosting is still TODO; serve it
same-origin with the API (nginx or the API static handler) so `/v1` works
without CORS.

## Pages

| Route | What |
|---|---|
| `/` | Home: hero search, hot companies, markets, NASDAQ-100 shortcut, recent views |
| `/search?q=` | Company search with market / index / sector filters |
| `/c/:ref` | Company workspace: overview, financials, graph, news, sources |
| `/c/:ref/graph` | Ego-network graph (1 or 2 hops) |
| `/graph?company=` | Global graph picker |
| `/indices/NDX` | 100 NASDAQ-100 constituents |
| right sidebar | AI assistant over the real ACP SSE endpoint |

`ref` accepts ticker (`AAPL`), slug (`apple`), Chinese alias (`苹果`) or ULID.

## Backend additions used by the UI

- `GET /v1/graph?company=&depth=&status=&types=&limit=` — ego network.
- `GET /v1/indices/:code` — index constituents (NDX = 100 companies).
- `GET /v1/sectors` — sector filter values.
- `GET /v1/search/companies?sector=` — sector filter (Qdrant + Postgres).
- `POST /v1/agent/sessions` + `POST /v1/agent/sessions/:id/prompt` — real
  DeepSeek Harness ACP chat (SSE).

## Notes

- The current corpus has 102 real companies: 100 NDX + `600519` / `00700`.
  14 fixture-only companies (including CATL) stay hidden by default.
- Relations are currently supply/partnership/other; there are no
  `invests_in` / `owns` / `parent_of` edges yet, so investment counts are
  usually 0. The UI shows an honest empty state. P4 (GLEIF / SEC 13F /
  shareholder data) is needed to fill the investment graph.
- A short-CJK relevance guard hides unrelated nearest-neighbour results when
  the query has no exact/alias match and the top dense score is below 0.35
  (for example `宁德时代`, which is not in the visible corpus).
- English mode translates the UI chrome; company data keeps its original
  language.
- P3.4 (tool calls, web search trajectory, sub-agent cards) is deliberately
  not rendered yet.
