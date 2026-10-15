import matter from 'gray-matter';

/** Public metadata used by the curated project gallery. */
export interface Project {
  /** Stable fragment identifier. */
  id: string;
  /** Public product name. */
  title: string;
  /** Short editorial introduction. */
  subtitle: string;
  /** Factual feature summary. */
  description: string;
  /** Gallery filter label. */
  category: string;
  /** Implementation technologies. */
  stack: string[];
  /** Supported platforms. */
  platforms: string;
  /** Publication status. */
  status: string;
  /** Main screenshot path. */
  image: string;
  /** Accessible description of the main screenshot's actual content. */
  imageAlt?: string;
  /** Optional second phone screenshot. */
  secondaryImage?: string;
  /** Accessible description of the second screenshot's actual content. */
  secondaryImageAlt?: string;
  /** Screenshot composition selected for this product. */
  visual: 'phones' | 'desktop' | 'banner';
  /** Short decorative phrase placed beside the product screenshots. */
  visualLabel?: string;
  /** Public repository URL. */
  source: string;
  /** Release listing URL. */
  download?: string;
  /** Live product URL. */
  demo?: string;
  /** Author's introduction video URL. */
  video?: string;
  /** Explicit editorial order. */
  order: number;
}

/** Read editable project Markdown metadata in editorial order. */
export function getProjects(): Project[] {
  const files = import.meta.glob('../content/projects/*.md', { query: '?raw', import: 'default', eager: true });
  return Object.values(files).map((raw) => matter(raw as string).data as Project).sort((a, b) => a.order - b.order);
}
