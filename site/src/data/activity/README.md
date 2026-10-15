# 活动数据

两份 JSON 只保存日期、计数与数据来源信息。关于页使用 `ActivityHeatmap`，分别传入 `kind="github"` 与 `kind="codex"`。

从仓库根目录同步：

```sh
node site/scripts/sync-activity.mjs
```

只更新一种来源：

```sh
node site/scripts/sync-activity.mjs --github-only
node site/scripts/sync-activity.mjs --codex-only
```

GitHub 使用本机已登录的 `gh` 调用官方 GraphQL `contributionCalendar`，包含账号所有贡献年份。日历日期沿用 GitHub 返回值。GitHub Actions 直接读取已聚合的 JSON，无需单独配置查询 token。

Codex 读取本机 `~/.codex/sessions` 与 `~/.codex/archived_sessions` 中的 `event_msg/token_count` 数值。可用 `--codex-home /path/to/.codex` 指定记录目录，用 `--out-dir /path/to/output` 改变输出位置。每次重新扫描，因此重新上线后可补齐本机已有记录。

每日 token = 输入 + 输出；缓存输入属于输入，推理输出属于输出，均不再次相加。按北京时间将每次累计增量分配到记录发生的日期。汇总会去除复制的事件和重复累计通知，将续接日志按实际会话流连接；计数重置后从新的增量继续。首条记录若携带更早的累计量，只计算这条记录的本次用量。子代理按 rollout 标识分流，避免继承父会话元信息造成混算。

JSON 不含对话、文件路径、会话标识或凭据。`statistics` 是本次扫描的文件数、去重数等汇总。数据范围外显示“无本机记录”或“暂无贡献数据”；同步失败会保留带原更新时间的旧快照，并标为 `stale`。没有旧快照则标为 `unavailable`。

日常线上同步由 `site/scripts/publish-activity.mjs` 调用本脚本，通过 `--out-dir` 将两份 JSON 写入源码目录外的干净 checkout。`--dry-run` 实际聚合并生成可审阅差异；`--publish` 将仅含这两份文件的提交推送到 `site-activity`，随后请求 Actions 构建。两种来源均同步成功才会提交，失败时线上保留上次成功数据。Mac 每日调度、首次切站与发布开关见[部署说明](../../../deploy/README.md)。
