#!/usr/bin/env node
/** Check deployable output against current content, without a local Hexo database. */
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import matter from 'gray-matter';

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(siteRoot, 'dist');
const origin = 'https://blog.eynnzerr.cloud';
const documents = new Map();
const report = { pages: 0, internalReferences: 0, articles: 0, searchEntries: 0, feedEntries: 0, sitemapEntries: 0 };

/** Enumerate the emitted files, including nested content routes. */
async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)]));
  return files.flat();
}

/** Traverse parsed HTML or XML-as-HTML elements in document order. */
function elements(node, tag) {
  return [...(node.tagName && (!tag || node.tagName === tag) ? [node] : []), ...(node.childNodes || []).flatMap((child) => elements(child, tag))];
}

/** Read one parsed element attribute. */
function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

/** Read decoded textual content from an XML value. */
function text(node) {
  return node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
}

/** Resolve a same-origin URL to its generated static file. */
function outputPath(url) {
  return join(dist, decodeURIComponent(url.pathname), url.pathname.endsWith('/') ? 'index.html' : '');
}

/** Cache real emitted documents for article and link checks. */
async function documentAt(filename) {
  if (!documents.has(filename)) documents.set(filename, parse(await readFile(filename, 'utf8')));
  return documents.get(filename);
}

for (const route of ['/', '/blog/', '/projects/', '/life/', '/about/', '/404.html']) {
  assert.ok((await stat(outputPath(new URL(route, origin)))).isFile(), `${route}: page exists`);
}
assert.equal((await readFile(join(dist, 'CNAME'), 'utf8')).trim(), new URL(origin).hostname, 'Custom domain is preserved');

const broken = [];
for (const filename of (await filesIn(dist)).filter((file) => file.endsWith('.html'))) {
  const route = `/${relative(dist, filename).replace(/index\.html$/, '')}`;
  const pageUrl = new URL(route, origin);
  const document = await documentAt(filename);
  for (const node of elements(document)) {
    for (const name of ['href', 'src']) {
      const value = attribute(node, name);
      if (!value || value.startsWith('#')) continue;
      const url = new URL(value, pageUrl);
      if (url.origin !== origin) continue;
      try { assert.ok((await stat(outputPath(url))).isFile()); }
      catch { broken.push(`${route}: ${name}=${value}`); }
      report.internalReferences++;
    }
  }
  report.pages++;
}
assert.deepEqual(broken, [], 'Same-site links and resources must resolve to emitted files');

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const posts = await Promise.all((await filesIn(join(siteRoot, 'src/content/blog'))).filter((file) => file.endsWith('.md')).map(async (filename) => {
  const { data } = matter(await readFile(filename, 'utf8'));
  const slug = basename(filename, '.md');
  return { title: data.title, date: new Date(data.date), url: data.legacyPath || `/${dateFormat.format(new Date(data.date)).replaceAll('-', '/')}/${slug}/` };
}));
const search = JSON.parse(await readFile(join(dist, 'search.json'), 'utf8'));
assert.equal(search.length, posts.length, 'Search covers every article');
for (const post of posts) {
  const entry = search.find((item) => item.url === post.url);
  assert.ok(entry?.text.trim(), `${post.url}: searchable article text`);
  assert.equal(entry.title, post.title, `${post.url}: searchable title`);
  const document = await documentAt(outputPath(new URL(post.url, origin)));
  const canonical = elements(document, 'link').find((node) => attribute(node, 'rel') === 'canonical');
  assert.equal(decodeURI(attribute(canonical, 'href')), `${origin}${post.url}`, `${post.url}: stable canonical URL`);
}
report.articles = posts.length;
report.searchEntries = search.length;

const feed = parse(await readFile(join(dist, 'atom.xml'), 'utf8'));
const feedIds = elements(feed, 'entry').map((entry) => decodeURI(text(elements(entry, 'id')[0])));
const latest = posts.sort((a, b) => b.date - a.date).slice(0, 20).map((post) => `${origin}${post.url}`);
assert.deepEqual(feedIds.sort(), latest.sort(), 'Atom contains the latest twenty articles');
report.feedEntries = feedIds.length;

const sitemap = parse(await readFile(join(dist, 'sitemap.xml'), 'utf8'));
const locations = elements(sitemap, 'loc').map((node) => new URL(text(node)));
assert.ok(locations.length > 0, 'Sitemap contains public pages');
for (const url of locations) {
  assert.equal(url.origin, origin, 'Sitemap uses the canonical domain');
  assert.ok((await stat(outputPath(url))).isFile(), `${url.pathname}: sitemap target exists`);
}
const sitemapPaths = new Set(locations.map((url) => decodeURI(url.pathname)));
for (const post of posts) assert.ok(sitemapPaths.has(post.url), `${post.url}: sitemap membership`);
assert.ok((await readFile(join(dist, 'robots.txt'), 'utf8')).includes(`Sitemap: ${origin}/sitemap.xml`), 'Robots advertises the sitemap');
report.sitemapEntries = locations.length;
console.log('Release verification passed.');
console.log(JSON.stringify(report, null, 2));
