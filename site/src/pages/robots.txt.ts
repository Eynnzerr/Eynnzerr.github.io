import type { APIRoute } from 'astro';

/** Allow public pages to be crawled and advertise the canonical sitemap. */
export const GET: APIRoute = ({ site }) => new Response(
  `User-agent: *\nAllow: /\n\nSitemap: ${new URL('/sitemap.xml', site)}\n`,
  { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
);
