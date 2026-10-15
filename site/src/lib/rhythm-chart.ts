/** The four physical lanes, ordered from left to right. */
export type Lane = 0 | 1 | 2 | 3;

/** The two authored charts share the same original recording. */
export type Difficulty = 'easy' | 'challenge';

/** A single tap, measured from the decoded recording's beginning. */
export interface ChartNote {
  /** Stable identity within one chart. */
  id: number;
  /** Target lane for the tap. */
  lane: Lane;
  /** Audible arrival time in seconds. */
  time: number;
}

/** Successful timing grades, from most to least precise. */
export type HitGrade = 'perfect' | 'great' | 'good';

/** The original composition's quarter-note duration, at 150 BPM. */
export const BEAT_SECONDS = 60 / 150;

/** Lead-in gives a new player time to locate all four lanes. */
export const COUNTDOWN_SECONDS = 2.4;

/** Time a visible note spends descending to the judgement line. */
export const APPROACH_SECONDS = 1.65;

/** Point weights make a completely perfect chart worth exactly one million. */
export const GRADE_WEIGHTS: Record<HitGrade, number> = {
  perfect: 1,
  great: 0.75,
  good: 0.4,
};

/** Timing windows are seconds either side of the audible target. */
const HIT_WINDOWS: Record<Difficulty, readonly [number, number, number]> = {
  easy: [0.085, 0.145, 0.205],
  challenge: [0.055, 0.1, 0.155],
};

/** Beat/lane pairs follow the four-bar piano motif in synthesize_drop_v2.py. */
const MELODY: readonly (readonly (readonly [number, Lane])[])[] = [
  [[0, 1], [1.5, 3], [2.5, 2], [3.25, 1]],
  [[0.25, 1], [1.25, 2], [2, 0]],
  [[0, 0], [1.25, 1], [2, 3], [3, 1]],
  [[0.25, 2], [1.75, 1], [2.5, 0]],
];

/** Build a deterministic chart from the recording's actual melodic/drum attacks. */
export function createChart(difficulty: Difficulty): ChartNote[] {
  const events: Array<Omit<ChartNote, 'id'>> = [];

  /** Keep authored chords to two fingers and avoid same-lane repeated attacks. */
  function add(bar: number, beat: number, lane: Lane): void {
    const time = Number(((bar * 4 + beat) * BEAT_SECONDS).toFixed(4));
    const simultaneous = events.filter((note) => Math.abs(note.time - time) < 0.001);
    if (simultaneous.length >= 2 || simultaneous.some((note) => note.lane === lane)) return;
    if (events.some((note) => note.lane === lane && Math.abs(note.time - time) < 0.12)) return;
    events.push({ time, lane });
  }

  for (let bar = 0; bar < 20; bar += 1) {
    const isDrop = bar >= 8 && bar < 16;
    const motif = MELODY[bar % 4];
    motif.forEach(([beat, lane], index) => {
      // The opening and release leave room to listen; the drop uses the whole motif.
      if (difficulty === 'easy' && !isDrop && (bar < 4 || bar >= 18) && index % 2) return;
      add(bar, beat, bar === 15 && beat === 2.5 ? 3 : lane);
    });

    if (difficulty === 'easy') {
      if (isDrop && !motif.some(([beat]) => beat === 2)) add(bar, 2, bar % 2 ? 3 : 0);
      continue;
    }

    if (isDrop) {
      const kicks = bar % 2 === 0 ? [0, 1.5, 3.25] : [0, 1.25, 3.5];
      kicks.forEach((beat, index) => add(bar, beat, ((bar + index) % 2 === 0 ? 0 : 3)));
      add(bar, 2, 0);
      add(bar, 2, 3);
      // Audible hats supply syncopation, with greater density in the second drop phrase.
      const hatBeats = bar >= 12 ? [0.5, 1, 2.5, 3.5] : [0.5, 3.5];
      hatBeats.forEach((beat, index) => add(bar, beat, ((bar + index + 1) % 4) as Lane));
    } else if (bar >= 4 && bar < 8) {
      [0, 2].forEach((beat, index) => add(bar, beat, (index === 0 ? 0 : 3)));
      if (bar >= 6) [1, 3].forEach((beat, index) => add(bar, beat, (index === 0 ? 1 : 2)));
    } else if (bar < 18 && bar % 2 === 0) {
      add(bar, 0, 3);
    }
  }

  return events.sort((a, b) => a.time - b.time || a.lane - b.lane)
    .map((note, id) => ({ ...note, id }));
}

/** Classify an input's signed timing error; a null result is outside the hit window. */
export function judgeTiming(deltaSeconds: number, difficulty: Difficulty): HitGrade | null {
  const error = Math.abs(deltaSeconds);
  const [perfect, great, good] = HIT_WINDOWS[difficulty];
  return error <= perfect ? 'perfect' : error <= great ? 'great' : error <= good ? 'good' : null;
}

/** A pending note becomes a miss only after its final hit window has elapsed. */
export function missWindow(difficulty: Difficulty): number {
  return HIT_WINDOWS[difficulty][2];
}

/** Normalize score against every note, including misses, without rounding up a grade. */
export function normalizedScore(weightedHits: number, noteCount: number): number {
  return Math.round(weightedHits / noteCount * 1_000_000);
}

/** Describe the current musical section using the composition's exact bar boundaries. */
export function sectionAt(seconds: number): string {
  if (seconds < 6.4) return 'INTRO · 旋律浮现';
  if (seconds < 12.8) return 'BUILD · 蓄势';
  if (seconds < 25.6) return 'DROP · 跟上这一拍';
  return 'OUTRO · 余音';
}
