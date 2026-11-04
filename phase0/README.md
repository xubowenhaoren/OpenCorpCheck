# Phase 0 — Minimal DeepSeek Harness + Agentic Company Profiles

这个目录是 Phase 0 的可运行骨架：**不启动 UI，不连数据库**，只用 DeepSeek Harness 的
headless CLI + 一个蒸馏版的 `mag7-profile` skill，生成美股七姐妹的带引用 company profile。

最终交付物：

- `out/magnificent-seven.md` — 7 份中文 profile + 摘要 + 来源
- 运行日志（模型、版本、耗时、工具调用、token）与机器可读的逐公司验收结果保存在内部开发记录中，不随仓库发布
- `runs/{TICKER}.jsonl` — dsh `--json` 原始事件

## 前置条件

- Node.js >= 24.9（本机 24.18）
- 一个 `DEEPSEEK_API_KEY`（chat 模型和默认 `web_search` 共用）
- 能访问 npm、SEC、公司 IR 与公开网页
- 不需要 Python、Docker、Postgres、Qdrant

## 快速开始

```bash
cd phase0
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY

npm run research
npm run validate
```

只跑一家：

```bash
npm run research -- --only AAPL --force
```

不调用 API 的流水线自测：

```bash
npm run research -- --mock
npm run validate
```

## 它怎么工作

1. `run.mjs` 读取 `../.dsh/skills/mag7-profile/SKILL.md`（dsh 自动发现）。
2. 默认最多 **4 家公司并行**（`--concurrency 4`）；每家一个 headless dsh 进程。之前那次
   7 家是用 `--concurrency 1` 串行跑的，所以慢；backfill 请用默认并发或更高（4–8），
   遇到限流再降。

   ```bash
   npx --yes @deepseek-ai/dsh@0.2.1-rc.3 \
     --profile headless \
     --patch /abs/path/phase0/dsh.patch.yml \
     --json -
   ```

3. dsh 用内置 `web_search`（`deepseek-official`）和 `web_fetch` 做 BFS → 汇合点 → DFS。
4. `run.mjs` 解析 NDJSON 事件，把 `final` 文本写入 `out/sections/{TICKER}.md`。
5. `lib/assemble.mjs` 拼接成最终文档；`lib/validate.mjs` 做结构与引用校验，并写本地
   `out/run-summary.json`（不随仓库发布）。

`dsh.patch.yml` 把主 agent 模型固定为 `deepseek-flash`（当前 V4.1 Flash 的 dsh 别名），
并关闭 session zstd 压缩（便于调试）。内置 `web_search` provider 使用它自己的默认
`deepseek-v4-flash`，同样是 Flash，不是 Pro。`search-api.patch.yml` 是可选的搜索降级方案。

## 常用参数

| 参数 | 作用 |
|---|---|
| `--only AAPL,MSFT` | 只跑指定公司 |
| `--force` | 已有 section 也重跑 |
| `--mock` | 用 fixture 跑完整流水线，不调 API |
| `--concurrency N` | 并发公司数，默认 **4**；遇到 429/限流降到 1–2 |
| `--search-api` | 附加 `search-api.patch.yml`，切到直接 Search API |
| `--f10` | 附加 `f10-mcp.patch.yml`，把 F10 MCP 工具挂给 dsh（需先构建 MCP server 并启动 sidecar） |
| `--synthesize` | 额外跑一次摘要/跨公司主题；会增加一次模型调用 |

`--f10` 的前置步骤：

```bash
# 仓库根目录
corepack pnpm -r build

# 另一个终端
cd services/finance-analyst && uv run occ-f10 serve --port 8090
```

挂载后 dsh 会看到 `mcp__occ__f10_scrape` / `mcp__occ__f10_pages`，配套 skill 是
`.dsh/skills/f10-financials/SKILL.md`。

## 验收标准

`npm run validate` 会逐公司检查：

- 13 个规定章节齐全；
- 至少 3 个唯一 http(s) 来源；
- 每个来源 URL 都出现在该公司的 `web_search` / `web_fetch` 事件中；
- 至少 1 次 `web_search`、2 次 `web_fetch`；
- 800–1200 中文字（<600 硬失败，>2000 警告）；
- 没有 `TODO`、`TBD`、`待补充`、`placeholder`；
- dsh turn 正常完成。

结果同时写入本地 `out/run-summary.json`（不随仓库发布），便于 CI 或脚本判定。

## 排错

**`DEEPSEEK_API_KEY is missing`**
把 key 写进 `phase0/.env`，或 `export DEEPSEEK_API_KEY=...`。不要提交 `.env`。

**npm 报 `EACCES` / `EEXIST`（`~/.npm/_cacache`）**
本机 npm cache 可能不可写。`run.mjs` 会自动把 `npm_config_cache` 指到
`$TMPDIR/occ-npm-cache`；手动跑 npx 时可以：

```bash
npm_config_cache=/tmp/occ-npm-cache npx --yes @deepseek-ai/dsh@0.2.1-rc.3 ...
```

**没有 `web_search` 工具**
dsh base 默认挂载 `web_search`，需要 `DEEPSEEK_API_KEY`。如果 key 缺失，工具会被
*withheld*，模型看不到它。看 `runs/{TICKER}.err` 里的 `MISSING_CREDENTIAL`。

**模型没有加载 skill**
prompt 已明确要求先调用 `skill` 工具加载 `mag7-profile`。如果仍然没有，检查
`.dsh/skills/mag7-profile/SKILL.md` 的 frontmatter `name` 是否为 kebab-case，以及
dsh 的 cwd 是否是仓库根目录（skill 只在 `<projectRoot>/.dsh/skills` 下被发现）。

**`--json` 里工具结果被截断**
`--json` 对非 final 字符串有 8 KiB 上限；完整内容在
`phase0/.dsh-home/sessions` 的明文 session JSONL 里（`dsh.patch.yml` 已关闭 zstd）。

**dsh 版本问题**
当前固定 `0.2.1-rc.3`。如果 `--json` 或 skill 发现异常，先试 `0.2.1-rc.4`，并更新
`lib/dsh.mjs` 的 `DSH_VERSION`。

## 非目标

- 不做 Electron/React UI。
- 不做 Postgres/Qdrant/API/worker。
- 不移植 opportunity-radar 的 1–5 裁决、G1–G14、Python XBRL 工具或 Claude Code 子 agent。
- 不做投资建议、目标价或交易信号。
