# 路线图

> 状态：2026-11-03 · 当前任务：无（P4 已完成，P2 仍延后）
> 相关：[README](../README.md) · [架构](ARCHITECTURE.md) · [数据来源](DATA_SOURCES.md)

这份文档只记录公开范围；内部交接记录、运行日志和验收截图不随仓库发布。

## 已交付

| 阶段 | 内容 |
|---|---|
| 基础 | Postgres 真相库、Qdrant 混合检索、pg-boss 任务队列、React/Vite Web UI、`occ` CLI、MCP server、DeepSeek Harness ACP 侧栏 |
| P1.1 | CSI A500 + S&P 500 占位层（可搜索、`未收录` 标记，不做批量研究） |
| P1.2 | 11 个行业分类、实体消解、A/HK 双重上市合并、GLEIF 母公司关系 |
| P1.3 | 美股 SEC 13F 机构持仓 + 港交所 DION 权益披露关系图 |
| P1.4 | SEC EDGAR / CNINFO / HKEXnews 公告适配器、PDF 文本与表格抽取 |
| P1.5 | 每日公司数据 / 财报刷新（任务坞「财报更新」），A/HK F10 延迟重试与期间校验 |
| P3.5 | 公司页 6 个 tab、TaskDock（新闻 + 财报）、全局关系图谱、AI 助手 |
| P4 | review-loop 按问题类型路由（profile / financials / filings / entity / ownership）+ 科创 50 的 50 家 A 股回填试点 |

## 下一步

当前没有新的产品任务。P2 交付与工程质量仍按机器约束延后；A500 / S&P 500 逐家研究和更早年份的历史回填不在计划内。

## 已完成

**P3-OSS**：中文 README、Apache-2.0 许可证、社区文件、真实截图与开源仓库整理（2026-11-03）。

**P4 — review-loop 路由 + 科创 50 试点**（2026-11-03）：

- reviewer 为每条 issue 标注 `kind`；review job 按类型路由，profile 才重写整篇，financials / filings 走确定性流水线，entity / ownership 记录为 operator 命令。
- 设计文档：[REVIEW_LOOP.md](REVIEW_LOOP.md)。
- 科创 50（`000688`，上交所）50 家全部完成研究、入库与结构化 F10 财报；38 家 `ready`（18 家首轮通过、13 家修订 1 次、7 家修订 2 次），12 家 `needs_review`（均为 cycle cap，不是解析失败）。

## 延后

- **P2 交付与工程质量**：Docker / Electron 打包、托管 demo、CI、可观测性。受当前开发机器（macOS VM，无 Docker）约束，暂不启动。
- **历史回填**：A500 / S&P 500 逐家公司研究、更早年份的公告与财务数据。科创 50 已完成 50 家试点，不在此列；当前的每日检查只建立基线，不回填历史。

## 明确不做

手动刷新按钮、按需研究入口、页面入口提示、一级子 agent 卡片、AI 新闻摘要 / 全文抓取、账号系统、K 线 / 投资组合、图谱编辑、财务趋势图。这些功能已评估并永久延后，除非范围被重新打开。

## 数据边界

- 6 个指数：NASDAQ-100、恒生指数、创业板 50、科创 50（已研究），中证 A500、标普 500（占位页）。
- 指数成分快照因许可原因不随公开仓库发布；公开用户需按 [DATA_SOURCES.md](DATA_SOURCES.md) 记录的官方来源自行生成。
- 仓库不附带数据库、批量抓取数据或专有数据集；详见 [README「数据来源与许可」](../README.md#数据来源与许可)。
