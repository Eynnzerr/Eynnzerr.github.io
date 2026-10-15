# 发布与每日活动更新

新版由 `Eynnzerr/Eynnzerr.github.io` 的 GitHub Actions 构建并发布到 `blog.eynnzerr.cloud`。工作流位于 [`.github/workflows/site-pages.yml`](../../.github/workflows/site-pages.yml)，正式发布使用仓库变量 `SITE_PUBLISH_ENABLED=true`。

本机源码 checkout 为 `/Users/eynnzerr/github/eynnzerr-site`，日常修改这里的 `site/` 并推送 `master`。原 `/Users/eynnzerr/hexo_blog` 保留旧站与设计资料。下方首次切换步骤留作发布记录；日常更新无需重复执行。

## 数据流

Mac 每天 08:35 用现有 `gh` 登录读取 GitHub 官方贡献日历，并扫描本机 Codex 使用记录。在独立临时 checkout 中聚合后，通过已有 SSH 连接将 `github.json`、`codex.json` 提交到 `site-activity` 分支。这个分支仅保存两份公开聚合文件，源码目录的暂存区与工作区不参与提交。

推送成功后，脚本用 `gh workflow run` 显式触发 `master` 上的 `site-pages.yml`。Actions 读取源码和数据分支，执行类型检查、逻辑测试、构建及静态产物验收，随后按发布开关决定是否部署。GitHub 贡献查询发生在 Mac，云端无需额外 PAT，也无需本机会话记录。

`site-activity` 没有工作流文件，所以数据分支的 push 后需要显式 dispatch。普通 SSH push 不受 `GITHUB_TOKEN` 防递归触发限制。[GitHub 工作流触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

## 本机审阅活动数据

需要 Node.js 24、已登录的 `gh`、Git 作者信息和可非交互使用的 GitHub SSH 密钥。在仓库根目录执行：

```sh
node site/scripts/publish-activity.mjs --dry-run
```

命令会实际读取两种数据并生成暂存差异，打印独立 checkout 路径和 `git diff --cached` 查看命令。默认不带参数也是 dry run。目录位于 `~/Library/Application Support/Eynnzerr/activity-sync/run-*`；审阅后可删除对应 `run-*` 目录。自定义路径可用 `--work-dir` 和 `--codex-home`。

聚合失败时停止提交和推送，保留该次目录供检查；远端沿用上一次成功数据。SSH push 失败也保留目录，下次执行重新聚合并读取远端分支。成功发布会清理临时 checkout。

## 首次发布的源码范围

首次发布仅加入以下源码：

| 路径 | 内容 |
| --- | --- |
| `site/` | Astro 源码、公开资源、依赖锁文件、测试与维护文档 |
| `DEPLOY.md` | 根目录发布入口 |
| `.github/workflows/site-pages.yml` | 构建、验收与发布工作流 |

维护和上线说明已包含在 `site/`，本次没有额外必需的 `docs/` 文件。现有设计草案、原型素材和旧 Hexo 工作区改动留在本地。`site/.gitignore` 已放行 `site/public/`，并忽略依赖、构建产物和 `.env`。

本机 `master` 是 Hexo 源码历史，远端 `master` 是生成后的旧站文件。首次发布从远端创建干净 checkout，再只复制上述范围，得到远端历史上的正常后继提交：

```sh
release_source=/Users/eynnzerr/hexo_blog
release_checkout="$(mktemp -d /tmp/eynnzerr-release.XXXXXX)"
git clone --branch master --single-branch git@github.com:Eynnzerr/Eynnzerr.github.io.git "$release_checkout"
git -C "$release_checkout" rm -r -- .
mkdir -p "$release_checkout/site" "$release_checkout/.github/workflows"
rsync -a --include='.env.example' --exclude='.env*' --exclude='node_modules/' \
  --exclude='dist/' --exclude='.astro/' --exclude='.DS_Store' \
  "$release_source/site/" "$release_checkout/site/"
cp "$release_source/DEPLOY.md" "$release_checkout/DEPLOY.md"
cp "$release_source/.github/workflows/site-pages.yml" "$release_checkout/.github/workflows/site-pages.yml"
git -C "$release_checkout" add -- site DEPLOY.md .github/workflows/site-pages.yml
git -C "$release_checkout" diff --cached --stat
```

暂存差异包含旧生成物的删除和新版源码的加入；审阅时确认新文件仅落在表中范围。`git rm` 和暂存操作都发生在新 checkout，当前工作目录保持原状。后续提交、推送使用此 `release_checkout`。

## 一次性启用

1. 公开数据分支 `site-activity` 已于 2026-10-15 初始化，远端已确认仅有两份 JSON。需要在发布前再次刷新时执行：

   ```sh
   node site/scripts/publish-activity.mjs --publish --data-only
   ```

2. 在 **Settings → Pages → Build and deployment** 将 Source 改为 **GitHub Actions**，然后提交、推送已审阅的干净 checkout：

   ```sh
   git -C "$release_checkout" commit -m "Publish Astro personal site source"
   git -C "$release_checkout" push origin HEAD:master
   ```

   此次 push 只构建、验收并生成 Pages artifact。也可在 Actions 手动运行 **Personal site · GitHub Pages**，保持 `publish` 未勾选。检查运行结果后再开启发布。

3. 确认 Pages 自定义域名仍为 `blog.eynnzerr.cloud`，开启发布并请求首次部署：

   ```sh
   gh variable set SITE_PUBLISH_ENABLED --body true --repo Eynnzerr/Eynnzerr.github.io
   gh workflow run site-pages.yml --ref master -f publish=true --repo Eynnzerr/Eynnzerr.github.io
   ```

   仓库 Discussions、Announcements 分类、Giscus App 和 `PUBLIC_GISCUS_REPO_ID`、`PUBLIC_GISCUS_CATEGORY_ID` 已配置，工作流直接读取现有 Variables。实际评论互动在浏览器中验收。

4. 正式域名、文章、搜索、音游与评论验收通过后，安装每日任务：

   ```sh
   mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
   cp site/deploy/cloud.eynnzerr.codex-activity.plist "$HOME/Library/LaunchAgents/"
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/cloud.eynnzerr.codex-activity.plist"
   ```

LaunchAgent 已填写这台 Mac 上 Codex 配套 Node.js 24 的实际路径和项目路径。更换 Node 安装位置或移动项目后同步修改。安装时不立即运行，每天 08:35 更新两份数据；Mac 睡眠错过该时刻时，在唤醒后运行。每次全量扫描可补齐已有日志中的日期。[Apple 定时任务说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

之后从源码 checkout 推送 `master` 中的 `site/**` 更新，即可自动发布。活动数据需要立即同步时，在原项目目录执行：

```sh
node site/scripts/publish-activity.mjs --publish
```

日志位于 `~/Library/Logs/eynnzerr-activity.log` 和 `eynnzerr-activity.error.log`。本机命令完成表示数据已推送、工作流已请求；部署结果在 Actions 查看，成功后再访问正式域名。

## 暂停发布

`SITE_PUBLISH_ENABLED` 只有值为 `true` 时允许部署。手动运行还需勾选 `publish`。暂停后续部署：

```sh
gh variable set SITE_PUBLISH_ENABLED --body false --repo Eynnzerr/Eynnzerr.github.io
```

停止已经安装的每日同步：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/cloud.eynnzerr.codex-activity.plist"
```

## 恢复旧 Hexo 站点

2026-10-15 核对的旧站恢复点为 [`76f61b18e9e257699be9f16ff9bdf6359ab0aced`](https://github.com/Eynnzerr/Eynnzerr.github.io/commit/76f61b18e9e257699be9f16ff9bdf6359ab0aced)，提交说明为 `Create CNAME`，提交时间为 2026-10-10 08:36:09 UTC。该提交也是最近一次成功 Pages build 的来源，包含首页、文章、分类、资源和 `CNAME=blog.eynnzerr.cloud`。当时 Pages 配置为 `legacy`、`master` 分支根目录 `/`。

需要恢复时，先按上一节关闭发布变量并停止已安装的每日任务。在 Actions 中取消仍在执行的 **Personal site · GitHub Pages**，等待运行结束。随后创建独立 checkout，将旧站文件树作为新的正常提交恢复到 `master`：

```sh
rollback_commit=76f61b18e9e257699be9f16ff9bdf6359ab0aced
rollback_checkout="$(mktemp -d /tmp/eynnzerr-rollback.XXXXXX)"
git clone --branch master --single-branch git@github.com:Eynnzerr/Eynnzerr.github.io.git "$rollback_checkout"
git -C "$rollback_checkout" fetch origin "$rollback_commit"
git -C "$rollback_checkout" read-tree --reset -u "$rollback_commit"
git -C "$rollback_checkout" diff --cached --stat
git -C "$rollback_checkout" commit -m "Restore Hexo site from 76f61b1"
git -C "$rollback_checkout" push origin HEAD:master
```

该回退提交恢复旧站文件树，新版源码仍保留在它的父提交中。然后切回原来的 Pages 发布方式，并请求构建：

```sh
gh api --method PUT repos/Eynnzerr/Eynnzerr.github.io/pages \
  -f build_type=legacy -f 'source[branch]=master' -f 'source[path]=/' \
  -f cname=blog.eynnzerr.cloud
gh api --method POST repos/Eynnzerr/Eynnzerr.github.io/pages/builds
gh api repos/Eynnzerr/Eynnzerr.github.io/pages/builds/latest --jq '{status,commit,error}'
```

等待 build 状态为 `built`，访问首页和一篇已有文章确认旧站恢复。DNS 与自定义域名保持现有值。Pages 分支发布支持选择仓库分支和根目录；上述参数对应 [GitHub Pages API](https://docs.github.com/en/rest/pages/pages#update-information-about-a-github-pages-site)。

工作流使用 Node.js 24 及官方 Actions 主版本：checkout v7、setup-node v7、upload-pages-artifact v5、deploy-pages v5。静态检查脚本 `verify-release.mjs` 仅依赖仓库内的当前内容和构建产物；迁移对照检查 `verify-static.mjs` 另需本机保留的旧 Hexo 数据。
