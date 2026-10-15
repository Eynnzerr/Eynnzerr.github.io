/** The mode control attached to a single initialized sculpture canvas. */
interface ResonanceController {
  /** Unfold into the game lanes or gather back into the home sculpture. */
  setMode(active: boolean): void;
}

/** Keep repeated component and hero initialization on the same animation loop. */
const controllers = new WeakMap<HTMLCanvasElement, ResonanceController>();

/** Start one pointer-responsive sculpture, reusing an existing canvas controller. */
export function startResonance(canvas: HTMLCanvasElement): void {
  if (controllers.has(canvas)) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const context = ctx;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const startedAt = performance.now();
  const duration = 1150;
  let width = 0;
  let height = 0;
  let frame = 0;
  let visible = true;
  let pointerX = 0;
  let pointerY = 0;
  let smoothX = 0;
  let smoothY = 0;
  let progress = 0;
  let from = 0;
  let target = 0;
  let transitionAt = startedAt;
  let theme = document.documentElement.dataset.theme === 'dark' ? 1 : 0;
  let themeFrom = theme;
  let themeTarget = theme;
  let themeAt = startedAt;

  /** Clamp and ease a segment of the unfolding motion without overshooting it. */
  function ease(value: number): number {
    const clamped = Math.max(0, Math.min(1, value));
    return clamped * clamped * (3 - 2 * clamped);
  }

  /** Sample wall-clock progress so returning to a hidden tab settles its mode. */
  function updateProgress(now: number): void {
    if (motion.matches) progress = target;
    else if (progress !== target) {
      const elapsed = Math.min(1, (now - transitionAt) / duration);
      progress = elapsed === 1 ? target : from + (target - from) * elapsed;
    }
  }

  /** Blend the DOM theme over 600 ms, independently of the geometry transition. */
  function updateTheme(now: number): void {
    if (motion.matches) theme = themeTarget;
    else if (theme !== themeTarget) {
      const elapsed = Math.min(1, (now - themeAt) / 600);
      theme = elapsed === 1 ? themeTarget : themeFrom + (themeTarget - themeFrom) * ease(elapsed);
    }
  }

  /** Request at most one frame, respecting visibility and reduced motion. */
  function wake(): void {
    if (frame || !visible || document.hidden) return;
    if (motion.matches) draw(performance.now());
    else frame = requestAnimationFrame(draw);
  }

  /** Release a pending frame while a canvas or browser tab is out of view. */
  function sleep(): void {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  /** Match the drawing buffer to the animated stage, bounding pixel density. */
  function resize(): void {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    const ratio = Math.min(devicePixelRatio, 1.7);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    // ResizeObserver runs after animation callbacks: redraw the reset buffer before paint.
    sleep();
    if (visible && !document.hidden) draw(performance.now());
  }

  /** Project the rotating torus into the sculpture's current displayed bounds. */
  function project(x: number, y: number, z: number, angle: number): [number, number, number] {
    const turn = angle + smoothX * .15;
    const a = x * Math.cos(turn) + z * Math.sin(turn);
    const b = -x * Math.sin(turn) + z * Math.cos(turn);
    const tilt = .6 + smoothY * .12;
    const c = y * Math.cos(tilt) - b * Math.sin(tilt);
    const depth = y * Math.sin(tilt) + b * Math.cos(tilt);
    const perspective = 760 / (760 + depth);
    return [width * .52 + a * perspective, height * .48 + c * perspective, depth];
  }

  /** Place a strand inside one of four narrow bundles along the perspective lane. */
  function lanePoint(lane: number, strand: number, distance: number): [number, number] {
    const depth = distance ** 1.35;
    const spread = width * (.09 + .58 * depth);
    return [width * .5 + (lane - 1.5 + strand * .1) * spread / 4, height * (.18 + .71 * depth)];
  }

  /** Unroll the torus threads into four lanes; the final settled lanes then fade. */
  function draw(now: number): void {
    frame = 0;
    updateProgress(now);
    updateTheme(now);
    context.clearRect(0, 0, width, height);
    // A completed game transition leaves no animation work behind the game canvas.
    if (progress === 1 && target === 1) return;
    const time = motion.matches ? 0 : (now - startedAt) / 1000;
    smoothX += (pointerX - smoothX) * .025;
    smoothY += (pointerY - smoothY) * .025;
    const scale = Math.min(width * .33, height * .37);
    const angle = -.35 + time * .075;
    const fade = 1 - ease((progress - .8) / .2);
    const palette = ease(progress / .75);
    const stage = ease(progress / .8);
    const darkness = theme + (1 - theme) * stage;
    // A low, diffuse shadow gives the light sculpture a surface to float above.
    if (darkness < 1) {
      context.save();
      context.globalCompositeOperation = 'source-over';
      context.translate(width * .52, height * .48 + scale * .95);
      context.scale(1, .19);
      const shadow = context.createRadialGradient(0, 0, scale * .08, 0, 0, scale * .95);
      shadow.addColorStop(0, `rgba(32,71,61,${.09 * (1 - darkness) * fade})`);
      shadow.addColorStop(.5, `rgba(32,71,61,${.04 * (1 - darkness) * fade})`);
      shadow.addColorStop(1, 'rgba(32,71,61,0)');
      context.fillStyle = shadow;
      context.fillRect(-scale, -scale, scale * 2, scale * 2);
      context.restore();
    }
    for (let band = 0; band < 64; band++) {
      const v = band / 63 * Math.PI * 2;
      const lane = Math.floor(band / 16);
      const strand = (band % 16) / 15 - .5;
      context.beginPath();
      let depthSum = 0;
      for (let step = 0; step <= 190; step++) {
        const distance = step / 190;
        const u = distance * Math.PI * 2;
        const wave = Math.sin(u * 3 + v * 1.5 + time * .4) * 15 + Math.sin(u * 2 - time * .25) * 13;
        const radius = scale * .72 + Math.cos(v) * scale * .23 + wave;
        const x = Math.cos(u) * radius;
        const y = Math.sin(v) * scale * .4 + Math.cos(u * 2 + time * .2) * scale * .18;
        const z = Math.sin(u) * radius;
        const [px, py, depth] = project(x, y, z, angle);
        depthSum += depth;
        // Each closed thread opens from one end, with adjacent lane bundles following.
        const unfold = ease((progress - lane * .02 - distance * .06) / .68);
        const [laneX, laneY] = lanePoint(lane, strand, distance);
        const curl = Math.sin(unfold * Math.PI) * scale * .38;
        const drawX = px + (laneX - px) * unfold + Math.cos(u + v) * curl;
        const drawY = py + (laneY - py) * unfold - Math.sin(u * .5 + v) * curl * .65;
        if (step === 0) context.moveTo(drawX, drawY); else context.lineTo(drawX, drawY);
      }
      const warmth = (Math.sin(v + time * .13) + 1) / 2;
      const near = 1 - Math.min(1, Math.max(0, (depthSum / 191 + scale) / (scale * 2)));
      const laneColor = lane < 2 ? [132, 231, 238] : [245, 178, 155];
      const red = Math.round((117 + warmth * 108) * (1 - palette) + laneColor[0] * palette);
      const green = Math.round((218 - warmth * 57) * (1 - palette) + laneColor[1] * palette);
      const blue = Math.round((190 - warmth * 74) * (1 - palette) + laneColor[2] * palette);
      const alpha = ((.1 + near * .25) * (1 - palette) + .13 * palette) * fade;
      context.lineWidth = band % 8 === 0 ? 1 + darkness * .2 : .6 + darkness * .05;
      // Ink and emitted light use separate compositing passes so both remain legible.
      if (darkness < 1) {
        const inkRed = Math.round(36 + warmth * 133);
        const inkGreen = Math.round(99 - warmth * 5);
        const inkBlue = Math.round(91 - warmth * 30);
        context.globalCompositeOperation = 'source-over';
        context.strokeStyle = `rgba(${inkRed},${inkGreen},${inkBlue},${(.13 + near * .36) * (1 - darkness) * fade})`;
        context.stroke();
      }
      if (darkness > 0) {
        context.globalCompositeOperation = 'lighter';
        context.strokeStyle = `rgba(${red},${green},${blue},${alpha * darkness})`;
        context.stroke();
      }
    }
    // Peripheral points become the first glowing note-like markers in the lane space.
    for (let i = 0; i < 35; i++) {
      const a = i * 2.399 + time * .016;
      const r = scale * (1.15 + (i % 7) * .065);
      const x = width * .52 + Math.cos(a) * r;
      const y = height * .48 + Math.sin(a) * r * .75;
      const unfold = ease((progress - (i % 4) * .02) / .74);
      const [laneX, laneY] = lanePoint(i % 4, 0, (i * .173) % 1);
      const drawX = x + (laneX - x) * unfold;
      const drawY = y + (laneY - y) * unfold;
      const warm = progress > .4 ? i % 4 > 1 : i % 6 === 0;
      context.beginPath();
      context.ellipse(drawX, drawY, (i % 6 === 0 ? 1.7 : .7) + unfold * 2.2, 1 + unfold, 0, 0, Math.PI * 2);
      if (darkness < 1) {
        context.globalCompositeOperation = 'source-over';
        context.fillStyle = warm ? `rgba(170,98,61,${.6 * (1 - darkness) * fade})` : `rgba(43,106,93,${.4 * (1 - darkness) * fade})`;
        context.fill();
      }
      if (darkness > 0) {
        context.globalCompositeOperation = 'lighter';
        context.fillStyle = warm ? `rgba(245,178,155,${.6 * darkness * fade})` : `rgba(132,231,238,${(.27 + unfold * .3) * darkness * fade})`;
        context.fill();
      }
    }
    context.globalCompositeOperation = 'source-over';
    if (!motion.matches) wake();
  }

  controllers.set(canvas, {
    setMode(active: boolean): void {
      const next = active ? 1 : 0;
      if (next === target) return;
      const now = performance.now();
      updateProgress(now);
      from = progress;
      target = next;
      transitionAt = now;
      wake();
    },
  });

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) wake(); else sleep();
  }).observe(canvas);
  new MutationObserver(() => {
    const next = document.documentElement.dataset.theme === 'dark' ? 1 : 0;
    if (next === themeTarget) return;
    const now = performance.now();
    updateTheme(now);
    themeFrom = theme;
    themeTarget = next;
    themeAt = now;
    wake();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('pointermove', (event) => {
    pointerX = event.clientX / innerWidth - .5;
    pointerY = event.clientY / innerHeight - .5;
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sleep(); else wake();
  });
  motion.addEventListener('change', () => { sleep(); wake(); });
  resize();
}

/** Animate between the home sculpture and game lanes; initialize the canvas if needed. */
export function setResonanceMode(canvas: HTMLCanvasElement, active: boolean): void {
  startResonance(canvas);
  controllers.get(canvas)?.setMode(active);
}
