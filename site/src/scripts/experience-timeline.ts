/** Animate the public timeline on scroll and pointer input, with a static reduced-motion mode. */
export function initializeExperienceTimeline(): void {
  const root = document.querySelector<HTMLElement>('[data-journey]');
  if (!root) return;
  const entries = [...root.querySelectorAll<HTMLElement>('[data-journey-entry]')];
  const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-journey-link]')];
  const year = root.querySelector<HTMLElement>('[data-journey-year]')!;
  const caption = root.querySelector<HTMLElement>('[data-journey-caption]')!;
  const list = root.querySelector<HTMLOListElement>('.journey-list')!;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  let activeIndex = -1;
  let frame = 0;
  root.dataset.ready = '';

  /** Follow the reading position without continuously rendering an idle page. */
  function updatePosition(): void {
    frame = 0;
    const readingLine = innerHeight * 0.46;
    let nextIndex = 0;
    entries.forEach((entry, index) => {
      if (entry.getBoundingClientRect().top < readingLine) nextIndex = index;
    });
    const bounds = list.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (readingLine - bounds.top - 29) / (bounds.height - 59)));
    root!.style.setProperty('--journey-progress', String(progress));
    root!.style.setProperty('--journey-cursor', `${entries[nextIndex]!.offsetTop + 42}px`);
    if (nextIndex === activeIndex) return;
    activeIndex = nextIndex;
    entries.forEach((entry, index) => {
      if (index === activeIndex) entry.dataset.active = 'true';
      else delete entry.dataset.active;
    });
    links.forEach((link, index) => {
      if (index === activeIndex) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    });
    const entry = entries[activeIndex]!;
    year.textContent = entry.dataset.year!;
    caption.textContent = entry.dataset.caption!;
    // Restart only the short year transition; the scroll track itself needs no animation loop.
    year.classList.remove('is-changing');
    if (!reducedMotion.matches) {
      void year.offsetWidth;
      year.classList.add('is-changing');
    }
  }

  /** Coalesce scroll and resize events into one layout read per frame. */
  function schedulePosition(): void {
    if (!frame) frame = requestAnimationFrame(updatePosition);
  }

  const visibility = new IntersectionObserver((observations) => {
    for (const observation of observations) {
      observation.target.classList.toggle('is-inview', observation.isIntersecting);
      if (observation.isIntersecting) observation.target.classList.add('is-revealed');
    }
  }, { threshold: 0.15 });

  entries.forEach((entry) => {
    visibility.observe(entry);
    entry.addEventListener('pointermove', (event) => {
      if (reducedMotion.matches || !finePointer.matches) return;
      const bounds = entry.getBoundingClientRect();
      entry.style.setProperty('--tilt-x', `${((event.clientY - bounds.top) / bounds.height - 0.5) * -12}deg`);
      entry.style.setProperty('--tilt-y', `${((event.clientX - bounds.left) / bounds.width - 0.5) * 16}deg`);
    });
    entry.addEventListener('pointerleave', () => {
      entry.style.removeProperty('--tilt-x');
      entry.style.removeProperty('--tilt-y');
    });
  });

  addEventListener('scroll', schedulePosition, { passive: true });
  addEventListener('resize', schedulePosition, { passive: true });
  addEventListener('pageshow', schedulePosition);
  updatePosition();
}
