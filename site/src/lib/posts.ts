import { getCollection, type CollectionEntry } from 'astro:content';
import { getArticleText, countCharacters, readingMinutes, createExcerpt } from './article-text';

/** An article with presentation-ready metadata and its immutable public address. */
export interface BlogPost {
  /** Collection entry passed to Astro's Markdown renderer. */
  entry: CollectionEntry<'blog'>;
  /** Source collection identifier. */
  id: string;
  /** Original article title. */
  title: string;
  /** Plain-text excerpt for lists and metadata. */
  description: string;
  /** Complete parsed visible text, shared by search and automatic statistics. */
  text: string;
  /** Original publication instant. */
  date: Date;
  /** Author-provided update instant, defaulting to the publication date. */
  updated: Date;
  /** Permanent slash-terminated path, retaining explicit legacy addresses when supplied. */
  url: string;
  /** Ordered parent-to-child category chain. */
  categories: string[];
  /** Independent topic labels. */
  tags: string[];
  /** Current visible character count, including code and excluding whitespace. */
  wordCount: number;
  /** Estimated reading duration at 550 characters per minute. */
  readingMinutes: number;
}

/** A tag or a node in the original category hierarchy. */
export interface TaxonomyGroup {
  /** Human-readable label of the selected node. */
  name: string;
  /** Legacy relative taxonomy URL, including parent segments. */
  slug: string;
  /** Parent-to-child labels for breadcrumb navigation. */
  path: string[];
  /** Articles associated with this node or its descendants. */
  posts: BlogPost[];
}

/** Original list pagination size. */
export const PAGE_SIZE = 10;

/** Return published articles in reverse chronological order. */
export async function getPosts(): Promise<BlogPost[]> {
  return (await Promise.all((await getCollection('blog')).map(async (entry) => {
    const text = await getArticleText(entry.body || '');
    const wordCount = countCharacters(text);
    const filename = entry.filePath?.split('/').at(-1)?.replace(/\.md$/, '') || entry.id;
    return {
      entry,
      id: entry.id,
      title: entry.data.title,
      description: entry.data.description || createExcerpt(text),
      text,
      date: entry.data.date,
      updated: entry.data.updated || entry.data.date,
      url: entry.data.legacyPath || `/${formatDate(entry.data.date).replaceAll('-', '/')}/${filename}/`,
      categories: entry.data.categories,
      tags: entry.data.tags,
      wordCount,
      readingMinutes: readingMinutes(wordCount),
    };
  }))).sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Format a publication date in the site's explicit China time zone. */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Display a compact character count without changing its underlying value. */
export function formatCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** Convert a taxonomy label to its existing Hexo path segment. */
export function taxonomySlug(label: string): string {
  return label.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
}

/** Group tags while preserving their original labels. */
export function getTags(posts: BlogPost[]): TaxonomyGroup[] {
  const groups = new Map<string, TaxonomyGroup>();
  for (const post of posts) {
    for (const name of post.tags) {
      const slug = taxonomySlug(name);
      if (!groups.has(slug)) groups.set(slug, { name, slug, path: [name], posts: [] });
      groups.get(slug)!.posts.push(post);
    }
  }
  return [...groups.values()].sort((a, b) => b.posts.length - a.posts.length || a.name.localeCompare(b.name));
}

/** Group every ancestor in a category chain, including CSAPP → C/C++. */
export function getCategories(posts: BlogPost[]): TaxonomyGroup[] {
  const groups = new Map<string, TaxonomyGroup>();
  for (const post of posts) {
    post.categories.forEach((name, index) => {
      const path = post.categories.slice(0, index + 1);
      const slug = path.map(taxonomySlug).join('/');
      if (!groups.has(slug)) groups.set(slug, { name, slug, path, posts: [] });
      groups.get(slug)!.posts.push(post);
    });
  }
  return [...groups.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

