import type { APIRoute } from 'astro';
import { getPosts, getTags, getCategories, formatDate, PAGE_SIZE } from '../lib/posts';
import { getLifeEntries } from '../lib/life';

/** One canonical public page and its known content revision date. */
interface SitemapEntry {
  /** Root-relative public address. */
  path: string;
  /** Author-maintained revision date; omit when it is unknown. */
  updated?: string;
}

/** Escape URL and date text for XML without changing URL encoding. */
function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

/** List canonical pages, omitting legacy pagination aliases and unpublished life entries. */
export const GET: APIRoute = async ({ site }) => {
  const posts = await getPosts();
  const entries: SitemapEntry[] = ['/', '/blog/', '/projects/', '/life/', '/about/', '/tags/', '/categories/'].map((path) => ({ path }));
  for (let page = 2; page <= Math.ceil(posts.length / PAGE_SIZE); page++) {
    entries.push({ path: `/blog/page/${page}/` });
  }
  for (const post of posts) entries.push({ path: post.url, updated: post.updated.toISOString() });
  for (const tag of getTags(posts)) entries.push({ path: `/tags/${tag.slug}/` });
  for (const category of getCategories(posts)) entries.push({ path: `/categories/${category.slug}/` });

  const years = [...new Set(posts.map((post) => formatDate(post.date).slice(0, 4)))];
  const months = [...new Set(posts.map((post) => formatDate(post.date).slice(0, 7)))];
  for (const period of ['', ...years, ...months]) {
    const count = posts.filter((post) => formatDate(post.date).startsWith(period)).length;
    const base = `/archives/${period ? `${period.replace('-', '/')}/` : ''}`;
    for (let page = 1; page <= Math.ceil(count / PAGE_SIZE); page++) {
      entries.push({ path: page === 1 ? base : `${base}page/${page}/` });
    }
  }
  for (const entry of getLifeEntries()) {
    if (entry.type === 'essay') entries.push({ path: entry.url, updated: entry.date });
  }

  const urls = entries.map((entry) => `<url><loc>${xml(new URL(entry.path, site).href)}</loc>${entry.updated ? `<lastmod>${xml(entry.updated)}</lastmod>` : ''}</url>`).join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
