# 参与贡献

感谢你愿意改进 OpenCorpCheck。这是一个面向非技术读者的公司情报工具，**准确性、可追溯性和礼貌抓取**比功能数量更重要。

## 先读这些

- [README.md](README.md) — 项目定位、数据范围和快速开始
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 系统结构和技术决策
- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — 数据来源、许可和抓取规则
- [docs/ROADMAP.md](docs/ROADMAP.md) — 当前计划与已明确延后的范围（不要重新提出被永久延后的功能）

## 开发环境

按 [README 的「快速开始」](README.md#快速开始) 配置即可。需要 Node.js ≥ 24.9、pnpm 12.15、PostgreSQL 17、Qdrant 1.18、Python 3.12 + `uv`，不需要 Docker。

提交前至少跑一遍：

```bash
corepack pnpm -r build
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test   # 必须串行
```

测试会共用本地数据库和端口；并行跑会互相污染。涉及 UI 的改动请附截图或说明验证页面。

## 不要提交的东西

- 任何密钥：`.env`、`DEEPSEEK_API_KEY.txt`、`NVIDIA_API_KEY.txt`、token、cookie
- 本地状态：`.occ/`、`.pgdata/`、`.qdrant/`、`.minio/`、`.embeddings/`、`dist/`、`node_modules/`
- 批量抓取的原始数据或受许可限制的数据集

提交前自查：

```bash
git status
git ls-files | grep -Ei 'key|secret|\.env'
```

## 数据与抓取规则

- **官方优先**：交易所公告、监管披露是引用真相；F10 等覆盖层不能冒充最终来源。
- **礼貌限速**：遵守 robots.txt 和站点条款，按域名限速，带可联系的 User-Agent。
- **不绕过限制**：不处理登录、付费墙、CAPTCHA 或反爬规避。
- **不做批量再分发**：可以存证据和引用，不要把专有数据打包成数据集发布。
- **新增来源要更新文档**：同步修改 [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) 的许可与使用方式。
- **没有来源就没有事实**：新抓取的数据必须保留 URL、引用、抓取时间和抽取器版本。

## 产品规则

- 面向非技术用户：公开 UI 不出现 BM25、RRF、inferred、confidence、score 等内部术语。
- 缺失数据就显示「暂无数据」；不猜、不补 0、不把 fixture 当真实公司。
- 机器抽取的关系默认是「待核实」；数据修正走复核队列，不直接改公开页面。
- 自动化数据路径保持 0 LLM tokens；大模型只用于研究、抽取和问答。
- 不要为了 README 或演示改产品行为，也不要编造截图或数字。

## 提交信息

沿用仓库现有风格，使用简短的英文前缀，例如：

```text
web: make dense ownership graphs readable
filings: add CNINFO announcement adapter
docs: clarify A/HK F10 retry window
```

一个提交只做一件事；文档改动和代码改动尽量分开。

## License

代码采用 Apache-2.0（见 [LICENSE](LICENSE)）。提交贡献即表示你同意以同一许可证发布你的贡献；引用或移植第三方代码时，保留其许可证并在 `NOTICE` 中署名。
