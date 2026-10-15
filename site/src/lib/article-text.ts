import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

const processor = createMarkdownProcessor({
  remarkPlugins: [remarkMath],
  rehypePlugins: [rehypeKatex],
  syntaxHighlight: false,
});
const textCache = new Map<string, Promise<string>>();
const blockElements = new Set(['p', 'div', 'pre', 'blockquote', 'li', 'tr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Extract one visible-text representation, including code and one copy of each formula. */
function visibleText(node: DefaultTreeAdapterMap['node']): string {
  if ('value' in node) return node.value;
  if (!('childNodes' in node)) return '';
  if ('tagName' in node) {
    const classes = node.attrs.find((attribute) => attribute.name === 'class')?.value.split(/\s+/) || [];
    // KaTeX emits MathML plus a duplicate visual tree; count the semantic formula only once.
    if (['script', 'style', 'annotation'].includes(node.tagName) || classes.includes('katex-html')) return '';
    const text = node.childNodes.map(visibleText).join('');
    return blockElements.has(node.tagName) ? `\n${text}\n` : text;
  }
  return node.childNodes.map(visibleText).join('');
}

/** Convert complete Markdown to searchable visible text without consuming code comparison operators. */
export async function getArticleText(markdown: string): Promise<string> {
  // Cache by body rather than post ID, so editing an existing article immediately changes its metrics.
  if (!textCache.has(markdown)) {
    textCache.set(markdown, (async () => {
      const { code } = await (await processor).render(markdown);
      return visibleText(parseFragment(code)).replace(/\s+/g, ' ').trim();
    })());
  }
  return textCache.get(markdown)!;
}

/** Count non-whitespace Unicode characters, including code and excluding markup or generated line numbers. */
export function countCharacters(text: string): number {
  return [...text.replace(/\s/g, '')].length;
}

/** Estimate reading time using the site's existing 550-character-per-minute rate. */
export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 550));
}

/** Produce a short automatic excerpt when the author has not supplied one. */
export function createExcerpt(text: string, limit = 132): string {
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : text;
}
