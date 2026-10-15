# 生活内容维护

在 `entries/` 中添加 Markdown 文件。文件名成为固定条目标识；随笔会生成 `/life/文件名/`，其他类型直接展示在时间线。

```yaml
---
title: 条目标题
type: thought
summary: 一句简短介绍
date: '2026-10-14'
---
```

`type` 可选 `thought`、`essay`、`photos`、`video`。有日期的内容按日期倒序；未知日期省略 `date`，未标日期的内容可用 `order` 排序。

`demo: true` 和 `draft: true` 的条目保留在源文件中，默认不进入公开时间线、详情路由和站点地图。当前四条排版示例可作为写作模板；替换成正式内容后删除 `demo`，准备发布时删除 `draft`。

- **短想法**：Markdown 正文直接展示在时间线。
- **长随笔**：时间线展示摘要，点击进入独立阅读页。正文支持 Markdown 和原生 HTML，可放置 `preload="none"` 的音频播放器。
- **照片**：填写 `images` 数组，每张包含 `src`、`alt`，可加 `caption`。一张或多张照片都能点击打开灯箱，支持方向键与 Escape。
- **视频**：填写 Bilibili `bvid`、`poster` 和可选 `duration`。封面由普通图片加载，只有访客点击播放后才加载第三方播放器。`sourceUrl` 提供原站入口。

照片字段示例：

```yaml
images:
  - src: /images/example.webp
    alt: 照片中实际可见的内容
    caption: 可选的照片说明
```

生活页不加载评论组件。照片与视频素材需要放入公开可访问的位置，再在条目中引用。
