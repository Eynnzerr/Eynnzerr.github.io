# 活动数据

`github.json` 只保存日期、每日贡献数与数据来源信息，由关于页的 `ActivityHeatmap` 读取。

从仓库根目录同步：

```sh
node site/scripts/sync-activity.mjs
```

脚本使用本机已登录的 `gh` 调用官方 GraphQL `contributionCalendar`，包含账号所有贡献年份。日历日期沿用 GitHub 返回值。GitHub Actions 直接读取已聚合的 JSON，无需单独配置查询 token。可用 `--out-dir /path/to/output` 改变输出位置。

数据范围外显示“暂无贡献数据”；同步失败会保留带原更新时间的旧快照，并标为 `stale`。没有旧快照则标为 `unavailable`。

日常线上同步由 `site/scripts/publish-activity.mjs` 调用本脚本，通过 `--out-dir` 将 JSON 写入源码目录外的干净 checkout。`--dry-run` 实际聚合并生成可审阅差异；`--publish` 将提交推送到 `site-activity`，随后请求 Actions 构建。同步失败时不提交，线上保留上次成功数据。Mac 每日调度、首次切站与发布开关见[部署说明](../../../deploy/README.md)。

此前关于页还展示过 Codex 用量热图，2026-11-24 起移除并停止收集。
