import { initializeRhythmGames, startRhythmGame, stopRhythmGame } from './rhythm-game';
import { startResonance, setResonanceMode } from './resonance';

/** Turn the homepage sculpture and rhythm game into two states of the same stage. */
export function initializeHeroStage(): void {
  const stage = document.querySelector<HTMLElement>('[data-hero-stage]');
  if (!stage || stage.dataset.mounted) return;
  const hero = stage;
  hero.dataset.mounted = 'true';
  const enter = hero.querySelector<HTMLButtonElement>('[data-enter-rhythm]')!;
  const exit = hero.querySelector<HTMLButtonElement>('[data-exit-rhythm]')!;
  const copy = hero.querySelector<HTMLElement>('.hero-content')!;
  const panel = hero.querySelector<HTMLElement>('[data-hero-game]')!;
  const toolbar = panel.querySelector<HTMLElement>('.hero-game-toolbar')!;
  const body = panel.querySelector<HTMLElement>('.hero-game-body')!;
  const game = panel.querySelector<HTMLElement>('[data-rhythm-game]')!;
  const canvas = hero.querySelector<HTMLCanvasElement>('#resonance-canvas')!;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let transitionTimer = 0;
  let active = false;
  // Restore the reader's original position when returning from the stage.
  let homeScrollTop = 0;
  initializeRhythmGames();
  startResonance(canvas);

  /** Let the shared stage grow when calibration or narrow-screen controls need room. */
  function fitStage(): void {
    const panelStyle = getComputedStyle(panel);
    const toolbarStyle = getComputedStyle(toolbar);
    const height = body.offsetHeight + toolbar.offsetHeight + parseFloat(toolbarStyle.marginBottom)
      + parseFloat(panelStyle.paddingTop) + parseFloat(panelStyle.paddingBottom);
    hero.style.setProperty('--game-height', `${height}px`);
  }
  const sizeObserver = new ResizeObserver(fitStage);
  sizeObserver.observe(body);
  sizeObserver.observe(toolbar);

  /** Commit the destination after the shared visual transition has completed. */
  function settle(): void {
    clearTimeout(transitionTimer);
    hero.dataset.mode = active ? 'game' : 'home';
  }

  /** Start audio in the user's activation, leaving enough lead-in for the visual morph. */
  function enterGame(): void {
    if (active) return;
    active = true;
    homeScrollTop = window.scrollY;
    clearTimeout(transitionTimer);
    enter.setAttribute('aria-expanded', 'true');
    copy.inert = true;
    panel.inert = false;
    panel.setAttribute('aria-hidden', 'false');
    hero.dataset.mode = 'entering';
    window.scrollTo({ top: hero.getBoundingClientRect().top + window.scrollY, behavior: motion.matches ? 'instant' : 'smooth' });
    setResonanceMode(canvas, true);
    startRhythmGame(game, motion.matches ? 0 : 1.15);
    // Move focus before hiding the trigger's subtree from assistive technology.
    exit.focus({ preventScroll: true });
    if (motion.matches) settle();
    else transitionTimer = window.setTimeout(settle, 1200);
  }

  /** Silence the game immediately, then rebuild the original visual and return focus. */
  function leaveGame(): void {
    if (!active) return;
    active = false;
    clearTimeout(transitionTimer);
    stopRhythmGame(game);
    hero.dataset.mode = 'exiting';
    panel.inert = true;
    copy.inert = false;
    enter.setAttribute('aria-expanded', 'false');
    enter.focus({ preventScroll: true });
    panel.setAttribute('aria-hidden', 'true');
    window.scrollTo({ top: homeScrollTop, behavior: motion.matches ? 'instant' : 'smooth' });
    setResonanceMode(canvas, false);
    if (motion.matches) settle();
    else transitionTimer = window.setTimeout(settle, 1200);
  }

  enter.addEventListener('click', enterGame);
  exit.addEventListener('click', leaveGame);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active) { event.preventDefault(); leaveGame(); }
  });
  game.addEventListener('rhythm:state', (event) => {
    hero.dataset.roundState = (event as CustomEvent<{ state: string }>).detail.state;
  });
  motion.addEventListener('change', () => {
    if (motion.matches && ['entering', 'exiting'].includes(hero.dataset.mode || '')) settle();
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(transitionTimer);
    if (active) leaveGame();
    clearTimeout(transitionTimer);
    hero.dataset.mode = 'home';
  });
}
