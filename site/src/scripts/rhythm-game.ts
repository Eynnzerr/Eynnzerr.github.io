import {
  APPROACH_SECONDS, BEAT_SECONDS, COUNTDOWN_SECONDS, GRADE_WEIGHTS,
  createChart, judgeTiming, missWindow, normalizedScore, sectionAt,
  type ChartNote, type Difficulty, type HitGrade, type Lane,
} from '../lib/rhythm-chart';

/** All visible states in a single, restartable round. */
type GameState = 'idle' | 'loading' | 'countdown' | 'playing' | 'paused' | 'finished';

/** The chart's immutable timing plus its one-time judgement. */
interface PlayedNote extends ChartNote {
  /** Null until the note is hit or passes the last allowed timing window. */
  grade: HitGrade | 'miss' | null;
}

/** Totals used by the live HUD and the completed-round scorecard. */
interface RoundStats {
  /** Current consecutive successful taps. */
  combo: number;
  /** Largest consecutive successful sequence in this round. */
  bestCombo: number;
  /** Sum of timing-grade weights. */
  weightedHits: number;
  /** Counts for each of the three successful grades and misses. */
  grades: Record<HitGrade | 'miss', number>;
}

/** A short decorative spark emitted by a successful tap. */
interface Spark {
  /** Initial horizontal position in CSS pixels. */
  x: number;
  /** Initial vertical position in CSS pixels. */
  y: number;
  /** Horizontal velocity in CSS pixels per second. */
  vx: number;
  /** Vertical velocity in CSS pixels per second. */
  vy: number;
  /** Birth time on the performance clock, in seconds. */
  born: number;
  /** Colour belonging to the note's lane. */
  color: string;
}

/** Minimal lifecycle controls shared with the enclosing homepage hero. */
interface RhythmGameController {
  /** Start a fresh round from a user action, after an optional entrance transition. */
  start: (entryDelaySeconds: number) => void;
  /** Cancel every active phase and return the component to its silent idle state. */
  stop: () => void;
  /** Release this instance's observers, listeners, and audio context. */
  destroy: () => void;
}

/** Mounted instances retain their own clock and clean up when Astro changes pages. */
const mountedGames = new Map<HTMLElement, RhythmGameController>();

/** Create an empty scorecard for a newly selected chart. */
function emptyStats(): RoundStats {
  return { combo: 0, bestCombo: 0, weightedHits: 0, grades: { perfect: 0, great: 0, good: 0, miss: 0 } };
}

/** Format elapsed track time without counting the pre-roll as part of the song. */
function clockLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** Attach a playable round to one component and expose its explicit lifecycle. */
function mountGame(root: HTMLElement): RhythmGameController {
  /** Resolve a required element from the component's private markup contract. */
  const find = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const canvas = find<HTMLCanvasElement>('[data-game-canvas]');
  const paint = canvas.getContext('2d')!;
  const stage = find<HTMLElement>('[data-game-stage]');
  const playButton = find<HTMLButtonElement>('[data-game-play]');
  const stopButton = find<HTMLButtonElement>('[data-game-stop]');
  const status = find<HTMLElement>('[data-game-status]');
  const volume = find<HTMLInputElement>('[data-game-volume]');
  const offset = find<HTMLInputElement>('[data-game-offset]');
  const offsetReset = find<HTMLButtonElement>('[data-offset-reset]');
  const modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-difficulty]'));
  const pads = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-lane]'));
  const cleanupEvents: Array<() => void> = [];
  const pressedKeys = new Set<Lane>();
  const activePointers = new Map<number, Lane>();
  const laneFlashes = [-10, -10, -10, -10];
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const keyLanes: Record<string, Lane> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
  const laneColors = ['#84e7ee', '#84e7ee', '#f5b29b', '#f5b29b'];
  // The hero's embedded stage aligns with its wider four-pad control surface.
  const embedded = root.classList.contains('rhythm-game-embedded');
  const maxLaneWidth = embedded ? 640 : 464;

  let state: GameState = 'idle';
  let reducedMotion = motionPreference.matches;
  let difficulty: Difficulty = 'easy';
  let notes: PlayedNote[] = createChart(difficulty).map((note) => ({ ...note, grade: null }));
  let stats = emptyStats();
  let audio: AudioContext | null = null;
  let gain: GainNode | null = null;
  let buffer: AudioBuffer | null = null;
  let loadingBuffer: Promise<AudioBuffer> | null = null;
  let loadingController: AbortController | null = null;
  let source: AudioBufferSourceNode | null = null;
  let playbackStart = 0;
  let playbackOffset = 0;
  let pausedAt = 0;
  let roundToken = 0;
  let offsetSeconds = 0;
  let frame = 0;
  let width = 460;
  let height = 366;
  let isVisible = true;
  let destroyed = false;
  let feedbackAt = -10;
  let sparks: Spark[] = [];
  let lastProgressSecond = -1;

  /** Register a listener whose cleanup belongs to this mounted component. */
  function listen(target: EventTarget, name: string, listener: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(name, listener, options);
    cleanupEvents.push(() => target.removeEventListener(name, listener, options));
  }

  /** Set a small display field without inserting user-controlled markup. */
  function text(selector: string, value: string): void {
    const element = find<HTMLElement>(selector);
    if (element.textContent !== value) element.textContent = value;
  }

  /** The live phase includes the visible pre-roll before the first audio sample. */
  function isRunning(): boolean {
    return state === 'playing' || state === 'countdown';
  }

  /** Wake rendering for a visible change without creating a second animation loop. */
  function requestFrame(): void {
    if (destroyed || frame || document.hidden) return;
    if (!isRunning() && (!isVisible || (embedded && root.closest('[inert]')))) return;
    frame = requestAnimationFrame(animate);
  }

  /** Release an idle callback when the stage cannot currently be seen. */
  function cancelFrame(): void {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  /** Keep frames only for live timing, an allowed idle animation, or fading feedback. */
  function needsAnotherFrame(timestamp: number): boolean {
    if (document.hidden) return false;
    if (isRunning()) return true;
    if (!isVisible || (embedded && root.closest('[inert]'))) return false;
    const latestFeedback = Math.max(feedbackAt, ...laneFlashes);
    return (!reducedMotion && state === 'idle') || timestamp / 1000 - latestFeedback < 0.7;
  }

  /** Keep controls, overlays, and selectable settings in sync with the round. */
  function setState(next: GameState): void {
    const changed = state !== next;
    state = next;
    root.dataset.state = state;
    const locked = state !== 'idle' && state !== 'finished';
    modeButtons.forEach((button) => { button.disabled = locked; });
    offset.disabled = locked;
    offsetReset.disabled = locked;
    playButton.disabled = state === 'loading';
    stopButton.disabled = !locked;
    find<HTMLElement>('[data-game-idle]').hidden = state !== 'idle' && state !== 'loading';
    find<HTMLElement>('[data-game-pause]').hidden = state !== 'paused';
    find<HTMLElement>('[data-game-result]').hidden = state !== 'finished';
    find<HTMLElement>('[data-game-countdown]').hidden = state !== 'countdown';
    find<HTMLElement>('[data-combo-wrap]').hidden = !isRunning() || stats.combo < 2;
    const label = state === 'loading' ? '准备音乐…' : isRunning() ? '暂停' : state === 'paused' ? '继续这一局' : state === 'finished' ? '再玩一次' : '开始一局';
    text('[data-play-label]', label);
    text('[data-play-icon]', isRunning() ? 'Ⅱ' : '▶');
    playButton.setAttribute('aria-label', label);
    if (state === 'idle' || state === 'paused' || state === 'finished') suspendAudio();
    requestFrame();
    if (changed) root.dispatchEvent(new CustomEvent('rhythm:state', { detail: { state }, bubbles: true }));
  }

  /** Construct and unlock Web Audio only inside the user's play action. */
  function getAudio(): AudioContext {
    if (!audio) {
      audio = new AudioContext({ latencyHint: 'interactive' });
      gain = audio.createGain();
      gain.gain.value = Number(volume.value) / 100;
      gain.connect(audio.destination);
      listen(audio, 'statechange', () => {
        // A pending resume can settle after the user stops during audio loading.
        if (audio?.state === 'running' && state !== 'loading' && !isRunning()) suspendAudio();
        // Mobile audio interruptions can expose an additional non-running state.
        if (audio && audio.state !== 'running' && audio.state !== 'closed' && isRunning()) {
          pauseRound('音频暂时中断，点击继续即可');
        }
      });
    }
    return audio;
  }

  /** Fetch and decode once; all restarts reuse the decoded, sample-timed recording. */
  async function getBuffer(): Promise<AudioBuffer> {
    if (buffer) return buffer;
    if (!loadingBuffer) {
      const controller = new AbortController();
      loadingController = controller;
      const pending = (async () => {
        const response = await fetch(root.dataset.audioSrc!, { signal: controller.signal });
        if (!response.ok) throw new Error(`Audio HTTP ${response.status}`);
        const decoded = await getAudio().decodeAudioData(await response.arrayBuffer());
        // Decoding itself cannot be aborted, so a cancelled round discards its result.
        if (controller.signal.aborted) throw new DOMException('Audio loading cancelled', 'AbortError');
        buffer = decoded;
        return buffer;
      })().finally(() => {
        // An older request must not clear the next round's in-flight load.
        if (loadingBuffer === pending) { loadingBuffer = null; loadingController = null; }
      });
      loadingBuffer = pending;
    }
    return loadingBuffer;
  }

  /** Abort network work and detach any decode that belongs to a cancelled round. */
  function cancelLoading(): void {
    loadingController?.abort();
    loadingController = null;
    loadingBuffer = null;
  }

  /** Map a browser input timestamp to the audio currently reaching the listener. */
  function audibleContextTime(performanceTime = performance.now()): number {
    if (!audio) return 0;
    // getOutputTimestamp accounts for the output pipeline instead of treating the
    // rendering clock as audible time. The event's timestamp also avoids queue jitter.
    if (typeof audio.getOutputTimestamp === 'function') {
      const { contextTime = 0, performanceTime: outputTime = 0 } = audio.getOutputTimestamp();
      if (contextTime > 0 && outputTime > 0) {
        // A timestamp from before suspension can briefly survive resume; audible
        // samples cannot be ahead of the current rendering clock.
        return Math.min(audio.currentTime, contextTime + (performanceTime - outputTime) / 1000);
      }
    }
    return audio.currentTime - (audio.outputLatency || audio.baseLatency || 0)
      + (performanceTime - performance.now()) / 1000;
  }

  /** Track position, excluding the lead-in and including any resumed offset. */
  function trackTime(performanceTime = performance.now()): number {
    if (state === 'paused') return pausedAt;
    if (state === 'idle' || state === 'loading') return 0;
    if (state === 'finished') return buffer?.duration ?? 33.8;
    return audibleContextTime(performanceTime) - playbackStart + playbackOffset;
  }

  /** Positive manual correction makes notes and their judgement arrive later. */
  function chartTime(performanceTime = performance.now()): number {
    const audibleTime = trackTime(performanceTime);
    // A resumed countdown holds the paused scene instead of replaying its history.
    const visibleTime = state === 'countdown' && playbackOffset > 0
      ? Math.max(playbackOffset, audibleTime) : audibleTime;
    return visibleTime - offsetSeconds;
  }

  /** Stop only this round's source; the shared output context stays reusable. */
  function stopSource(): void {
    if (source) {
      source.stop();
      source.disconnect();
      source = null;
    }
  }

  /** Release the audio device while silent; the next explicit play action resumes it. */
  function suspendAudio(): void {
    if (audio?.state === 'running') void audio.suspend();
  }

  /** Schedule against the audio clock, with enough pre-roll for visible notes. */
  function schedulePlayback(at: number, entryDelaySeconds = 0): void {
    const context = getAudio();
    stopSource();
    playbackOffset = at;
    playbackStart = context.currentTime + Math.max(0, entryDelaySeconds) + COUNTDOWN_SECONDS;
    source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain!);
    source.start(playbackStart, at);
    feedbackAt = -10;
    setState('countdown');
    find<HTMLElement>('[data-game-countdown]').hidden = entryDelaySeconds > 0;
    status.textContent = '等音符落到光线上，按下 D F J K 或触摸对应轨道。';
  }

  /** Clear physical holds when a round stops or the browser loses focus. */
  function releaseInputs(): void {
    pressedKeys.clear();
    activePointers.clear();
    pads.forEach((pad) => pad.classList.remove('is-pressed'));
  }

  /** Reset chart judgements and visual counters while keeping user settings. */
  function resetRound(): void {
    notes = createChart(difficulty).map((note) => ({ ...note, grade: null }));
    stats = emptyStats();
    pausedAt = 0;
    playbackOffset = 0;
    sparks = [];
    feedbackAt = -10;
    lastProgressSecond = -1;
    releaseInputs();
    updateScore();
    updateProgress(0);
  }

  /** Start or resume in direct response to a click; stale loads cannot start sound. */
  async function playRound(entryDelaySeconds = 0, restart = false): Promise<void> {
    if (!restart && isRunning()) {
      pauseRound('准备好了，就把旋律接下去');
      return;
    }
    if (!restart && state === 'loading') return;
    if (restart) { stopSource(); cancelLoading(); }
    const resume = !restart && state === 'paused';
    const at = resume ? pausedAt : 0;
    if (!resume) resetRound();
    const token = ++roundToken;
    setState('loading');
    status.textContent = '正在准备这段原创旋律…';
    try {
      await Promise.all([getAudio().resume(), getBuffer()]);
      if (destroyed || token !== roundToken) return;
      if (document.hidden) {
        pausedAt = at;
        setState('paused');
        text('[data-pause-reason]', '回到页面后，点击继续');
        return;
      }
      schedulePlayback(at, entryDelaySeconds);
    } catch {
      if (destroyed || token !== roundToken) return;
      setState(resume ? 'paused' : 'idle');
      status.textContent = '音乐暂时没能加载，请检查网络后再点一次开始。';
    }
  }

  /** Freeze score and audible position; resumption always requires another click. */
  function pauseRound(reason: string): void {
    if (!isRunning() && state !== 'loading') return;
    pausedAt = state === 'loading' ? pausedAt : Math.max(playbackOffset, trackTime());
    roundToken += 1;
    stopSource();
    releaseInputs();
    feedbackAt = -10;
    setState('paused');
    text('[data-pause-reason]', reason);
    status.textContent = '已暂停。点击「继续这一局」，倒数后从原处接着播放。';
  }

  /** End the current attempt and restore a silent, ready-to-play component. */
  function stopRound(): void {
    roundToken += 1;
    cancelLoading();
    stopSource();
    resetRound();
    setState('idle');
    text('[data-game-phase]', 'READY WHEN YOU ARE');
    status.textContent = '电脑按 D F J K，手机触摸四轨。声音在开始后播放。';
  }

  /** Update deterministic score and combo after one note changes judgement. */
  function updateScore(): void {
    text('[data-game-score]', String(normalizedScore(stats.weightedHits, notes.length)).padStart(7, '0'));
    text('[data-game-combo]', String(stats.combo));
    find<HTMLElement>('[data-combo-wrap]').hidden = !isRunning() || stats.combo < 2;
  }

  /** Announce visual feedback without flooding screen-reader live regions. */
  function showFeedback(grade: HitGrade | 'miss', delta = 0): void {
    feedbackAt = performance.now() / 1000;
    const element = find<HTMLElement>('[data-game-feedback]');
    element.dataset.grade = grade;
    text('[data-hit-grade]', grade.toUpperCase());
    text('[data-hit-detail]', grade === 'miss' ? '下一拍，再接上' : grade === 'perfect' ? 'JUST IN TIME' : `${delta < 0 ? '早了' : '晚了'} ${Math.round(Math.abs(delta) * 1000)} ms`);
  }

  /** Register one missed note exactly once. */
  function missNote(note: PlayedNote): void {
    note.grade = 'miss';
    stats.combo = 0;
    stats.grades.miss += 1;
    showFeedback('miss');
    updateScore();
  }

  /** Horizontal lane centre follows the trapezoid's visual perspective. */
  function laneX(lane: Lane, progress = 1): number {
    const topWidth = Math.min(width * 0.53, 280);
    const bottomWidth = Math.min(width * 0.9, maxLaneWidth);
    const spread = topWidth + (bottomWidth - topWidth) * progress;
    return width / 2 + (lane - 1.5) * spread / 4;
  }

  /** Judge against the nearest pending note in the pressed lane, never a random target. */
  function strike(lane: Lane, inputTime: number): void {
    laneFlashes[lane] = performance.now() / 1000;
    requestFrame();
    if (!isRunning()) return;
    // A resume countdown is preparation, not another chance to score paused notes.
    if (state === 'countdown' && playbackOffset > 0 && trackTime(inputTime) < playbackOffset) return;
    const now = chartTime(inputTime);
    let nearest: PlayedNote | undefined;
    let error = Infinity;
    for (const note of notes) {
      if (note.grade !== null || note.lane !== lane) continue;
      const distance = Math.abs(note.time - now);
      if (distance < error) { nearest = note; error = distance; }
      if (note.time > now + missWindow(difficulty)) break;
    }
    if (!nearest) return;
    const delta = now - nearest.time;
    const grade = judgeTiming(delta, difficulty);
    if (!grade) return;
    nearest.grade = grade;
    stats.combo += 1;
    stats.bestCombo = Math.max(stats.bestCombo, stats.combo);
    stats.grades[grade] += 1;
    stats.weightedHits += GRADE_WEIGHTS[grade];
    showFeedback(grade, delta);
    updateScore();
    if (!reducedMotion) {
      for (let index = 0; index < 7; index += 1) {
        sparks.push({ x: laneX(lane), y: height - 76, vx: (Math.random() - 0.5) * 100,
          vy: -45 - Math.random() * 105, born: performance.now() / 1000, color: laneColors[lane] });
      }
    }
  }

  /** Finish after the audible recording ends, retaining an inspectable result card. */
  function finishRound(): void {
    notes.forEach((note) => {
      if (note.grade === null) { note.grade = 'miss'; stats.grades.miss += 1; }
    });
    stopSource();
    releaseInputs();
    updateScore();
    const accuracy = stats.weightedHits / notes.length;
    const rank = accuracy >= 0.98 ? 'S' : accuracy >= 0.9 ? 'A' : accuracy >= 0.75 ? 'B' : accuracy >= 0.55 ? 'C' : 'D';
    text('[data-result-rank]', rank);
    text('[data-result-title]', rank === 'S' ? '每一拍，都在心上。' : rank === 'A' ? '这一拍，很合拍。' : rank === 'B' ? '已经找到你的节奏。' : rank === 'C' ? '旋律开始熟悉了。' : '再听一遍，再靠近一点。');
    text('[data-result-score]', normalizedScore(stats.weightedHits, notes.length).toLocaleString('en-US'));
    text('[data-result-accuracy]', `${(accuracy * 100).toFixed(1)}%`);
    text('[data-result-combo]', String(stats.bestCombo));
    text('[data-result-hits]', `PERFECT ${stats.grades.perfect} · GREAT ${stats.grades.great} · GOOD ${stats.grades.good} · MISS ${stats.grades.miss}`);
    setState('finished');
    feedbackAt = -10;
    updateProgress(buffer!.duration);
    text('[data-game-phase]', 'A MOMENT, WELL PLAYED');
    status.textContent = `${difficulty === 'easy' ? '轻松' : '挑战'}谱面完成。准确率 ${(accuracy * 100).toFixed(1)}%，最高 ${stats.bestCombo} 连击。`;
  }

  /** Reflect playback progress without making an accessibility update every frame. */
  function updateProgress(time: number): void {
    const duration = buffer?.duration ?? 33.8;
    const progress = Math.max(0, Math.min(1, time / duration));
    find<HTMLElement>('[data-progress-fill]').style.transform = `scaleX(${progress})`;
    const displayTime = progress === 1 ? Math.ceil(duration) : time;
    const second = Math.floor(Math.max(0, displayTime));
    if (second !== lastProgressSecond) {
      text('[data-game-time]', `${clockLabel(displayTime)} / ${clockLabel(Math.ceil(duration))}`);
      find<HTMLElement>('[data-game-progress]').setAttribute('aria-valuenow', String(Math.round(progress * 100)));
      lastProgressSecond = second;
    }
  }

  /** Match the canvas backing store to its CSS size, preserving sharp small notes. */
  function resize(): void {
    // Local layout dimensions stay correct while an ancestor scales during entry.
    width = stage.clientWidth;
    height = stage.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    requestFrame();
  }

  /** Draw one luminous note at its exact chart position. */
  function drawNote(lane: Lane, progress: number, alpha = 1): void {
    const depth = Math.pow(progress, 1.4);
    const y = 41 + (height - 117) * depth;
    const span = Math.min(width * 0.9, maxLaneWidth);
    const noteWidth = span / 4 * (0.37 + depth * 0.37);
    const noteHeight = 5 + depth * 4;
    const x = laneX(lane, depth);
    paint.globalAlpha = alpha;
    paint.fillStyle = laneColors[lane];
    paint.shadowColor = laneColors[lane];
    paint.shadowBlur = 8 + depth * 7;
    paint.beginPath();
    paint.roundRect(x - noteWidth / 2, y - noteHeight / 2, noteWidth, noteHeight, 3);
    paint.fill();
    paint.shadowBlur = 0;
    paint.fillStyle = '#edfffc';
    paint.globalAlpha = alpha * 0.7;
    paint.fillRect(x - noteWidth / 2 + 4, y - noteHeight / 2 + 1, noteWidth - 8, 1);
    paint.globalAlpha = 1;
  }

  /** Paint the lane space, beat lines, authored notes, and short hit sparks. */
  function drawScene(timestamp: number): void {
    const now = timestamp / 1000;
    const time = isRunning() ? chartTime(timestamp) : state === 'paused' ? pausedAt - offsetSeconds : 0;
    const hitY = height - 76;
    const topWidth = Math.min(width * 0.53, 280);
    const bottomWidth = Math.min(width * 0.9, maxLaneWidth);
    const top = 41;
    paint.clearRect(0, 0, width, height);

    for (let lane = 0; lane < 4; lane += 1) {
      const leftTop = width / 2 + (lane - 2) * topWidth / 4;
      const leftBottom = width / 2 + (lane - 2) * bottomWidth / 4;
      paint.beginPath();
      paint.moveTo(leftTop, top);
      paint.lineTo(leftTop + topWidth / 4, top);
      paint.lineTo(leftBottom + bottomWidth / 4, hitY + 10);
      paint.lineTo(leftBottom, hitY + 10);
      paint.closePath();
      paint.fillStyle = lane % 2 === 0 ? '#aac9d205' : '#aac9d20a';
      paint.fill();
      const flare = Math.max(0, 1 - (now - laneFlashes[lane]) / 0.28);
      if (flare > 0) {
        const gradient = paint.createLinearGradient(0, hitY - 120, 0, hitY);
        gradient.addColorStop(0, 'transparent');
        gradient.addColorStop(1, lane < 2 ? `rgba(107,225,238,${flare * 0.24})` : `rgba(246,173,146,${flare * 0.24})`);
        paint.fillStyle = gradient;
        paint.fill();
      }
    }

    for (let line = 0; line <= 4; line += 1) {
      paint.beginPath();
      paint.moveTo(width / 2 + (line - 2) * topWidth / 4, top);
      paint.lineTo(width / 2 + (line - 2) * bottomWidth / 4, hitY + 12);
      paint.strokeStyle = line === 0 || line === 4 ? '#a2c7d528' : '#a2c7d51a';
      paint.lineWidth = 1;
      paint.stroke();
    }

    const movement = isRunning() ? time / (BEAT_SECONDS * 8) : reducedMotion ? 0 : now / 16;
    for (let row = 0; row < 8; row += 1) {
      const progress = ((row / 8 + movement) % 1 + 1) % 1;
      const depth = Math.pow(progress, 1.4);
      const span = topWidth + (bottomWidth - topWidth) * depth;
      const y = top + (hitY - top) * depth;
      paint.beginPath();
      paint.moveTo(width / 2 - span / 2, y);
      paint.lineTo(width / 2 + span / 2, y);
      paint.strokeStyle = `rgba(148,191,207,${0.025 + progress * 0.05})`;
      paint.stroke();
    }

    const lineGradient = paint.createLinearGradient(width / 2 - bottomWidth / 2, 0, width / 2 + bottomWidth / 2, 0);
    lineGradient.addColorStop(0, '#80dfe955');
    lineGradient.addColorStop(0.35, '#a0eef4cc');
    lineGradient.addColorStop(0.7, '#f5b8a6cc');
    lineGradient.addColorStop(1, '#f4aa9355');
    paint.fillStyle = lineGradient;
    paint.shadowBlur = 12;
    paint.shadowColor = '#96e5e6';
    paint.fillRect(width / 2 - bottomWidth / 2, hitY, bottomWidth, 2);
    paint.shadowBlur = 0;

    if (isRunning() || state === 'paused') {
      for (const note of notes) {
        if (note.grade !== null) continue;
        const progress = 1 - (note.time - time) / APPROACH_SECONDS;
        if (progress >= 0 && progress < 1.14) drawNote(note.lane, progress, Math.min(1, progress * 4));
      }
    } else if (state === 'idle' || state === 'loading') {
      ([0.23, 0.54, 0.37, 0.76] as const).forEach((progress, lane) => drawNote(lane as Lane, progress, 0.28));
    }

    sparks = sparks.filter((spark) => now - spark.born < 0.45);
    for (const spark of sparks) {
      const age = now - spark.born;
      paint.globalAlpha = (1 - age / 0.45) * 0.8;
      paint.fillStyle = spark.color;
      paint.fillRect(spark.x + spark.vx * age, spark.y + spark.vy * age + 85 * age * age, 2, 2 + age * 4);
    }
    paint.globalAlpha = 1;
    find<HTMLElement>('[data-game-feedback]').style.opacity = String(Math.max(0, Math.min(1, (0.64 - now + feedbackAt) / 0.16)));
  }

  /** Advance judgements from the audio clock; animation frames never define time. */
  function animate(timestamp: number): void {
    frame = 0;
    if (destroyed) return;
    if (isRunning()) {
      const rawTime = trackTime(timestamp);
      const remaining = playbackOffset - rawTime;
      if (state === 'countdown') {
        find<HTMLElement>('[data-game-countdown]').hidden = remaining > COUNTDOWN_SECONDS;
        text('[data-game-countdown]', String(Math.max(1, Math.min(3, Math.ceil(remaining / 0.8)))));
        text('[data-game-phase]', 'FIND YOUR RHYTHM');
        if (remaining <= 0) setState('playing');
      }
      if (state === 'playing') {
        const now = rawTime - offsetSeconds;
        notes.forEach((note) => {
          if (note.grade === null && note.time < now - missWindow(difficulty)) missNote(note);
        });
        text('[data-game-phase]', sectionAt(rawTime));
        updateProgress(rawTime);
        if (buffer && rawTime >= buffer.duration) finishRound();
      }
    }
    if (isVisible) drawScene(timestamp);
    if (needsAnotherFrame(timestamp)) requestFrame();
  }

  /** Reflect all remaining physical inputs for a lane after one input is released. */
  function updateHeldLane(lane: Lane): void {
    pads[lane].classList.toggle('is-pressed', pressedKeys.has(lane) || Array.from(activePointers.values()).includes(lane));
  }

  listen(playButton, 'click', () => { void playRound(); });
  listen(stopButton, 'click', stopRound);
  modeButtons.forEach((button) => listen(button, 'click', () => {
    difficulty = button.dataset.difficulty as Difficulty;
    modeButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    text('[data-mode-help]', difficulty === 'easy' ? '跟着旋律，慢慢进入状态' : '切分与双押，给指尖一点挑战');
    stopRound();
  }));
  listen(volume, 'input', () => {
    text('[data-volume-output]', `${volume.value}%`);
    if (gain && audio) gain.gain.setTargetAtTime(Number(volume.value) / 100, audio.currentTime, 0.015);
  });
  listen(offset, 'input', () => {
    offsetSeconds = Number(offset.value) / 1000;
    text('[data-offset-output]', `${Number(offset.value) > 0 ? '+' : ''}${offset.value} ms`);
  });
  listen(offsetReset, 'click', () => {
    offset.value = '0';
    offsetSeconds = 0;
    text('[data-offset-output]', '0 ms');
  });

  listen(window, 'keydown', ((event: KeyboardEvent) => {
    if (!isRunning()) return;
    // Browser shortcuts such as Cmd/Ctrl+F and Cmd/Ctrl+D remain available.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); pauseRound('准备好了，就把旋律接下去'); return; }
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const lane = keyLanes[event.code];
    if (lane === undefined || event.repeat || pressedKeys.has(lane)) return;
    event.preventDefault();
    pressedKeys.add(lane);
    updateHeldLane(lane);
    strike(lane, event.timeStamp);
  }) as EventListener);
  listen(window, 'keyup', ((event: KeyboardEvent) => {
    const lane = keyLanes[event.code];
    if (lane === undefined) return;
    pressedKeys.delete(lane);
    updateHeldLane(lane);
  }) as EventListener);

  pads.forEach((pad, laneIndex) => {
    const lane = laneIndex as Lane;
    listen(pad, 'pointerdown', ((event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      pad.setPointerCapture(event.pointerId);
      activePointers.set(event.pointerId, lane);
      updateHeldLane(lane);
      strike(lane, event.timeStamp);
    }) as EventListener);
    const releasePointer = ((event: PointerEvent) => {
      activePointers.delete(event.pointerId);
      updateHeldLane(lane);
    }) as EventListener;
    listen(pad, 'pointerup', releasePointer);
    listen(pad, 'pointercancel', releasePointer);
    listen(pad, 'lostpointercapture', releasePointer);
    listen(pad, 'click', ((event: MouseEvent) => {
      // Keyboard/assistive activation emits detail=0; pointer taps were already judged.
      if (event.detail === 0) strike(lane, event.timeStamp);
    }) as EventListener);
  });
  listen(window, 'blur', () => { pauseRound('你暂时离开了窗口，旋律为你停在这里'); releaseInputs(); });
  listen(document, 'visibilitychange', () => {
    if (document.hidden) {
      pauseRound('页面已切到后台，回到这里再继续');
      cancelFrame();
    } else requestFrame();
  });
  listen(motionPreference, 'change', () => {
    reducedMotion = motionPreference.matches;
    if (reducedMotion) sparks = [];
    requestFrame();
  });
  listen(window, 'pagehide', stopRound);

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    isVisible = entry.isIntersecting;
    if (!isVisible && !isRunning()) cancelFrame();
    else requestFrame();
  });
  visibilityObserver.observe(root);
  resize();
  setState('idle');
  requestFrame();

  return {
    start: (entryDelaySeconds) => { void playRound(entryDelaySeconds, true); },
    stop: stopRound,
    destroy: () => {
      destroyed = true;
      roundToken += 1;
      cancelLoading();
      cancelFrame();
      stopSource();
      releaseInputs();
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      cleanupEvents.forEach((cleanup) => cleanup());
      void audio?.close();
    },
  };
}

/**
 * Start a fresh round from the caller's click handler, unlocking audio synchronously.
 * The entrance delay precedes the complete countdown; it never shortens the countdown.
 */
export function startRhythmGame(root: HTMLElement, entryDelaySeconds = 0): void {
  if (!mountedGames.has(root)) mountedGames.set(root, mountGame(root));
  mountedGames.get(root)!.start(entryDelaySeconds);
}

/** Cancel loading, scheduled audio, playback, and held inputs, leaving an idle game. */
export function stopRhythmGame(root: HTMLElement): void {
  mountedGames.get(root)?.stop();
}

/** Mount newly rendered games once, including after an Astro view transition. */
export function initializeRhythmGames(): void {
  document.querySelectorAll<HTMLElement>('[data-rhythm-game]').forEach((root) => {
    if (!mountedGames.has(root)) mountedGames.set(root, mountGame(root));
  });
}

document.addEventListener('astro:before-swap', () => {
  mountedGames.forEach((controller) => controller.destroy());
  mountedGames.clear();
});
