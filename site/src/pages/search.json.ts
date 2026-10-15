import type { APIRoute } from 'astro';
import { getPosts, formatDate } from '../lib/posts';

/** Generate a static, same-origin index for all published article text. */
export const GET: APIRoute = async () => {
  const entries = (await getPosts()).map((post) => ({
    title: post.title, url: post.url, description: post.description,
    date: formatDate(post.date), tags: post.tags, categories: post.categories,
    readingMinutes: post.readingMinutes, text: post.text,
  }));
  return new Response(JSON.stringify(entries), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
};
