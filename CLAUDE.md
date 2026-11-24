# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout and deployment

The Astro site lives in `site/`; run every npm command there. The repo root only holds `DEPLOY.md` and `.github/workflows/site-pages.yml`.

Pushing to `master` deploys to https://blog.eynnzerr.cloud (GitHub Pages; gated by the repo variable `SITE_PUBLISH_ENABLED=true`). CI runs `npm run check`, `npm test`, `npm run build`, then `node scripts/verify-release.mjs`, so treat a push as a release. Maintainer docs (`site/README.md`, `site/deploy/README.md`, `site/src/content/life/README.md`) are in Chinese, as is all site copy.

## Commands

Node 24 is required (`site/.nvmrc`). Astro refuses to start on the machine's default Node 20, so prefix commands with `source ~/.nvm/nvm.sh && nvm use 24`.

```sh
npm run dev                  # dev server on 127.0.0.1 (Astro 7 daemonizes it; stop with `npx astro dev stop`)
npm run check                # astro check: types for .astro and .ts
npm test                     # node --test tests/*.test.ts (Node strips TS natively)
node --test --test-name-pattern="timing" tests/rhythm.test.ts   # a single test
npm run build                # static output to dist/
node scripts/verify-release.mjs   # after build: internal links, articles, search, feed, SEO files (same as CI)
```

`npm run verify` and `npm run migrate` belong to the one-off Hexo migration. They need `../db.json` from the old `~/hexo_blog` workspace, so they cannot run in this repo.

## Content model

There are three content sources, each loaded differently:

- **Blog** (`src/content/blog/*.md`): an Astro content collection (schema in `src/content.config.ts`). The glob is `**/*.md`, so never put non-post Markdown under this folder. `src/lib/posts.ts` builds `BlogPost`: the URL is `legacyPath` or `/YYYY/MM/DD/<filename>/` with dates in **Asia/Shanghai**. Word counts and reading time come from the rendered text (550 chars/min). `categories` is a parent→child chain; `tags` are flat. `src/pages/[...slug].astro` emits every article plus the legacy `/page/N/` list pages. Taxonomy, archive, search (`search.json.ts`), feed (`atom.xml.ts`) and sitemap routes all derive from `getPosts()`.
- **Projects** (`src/content/projects/*.md`): *not* a collection. `src/lib/projects.ts` reads raw frontmatter via `import.meta.glob` and `gray-matter`, ordered by `order`.
- **Life** (`src/content/life/entries/*.md`): `src/lib/life.ts` uses `import.meta.glob`, dropping entries marked `demo: true` or `draft: true`. Essays get `/life/<slug>/` pages; the other types render inline on `/life/`.

`src/data/activity/github.json` is a local snapshot only. CI overwrites it from the `site-activity` branch, which a local LaunchAgent refreshes daily (`scripts/sync-activity.mjs`, `scripts/publish-activity.mjs`; see `site/deploy/README.md`). Don't hand-edit it. That LaunchAgent (`cloud.eynnzerr.site-activity`, started through `site/deploy/run-activity.sh`, which picks nvm's newest Node 24) runs `publish-activity.mjs` from this working tree, so uncommitted edits to the activity scripts take effect at the next 08:35 run, while CI still uses the workflow on remote `master`. Keep the two compatible in either order. The retired `codex.json` still sits on the data branch for this reason.

## Images

Images live in `src/assets/images/` and are processed at build time. Only fixed-URL files stay in `public/`: the social card, favicon, CNAME, and `public/audio/`.

- In frontmatter (projects, life `images[].src`, local video `poster`), authors write `/images/...`. `localImage()` in `src/lib/images.ts` maps that to `src/assets/images/...` and throws on a missing file. Remote `https://` URLs pass through untouched (`isRemoteImage`).
- Render with `astro:assets` `<Picture formats={['avif','webp']} widths={…} sizes={…}>`, with `sizes` matching the CSS display width. Scoped styles do reach the generated `<img>`. `global.css` sets `picture{display:contents}`, but selectors must use descendant combinators (`.x img`), not `.x>img`.
- Blog images go in `src/assets/images/blog/<post-filename>/` and are referenced with relative paths (`../../assets/images/blog/<post>/x.png`). Never hotlink image hosts; provenance is recorded in `src/assets/images/blog/SOURCES.md`.

## Home hero and rhythm game

The home hero morphs into a 4-key rhythm game.

- `src/scripts/hero-stage.ts` drives the `data-mode` state machine on `.hero` (`home` → `entering` → `game` → `exiting`). The CSS transitions in `src/pages/index.astro` and `components/Resonance.astro` key off it.
- `src/scripts/resonance.ts` draws the canvas sculpture.
- `src/scripts/rhythm-game.ts` is the game runtime.
- `src/lib/rhythm-chart.ts` holds track metadata (`TRACKS`), the default track's chart, and timing judgement; `tests/rhythm.test.ts` covers this module.
- The three extra tracks' charts (`src/data/rhythm/*.json`) and MP3s (`public/audio/`) are generated together by `scripts/music/render_tracks.py` (see `scripts/music/README.md`). Change them together so note timing stays in sync with the audio.

## Styling conventions

- Styles are scoped `<style>` blocks written as dense single-line CSS. When editing by exact string replacement, check that the target isn't one item of a comma-separated selector list. Removing `.a{…}` out of `.b,.a{…}` silently welds `.b,` onto the next rule.
- Theme tokens live in `src/styles/global.css` (`:root` = light, `:root[data-theme=dark]`). The site defaults to dark, and the visitor's choice persists in `localStorage['eynnzerr-theme']`. Hero-specific palette variables live on `.hero` in `index.astro`. Use tokens for any color that sits on the page background; hardcoded light colors (hover backgrounds, table stripes) have caused dark-mode bugs.
- Text-size floor: `var(--text-label)` (11px) for Latin labels and numerals, `var(--text-caption)` (12px) for anything containing Chinese. Don't shrink below these in media queries.
- The owner prefers minimal decorative copy: no corner slogans or subtitles that restate a nearby heading. Use `↗` only on real links.

## Environment

Giscus comments need `PUBLIC_GISCUS_REPO_ID` and `PUBLIC_GISCUS_CATEGORY_ID` (see `.env.example`). Without them, articles render a placeholder comment box locally; production gets the values from Actions variables.
