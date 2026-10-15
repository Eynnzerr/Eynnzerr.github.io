import type { MarkdownInstance } from 'astro';

/** Editorial formats supported by the mixed life timeline. */
export type LifeKind = 'thought' | 'essay' | 'photos' | 'video';

/** A photograph and its accessible description, optionally with a caption. */
export interface LifePhoto {
  /** Root-relative file path or public HTTPS image URL. */
  src: string;
  /** Concrete description of the image for screen readers. */
  alt: string;
  /** Optional caption shown in the lightbox. */
  caption?: string;
}

/** Author-maintained metadata at the top of a life Markdown entry. */
export interface LifeFrontmatter {
  /** Display title of the entry. */
  title: string;
  /** Determines the timeline presentation. */
  type: LifeKind;
  /** Short description used in the timeline and page metadata. */
  summary: string;
  /** Actual publication date, quoted as YYYY-MM-DD; omit if unknown. */
  date?: string;
  /** Keep illustrative layouts in source files without publishing them. */
  demo?: boolean;
  /** Keep an unfinished entry out of the public timeline and generated routes. */
  draft?: boolean;
  /** Editorial order among undated entries, descending. */
  order?: number;
  /** Images belonging to a photo entry. */
  images?: LifePhoto[];
  /** Public Bilibili video identifier for an explicitly loaded player. */
  bvid?: string;
  /** Public video cover image URL. */
  poster?: string;
  /** Video duration displayed on its cover. */
  duration?: string;
  /** Short visible description of the source. */
  sourceLabel?: string;
  /** Optional original publication URL. */
  sourceUrl?: string;
}

/** A Markdown-backed timeline entry with its stable local address. */
export interface LifeEntry extends LifeFrontmatter {
  /** Filename-derived, stable entry identifier. */
  slug: string;
  /** Full article address for essays, timeline anchor for other formats. */
  url: string;
  /** Compiled Markdown component for inline thoughts and full essays. */
  Content: MarkdownInstance<LifeFrontmatter>['Content'];
}

/** User-facing names for each editorial format. */
export const lifeLabels: Record<LifeKind, string> = {
  thought: '短想法', essay: '随笔', photos: '照片', video: '视频',
};

/** Load published Markdown entries, excluding drafts and illustrative layouts. */
export function getLifeEntries(): LifeEntry[] {
  const modules = import.meta.glob<MarkdownInstance<LifeFrontmatter>>('../content/life/entries/*.md', { eager: true });
  return Object.entries(modules).filter(([, entry]) => !entry.frontmatter.demo && !entry.frontmatter.draft).map(([file, entry]) => {
    const slug = file.split('/').at(-1)!.replace(/\.md$/, '');
    return {
      ...entry.frontmatter,
      slug,
      url: entry.frontmatter.type === 'essay' ? `/life/${slug}/` : `/life/#${slug}`,
      Content: entry.Content,
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.order || 0) - (a.order || 0));
}

/** Display known publication dates without inventing dates for supplied media. */
export function formatLifeDate(date?: string): string {
  return date ? date.replaceAll('-', '.') : '日期未标注';
}
