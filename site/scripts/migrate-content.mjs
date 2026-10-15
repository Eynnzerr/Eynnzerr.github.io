import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalRoot = path.resolve(siteRoot, '..');
const contentRoot = path.join(siteRoot, 'src/content/blog');

/** Copy a directory of article assets without touching the original Hexo tree. */
async function copyAssets(source, target) {
  await mkdir(target, { recursive: true });
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const from = path.join(source, item.name);
    const to = path.join(target, item.name);
    if (item.isDirectory()) await copyAssets(from, to);
    else await copyFile(from, to);
  }
}

await mkdir(contentRoot, { recursive: true });
const postRoot = path.join(originalRoot, 'source/_posts');
const filenames = (await readdir(postRoot)).filter((name) => name.endsWith('.md'));
const publishedRecords = JSON.parse(await readFile(path.join(originalRoot, 'db.json'), 'utf8')).models.Post;
for (const filename of filenames) {
  const sourceFile = path.join(postRoot, filename);
  const { data, content } = matter(await readFile(sourceFile, 'utf8'));
  // js-yaml treats a timezone-free YAML timestamp as UTC; its digits are local publication time.
  const sourceDate = data.date instanceof Date ? data.date.toISOString().slice(0, 19) : String(data.date).replace(' ', 'T');
  const date = `${sourceDate}+08:00`;
  const published = publishedRecords.find((post) => post.source === `_posts/${filename}`);
  const slug = published.slug;
  const legacyPath = `/${sourceDate.slice(0, 10).replaceAll('-', '/')}/${slug}/`;
  // Read the published update date before migration changes any file timestamps.
  const updated = published.updated;
  const body = content
    .replace(/(\]\()package-size-incre-md\//g, '$1/legacy-assets/package-size-incre-md/')
    .replace(/^```C[\t ]*$/gm, '```c');
  const metadata = {
    title: data.title,
    ...(data.description ? { description: data.description } : {}),
    date,
    updated,
    legacyPath,
    categories: data.categories || [],
    tags: data.tags || [],
  };
  await writeFile(path.join(contentRoot, filename), matter.stringify(body, metadata));
}
await copyAssets(path.join(originalRoot, 'source/package-size-incre-md'), path.join(siteRoot, 'public/legacy-assets/package-size-incre-md'));
console.log(`Migrated ${filenames.length} articles with original URLs and dates.`);
