import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'parse5';
import matter from 'gray-matter';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalRoot = path.resolve(siteRoot, '..');
const distRoot = path.join(siteRoot, 'dist');
const originalPublic = path.join(originalRoot, 'public');
const origin = 'https://blog.eynnzerr.cloud';
const documents = new Map();
const report = { articles: 0, visibleCharacters: 0, legacyRoutes: 0, taxonomyAndArchiveMemberships: 0, checkedInternalReferences: 0, skippedFragmentLinks: 0, linksWithQueries: 0, mathBlocks: 0, highlightedCBlocks: 0, searchEntries: 0, searchBodyProbes: 0, feedEntries: 0, preservedArticleImages: 0 };

/** Recursively enumerate actual files, keeping the verification independent of generated route lists. */
async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  return nested.flat();
}

/** Traverse parsed HTML nodes in document order. */
function elements(node, predicate = () => true) {
  const result = [];
  if (node.tagName && predicate(node)) result.push(node);
  for (const child of node.childNodes || []) result.push(...elements(child, predicate));
  return result;
}

/** Read an HTML attribute from a parsed element. */
function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

/** Match a complete HTML class token. */
function hasClass(node, name) {
  return (attribute(node, 'class') || '').split(/\s+/).includes(name);
}

/** Read visible content without script and style source code. */
function textContent(node) {
  if (['script', 'style', 'annotation'].includes(node.tagName) || hasClass(node, 'katex-html')) return '';
  return node.nodeName === '#text' ? node.value : (node.childNodes || []).map(textContent).join('');
}

/** Compare prose or code independently of HTML-generated whitespace. */
function normalized(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** Parse a real emitted HTML file once. */
async function documentAt(filename) {
  if (!documents.has(filename)) documents.set(filename, parse(await readFile(filename, 'utf8')));
  return documents.get(filename);
}

/** Resolve a site URL to its actual static output, excluding query and fragment semantics. */
function outputPath(url) {
  const pathname = decodeURIComponent(url.pathname);
  return path.join(distRoot, pathname, pathname.endsWith('/') ? 'index.html' : '');
}

/** Recover the canonical path from the already published Hexo HTML. */
function canonicalPath(document) {
  const canonical = elements(document, (node) => node.tagName === 'link' && attribute(node, 'rel') === 'canonical')[0];
  assert.ok(canonical, 'Original published page has a canonical URL');
  return decodeURIComponent(new URL(attribute(canonical, 'href'), origin).pathname);
}

/** Locate the published source page by its date and recorded slug, then trust its canonical URL. */
function originalArticleFile(record) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(record.date));
  return path.join(originalPublic, date.replaceAll('-', '/'), record.slug, 'index.html');
}

/** Collect links that point to one of the original articles. */
function articleLinks(document, knownPaths, onlyOldTitles = false) {
  return new Set(elements(document, (node) => node.tagName === 'a' && (!onlyOldTitles || hasClass(node, 'post-title-link')))
    .map((node) => attribute(node, 'href'))
    .filter(Boolean)
    .map((href) => decodeURIComponent(new URL(href, origin).pathname))
    .filter((pathname) => knownPaths.has(pathname)));
}

const records = JSON.parse(await readFile(path.join(originalRoot, 'db.json'), 'utf8')).models.Post.filter((record) => record.published);
const sources = (await readdir(path.join(originalRoot, 'source/_posts'))).filter((name) => name.endsWith('.md'));
assert.equal(records.length, sources.length, 'Published source count and Hexo records must agree');
assert.equal(records.length, 18, 'This migration covers the eighteen original articles');
const knownPaths = new Set();
const articleRecords = [];

for (const record of records) {
  const oldDocument = await documentAt(originalArticleFile(record));
  const url = canonicalPath(oldDocument);
  knownPaths.add(url);
  const document = await documentAt(outputPath(new URL(url, origin)));
  const header = elements(document, (node) => node.tagName === 'header' && hasClass(node, 'article-header'))[0];
  assert.ok(header, `${url}: article header exists`);
  assert.equal(normalized(textContent(elements(header, (node) => node.tagName === 'h1')[0])), normalized(record.title), `${url}: original title`);
  const canonical = canonicalPath(document);
  assert.equal(canonical, url, `${url}: canonical address`);
  const times = elements(header, (node) => node.tagName === 'time').map((node) => new Date(attribute(node, 'datetime')).toISOString());
  assert.ok(times.includes(record.date), `${url}: original publication instant`);
  const oldDate = new Date(record.date).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const oldUpdated = new Date(record.updated).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (oldDate !== oldUpdated) assert.ok(times.includes(record.updated), `${url}: original update instant`);
  const source = matter(await readFile(path.join(originalRoot, 'source', record.source), 'utf8'));
  const prose = elements(document, (node) => hasClass(node, 'prose'))[0];
  assert.ok(prose, `${url}: rendered article body`);
  // Independently count the real output DOM, after HTML entity decoding and without duplicate KaTeX trees.
  const visibleCount = [...textContent(prose).replace(/\s/g, '')].length;
  const expectedCount = visibleCount >= 1000 ? `${(visibleCount / 1000).toFixed(1)}k` : String(visibleCount);
  assert.ok(textContent(header).includes(`${expectedCount} 字`), `${url}: displayed count matches actual visible body`);
  assert.ok(textContent(header).includes(`约 ${Math.max(1, Math.round(visibleCount / 550))} 分钟`), `${url}: reading-time scope`);
  report.visibleCharacters += visibleCount;
  const oldProse = elements(oldDocument, (node) => hasClass(node, 'post-body'))[0];
  const images = elements(prose, (node) => node.tagName === 'img').map((node) => attribute(node, 'src'));
  for (const image of elements(oldProse, (node) => node.tagName === 'img')) {
    const oldSource = attribute(image, 'src');
    const expected = oldSource.startsWith('/package-size-incre-md/') ? `/legacy-assets${oldSource}` : oldSource;
    assert.ok(images.includes(expected), `${url}: preserved image ${oldSource}`);
    report.preservedArticleImages++;
  }
  // Match complete source C blocks to rendered blocks, then require actual syntax tokens.
  for (const match of source.content.matchAll(/^```C[\t ]*\n([\s\S]*?)^```[\t ]*$/gm)) {
    const block = elements(prose, (node) => node.tagName === 'pre').find((node) => normalized(textContent(node)) === normalized(match[1]));
    assert.ok(block, `${url}: original C block survives rendering`);
    assert.ok(elements(block, (node) => node.tagName === 'span' && (attribute(node, 'style') || '').includes('color')).length > 0, `${url}: C block has syntax highlighting`);
    report.highlightedCBlocks++;
  }
  if (record.slug === 'ResNet学习笔记') {
    const math = [...source.content.matchAll(/^\$\$\s*\n([\s\S]*?)^\$\$\s*$/gm)];
    const annotations = elements(prose, (node) => node.tagName === 'annotation' && attribute(node, 'encoding') === 'application/x-tex').map((node) => normalized((node.childNodes || []).map(textContent).join('')));
    assert.equal(elements(prose, (node) => hasClass(node, 'katex-error')).length, 0, 'ResNet formula renderer reports no error elements');
    assert.ok(math.length > 0, 'Original ResNet article contains block mathematics');
    for (const match of math) assert.ok(annotations.includes(normalized(match[1])), 'ResNet renders the original TeX in KaTeX/MathML');
    report.mathBlocks = math.length;
  }
  articleRecords.push({ record, url, source, document, visibleCount });
  report.articles++;
}

const originalFiles = await filesIn(originalPublic);
for (const filename of originalFiles.filter((filename) => filename.endsWith('/index.html'))) {
  const relative = path.relative(originalPublic, filename);
  await stat(path.join(distRoot, relative));
  report.legacyRoutes++;
  if (/^(?:tags|categories|archives|page)\//.test(relative)) {
    const expected = articleLinks(await documentAt(filename), knownPaths, true);
    if (expected.size) {
      const actual = articleLinks(await documentAt(path.join(distRoot, relative)), knownPaths);
      assert.deepEqual([...actual].sort(), [...expected].sort(), `${relative}: original article membership and pagination`);
      report.taxonomyAndArchiveMemberships++;
    }
  }
}

const brokenReferences = [];
for (const filename of (await filesIn(distRoot)).filter((filename) => filename.endsWith('.html'))) {
  const relative = path.relative(distRoot, filename).split(path.sep).join('/');
  const pageUrl = new URL(`/${relative.replace(/index\.html$/, '')}`, origin);
  const document = await documentAt(filename);
  for (const node of elements(document)) {
    for (const name of ['href', 'src']) {
      const value = attribute(node, name);
      if (!value || /^(?:mailto:|tel:|data:|javascript:|blob:)/i.test(value)) continue;
      if (value.startsWith('#')) { report.skippedFragmentLinks++; continue; }
      const url = new URL(value, pageUrl);
      if (url.origin !== origin) continue;
      if (url.search) report.linksWithQueries++;
      try { assert.ok((await stat(outputPath(url))).isFile()); }
      catch { brokenReferences.push(`${relative}: ${name}=${value}`); }
      report.checkedInternalReferences++;
    }
  }
}
const search = JSON.parse(await readFile(path.join(distRoot, 'search.json'), 'utf8'));
assert.equal(search.length, records.length, 'Full-text search covers every published article');
for (const { record, url, source, visibleCount } of articleRecords) {
  const item = search.find((entry) => entry.url === url);
  assert.ok(item, `${url}: present in search`);
  assert.equal(item.title, record.title, `${url}: original searchable title`);
  assert.deepEqual(item.tags, source.data.tags || [], `${url}: original searchable tags`);
  assert.deepEqual(item.categories, source.data.categories || [], `${url}: original searchable category hierarchy`);
  assert.equal([...item.text.replace(/\s/g, '')].length, visibleCount, `${url}: search indexes the complete visible article text`);
  // Pick a real prose phrase from late in the source, beyond headings and list excerpts.
  const probes = source.content.match(/[\p{Script=Han}]{12,36}/gu) || [];
  assert.ok(probes.length, `${url}: source provides a prose search probe`);
  const probe = probes.at(-1);
  assert.ok(item.text.includes(probe), `${url}: full body can find “${probe}”`);
  report.searchBodyProbes++;
}
report.searchEntries = search.length;

const feed = parse(await readFile(path.join(distRoot, 'atom.xml'), 'utf8'));
const entries = elements(feed, (node) => node.tagName === 'entry');
assert.equal(entries.length, records.length, 'Atom subscription contains every original article');
const entryIds = entries.map((entry) => normalized(textContent(elements(entry, (node) => node.tagName === 'id')[0])));
for (const { url } of articleRecords) assert.ok(entryIds.includes(`${origin}${encodeURI(url)}`), `${url}: stable Atom article identifier`);
report.feedEntries = entries.length;

assert.deepEqual(brokenReferences, [], 'Every emitted same-site href and src resolves to a real static file');
console.log('Static migration verification passed.');
console.log(JSON.stringify(report, null, 2));
