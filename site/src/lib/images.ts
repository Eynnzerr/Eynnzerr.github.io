import type { ImageMetadata } from 'astro';

/**
 * Every optimizable site image. Authors keep writing root-relative paths such as
 * `/images/projects/a.jpg`; the file itself lives at `src/assets/images/projects/a.jpg`
 * so the build can resize it and emit AVIF/WebP instead of shipping the original.
 */
const files = import.meta.glob<{ default: ImageMetadata }>('../assets/images/**/*.{jpg,jpeg,png,webp,avif,gif}', { eager: true });

/** Whether an author-supplied source points at another site and must be used as is. */
export function isRemoteImage(src: string): boolean {
  return /^https?:\/\//.test(src);
}

/** Resolve an author-written `/images/...` path to its build-time image, failing loudly on typos. */
export function localImage(path: string): ImageMetadata {
  const file = files[`../assets${path}`];
  if (!file) throw new Error(`Image "${path}" was not found. Put the file at src/assets${path}.`);
  return file.default;
}
