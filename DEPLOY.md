# 博客发布

访问地址：https://blog.eynnzerr.cloud/

新版源码位于 [`site/`](site/README.md)，由 [GitHub Actions](.github/workflows/site-pages.yml) 构建并发布到 GitHub Pages。日常修改 `site/` 下的文章、页面和资源后，提交并推送到 `master`，工作流会检查类型、运行现有测试、构建及验证静态页面，然后自动部署。

本机发布用源码仓库为 `/Users/eynnzerr/github/eynnzerr-site`。原 `/Users/eynnzerr/hexo_blog` 保留设计过程、旧 Hexo 文件和本地预览；后续发布在新版源码仓库中进行。

`SITE_PUBLISH_ENABLED=true` 控制自动部署。每日 GitHub 与 Codex 热图由本机任务汇总到 `site-activity` 分支，并触发同一发布工作流。配置、暂停与旧站恢复方法见[部署维护说明](site/deploy/README.md)。

自定义域名保持为 `blog.eynnzerr.cloud`，DNS CNAME 指向 `eynnzerr.github.io`；HTTPS 证书由 GitHub Pages 签发和续期。
