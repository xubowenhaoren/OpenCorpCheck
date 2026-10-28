请使用 **{{SKILL}}** skill，为 {{COMPANY}}（{{TICKER}}，市场：{{MARKET}}）生成一份中文 company profile。

要求：

- 数据截止日：{{DATE}}
- 目标篇幅：800–1200 个中文字（不含来源列表）
- 必须包含 skill 规定的全部 13 个章节
- 每个事实都要有 `[n]` 引用，并在“来源”中列出真实 URL
- 只返回 markdown profile 正文；不要前言，不要写文件，不要调用 shell
- 如果联网失败，按 skill 要求声明并停止，不得用训练记忆补齐
- 重点：{{FOCUS}}

公司：{{COMPANY}}
Ticker：{{TICKER}}
市场：{{MARKET}}
