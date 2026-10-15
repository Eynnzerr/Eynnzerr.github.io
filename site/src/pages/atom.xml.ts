import type { APIRoute } from 'astro';
import { getPosts } from '../lib/posts';

/** Escape text and attribute values for the existing Atom subscription endpoint. */
function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

/** Publish the latest twenty articles under their unchanged canonical addresses. */
export const GET: APIRoute = async () => {
  const posts = (await getPosts()).slice(0, 20);
  const origin = 'https://blog.eynnzerr.cloud';
  const updated = new Date(Math.max(...posts.map((post) => post.updated.getTime()))).toISOString();
  const entries = posts.map((post) => {
    const url = `${origin}${encodeURI(post.url)}`;
    return `<entry><title>${xml(post.title)}</title><link href="${xml(url)}"/><id>${xml(url)}</id><published>${post.date.toISOString()}</published><updated>${post.updated.toISOString()}</updated><summary>${xml(post.description)}</summary>${post.tags.map((tag) => `<category term="${xml(tag)}"/>`).join('')}<author><name>Eynnzerr</name></author></entry>`;
  }).join('');
  const feed = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Eynnzerr · 博客</title><subtitle>边做，边想，边记。</subtitle><link href="${origin}/atom.xml" rel="self"/><link href="${origin}/blog/"/><id>${origin}/</id><updated>${updated}</updated><author><name>Eynnzerr</name></author>${entries}</feed>`;
  return new Response(feed, { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } });
};
