# Eynnzerr 个人站点

基于 Astro 的独立应用，包含首页、博客、作品、生活和关于页。现有 18 篇 Hexo 文章沿用原来的 `/年/月/日/文件名/` 地址，并保留标签、分层分类、归档和 `/atom.xml` 订阅入口。

首页的「听见我的节奏」会将动态曲面展开为四键音游，并在转场后倒数开局。点击「回到首页」或按 Esc 会立即结束本局、收束音轨，恢复主视觉和原来的阅读位置。首屏转场由 `src/scripts/hero-stage.ts` 协调，曲面动画位于 `src/scripts/resonance.ts`，游戏逻辑位于 `src/scripts/rhythm-game.ts`。

首页导航、主视觉与正文统一跟随深浅主题，默认深色，并记住访客手动选择的配色。浅色曲面使用青绿、铜橙细线与柔和投影，深色保留发光线条；进入音游时舞台逐渐压暗，退出后恢复当前主题。配色变量集中在 `src/pages/index.astro` 的 `.hero` 中。

**本地运行**

安装 [Node.js 24 LTS](https://nodejs.org/en/download)，随后在本目录执行：

```sh
node --version
npm ci
npm run dev
```

浏览器打开终端显示的本地地址。常用命令如下：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发服务，编辑内容后自动刷新 |
| `npm run check` | 检查 Astro 与 TypeScript 类型 |
| `npm test` | 运行现有逻辑测试 |
| `npm run build` | 生成静态网站到 `dist/` |
| `npm run verify` | 检查构建后的旧文章、地址、资源、站内链接、搜索与订阅 |
| `node scripts/verify-release.mjs` | 检查当前构建产物的内部链接、文章、搜索、订阅与 SEO 文件，适用于 CI |
| `npm run preview` | 在本机预览 `dist/` 中的构建结果 |

`verify` 在 `build` 之后运行。它是本次迁移的对照检查，需要上级仓库中的旧 `db.json`、`public/` 和 `source/_posts/`。页面的实际交互可在开发或预览服务中检查。

**写博客**

在 [`src/content/blog/`](src/content/blog/) 新建 Markdown 文件，例如 `a-new-note.md`：

```md
---
title: 一篇新文章
date: '2026-10-14'
categories: [客户端, Kotlin]
tags: [Kotlin, 跨平台]
---

正文从这里开始。
```

必填字段只有 `title`、`date`。`categories` 是从父分类到子分类的链，`tags` 是独立标签，均可省略。还可填写 `description` 自定义摘要、`updated` 记录更新时间；省略时分别使用正文摘要和发布日期。

从 Obsidian 整理的文章沿用主笔记的创建日期，缺少创建时间时使用最后修改时间；`updated` 记录博客稿的整理日期。原笔记继续保留在 Vault，来源清单保存在本机工作区。

新文章默认地址为 `/2026/10/14/a-new-note/`，日期按北京时间计算。旧文章的 `legacyPath` 固定已有地址；文章发布后需要改文件名时，也可用该字段保持原地址。

字数与阅读时长从当前正文自动计算，无需填写。计数包含可见文字与代码，略去标记和空白，公式只计一次；建议阅读时长按约 550 字／分钟估算，至少 1 分钟。搜索索引和 RSS 随构建更新。

`npm run migrate` 用于从上级 Hexo 数据重新迁移旧文章。日常新增、修改文章直接编辑这里的 Markdown。

**更新作品、生活与个人信息**

| 内容 | 编辑位置 |
| --- | --- |
| 作品画廊 | [`src/content/projects/*.md`](src/content/projects/) |
| 生活条目 | [`src/content/life/entries/*.md`](src/content/life/entries/) |
| 自我介绍与联系入口 | [`src/pages/about.astro`](src/pages/about.astro) |
| 四个个人经历节点 | [`src/components/ExperienceTimeline.astro`](src/components/ExperienceTimeline.astro) |
| 首页文案与展示入口 | [`src/pages/index.astro`](src/pages/index.astro) |
| 音游谱面 | [`src/lib/rhythm-chart.ts`](src/lib/rhythm-chart.ts) |

新增作品可复制 [`blue-fish.md`](src/content/projects/blue-fish.md)，修改名称、简介、技术栈、平台、状态、截图和排序。`source` 是源码入口，`demo` 是在线体验地址，`download` 是下载地址；截图布局 `visual` 可选 `phones`、`desktop`、`banner`。

生活内容使用 `thought`、`essay`、`photos`、`video` 四种类型：短想法直接展示，长随笔生成独立页面，照片支持组图灯箱，视频当前通过 Bilibili `bvid` 接入，点击封面后才加载播放器。完整字段和示例见[生活维护说明](src/content/life/README.md)。带 `demo: true` 或 `draft: true` 的条目默认不公开；发布正式稿时删除相应标记。

关于页已经收录四个个人经历节点。内容与节点布局在 `ExperienceTimeline.astro`，交互动效在 [`src/scripts/experience-timeline.ts`](src/scripts/experience-timeline.ts)，图片放在 `public/images/journey/`。

**图片、视频和音频**

公开资源放在 `public/`，引用路径从网站根目录开始。例如 `public/images/life/photo.webp` 在 Markdown 中写成：

```md
![照片中实际可见的内容](/images/life/photo.webp)
```

新增作品截图位于 `public/images/projects/`，原有三件作品的截图保留在 `public/projects/`。旧文章本地图片位于 `public/legacy-assets/`。首页音乐及来源说明位于 [`public/audio/`](public/audio/)，更换音频时同步调整谱面时间。

**活动热图**

```sh
npm run sync:activity
node scripts/sync-activity.mjs --github-only
node scripts/sync-activity.mjs --codex-only
```

GitHub 数据通过已登录的 `gh` 读取官方贡献日历。Codex 数据从本机会话记录按北京时间汇总，输出到 `src/data/activity/codex.json`；输入包含缓存输入，输出包含推理输出。公开文件只保存每日汇总与来源信息。统计口径及路径参数见[活动数据说明](src/data/activity/README.md)。

每日线上同步使用独立数据分支 `site-activity`，聚合与提交在源码目录外完成。先运行 `node scripts/publish-activity.mjs --dry-run` 审阅两份 JSON；正式启用后，`--publish` 将数据推送并请求 Actions 更新站点。工作流通过仓库变量 `SITE_PUBLISH_ENABLED=true` 开启部署，默认只构建验收。

**评论与部署**

技术博客使用 Giscus，并随站点主题切换。仓库 Discussions、Announcements 分类、Giscus App 和两个 Actions Variables 均已配置，本机 `.env` 已填写。生活页不加载评论。浏览器中的实际评论互动仍待验收。

在新的本机 checkout 中，可直接读取已配置的公开 ID，无需重新填写。以下命令在 `site/` 中执行，写入新的 `.env`：

```sh
gh variable list --repo Eynnzerr/Eynnzerr.github.io --json name,value \
  --jq '.[] | select(.name == "PUBLIC_GISCUS_REPO_ID" or .name == "PUBLIC_GISCUS_CATEGORY_ID") | "\(.name)=\(.value)"' > .env
```

GitHub Pages 工作流位于 [`.github/workflows/site-pages.yml`](../.github/workflows/site-pages.yml)，回退、发布开关与每日同步步骤见 [`deploy/README.md`](deploy/README.md)。本机已有的 `gh` 登录和 SSH 连接负责数据更新，云端直接读取公开聚合文件，无需额外 PAT。正式站点使用 `SITE_PUBLISH_ENABLED=true`，本机 LaunchAgent 每天 08:35 更新热图。
