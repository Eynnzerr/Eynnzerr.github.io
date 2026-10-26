import drumAndBass from '../data/rhythm/drum-and-bass.json' with { type: 'json' };
import futureBass from '../data/rhythm/future-bass.json' with { type: 'json' };
import heavenTrap from '../data/rhythm/heaven-trap.json' with { type: 'json' };

/** The four physical lanes, ordered from left to right. */
export type Lane = 0 | 1 | 2 | 3;

/** Each recording offers an approachable chart and a more detailed arrangement. */
export type Difficulty = 'easy' | 'challenge';

/** Stable identities for the four independently composed recordings. */
export type TrackId = 'melodic-bass' | 'drum-and-bass' | 'future-bass' | 'heaven-trap';

/** Public song information shared by the selector, stage, and audio player. */
export interface RhythmTrack {
  /** Stable song identity; changing difficulty preserves this selection. */
  id: TrackId;
  /** Short original composition title. */
  title: string;
  /** Musical style displayed alongside the title. */
  genre: string;
  /** Quarter-note tempo used by the arrangement and beat animation. */
  bpm: number;
  /** Tonal center shown in the stage header. */
  key: string;
  /** Recording length including its release tail, in seconds. */
  duration: number;
  /** Same-origin encoded audio, fetched only when the song is played. */
  audioSrc: string;
  /** Brief description of the song's sound and feel. */
  description: string;
  /** Left-hand and right-hand note colors for this stage. */
  colors: readonly [string, string];
}

/** New visits begin with the original accepted Melodic Bass recording. */
export const DEFAULT_TRACK_ID = 'melodic-bass' as const;

/** Song-local timing exported by the same score that renders each new recording. */
const arrangements = {
  'drum-and-bass': drumAndBass,
  'future-bass': futureBass,
  'heaven-trap': heavenTrap,
};

/** The ordered public collection; its first entry remains the default song. */
export const TRACKS: readonly RhythmTrack[] = [
  {
    id: 'melodic-bass', title: 'Resonance', genre: 'Melodic Bass',
    bpm: 150, key: 'D MINOR', duration: 33.8,
    audioSrc: '/audio/eynnzerr-melodic-bass-v2.mp3',
    description: '从钢琴的余音，到铺展开来的低频与和声。',
    colors: ['#84e7ee', '#f5b29b'],
  },
  {
    id: 'drum-and-bass', title: 'Slipstream', genre: 'Drum & Bass',
    bpm: drumAndBass.bpm, key: drumAndBass.key, duration: drumAndBass.duration,
    audioSrc: '/audio/eynnzerr-drum-and-bass.mp3',
    description: '疾驰的碎拍，流动的旋律。跟着鼓点向前。',
    colors: ['#72e2f1', '#c0ed8b'],
  },
  {
    id: 'future-bass', title: 'Prism', genre: 'Future Bass',
    bpm: futureBass.bpm, key: futureBass.key, duration: futureBass.duration,
    audioSrc: '/audio/eynnzerr-future-bass.mp3',
    description: '明亮和弦一开一合，把切分弹进指尖。',
    colors: ['#b9a4ff', '#ffa6cb'],
  },
  {
    id: 'heaven-trap', title: 'Halcyon', genre: 'Heaven Trap',
    bpm: heavenTrap.bpm, key: heavenTrap.key, duration: heavenTrap.duration,
    audioSrc: '/audio/eynnzerr-heaven-trap.mp3',
    description: '空灵旋律渐渐升起，让半拍鼓点与低音落下。',
    colors: ['#f3d898', '#a5ccff'],
  },
];

/** Resolve the metadata for one known song in the collection. */
export function getTrack(trackId: TrackId): RhythmTrack {
  return TRACKS.find((track) => track.id === trackId)!;
}

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

/** Preserve the original chart's exact melody, drum attacks, and lane assignment. */
function createMelodicBassChart(difficulty: Difficulty): ChartNote[] {
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

/** Create independent playable notes from the selected recording's authored score. */
export function createChart(difficulty: Difficulty, trackId: TrackId = DEFAULT_TRACK_ID): ChartNote[] {
  if (trackId === DEFAULT_TRACK_ID) return createMelodicBassChart(difficulty);
  return arrangements[trackId].charts[difficulty]
    .map((note, id) => ({ id, lane: note.lane as Lane, time: note.time }));
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

/** Describe the selected recording's musical section at its audible timestamp. */
export function sectionAt(seconds: number, trackId: TrackId = DEFAULT_TRACK_ID): string {
  if (trackId !== DEFAULT_TRACK_ID) {
    const sections = arrangements[trackId].sections;
    return sections.findLast((section) => seconds >= section.time)?.label ?? sections[0].label;
  }
  if (seconds < 6.4) return 'INTRO · 旋律浮现';
  if (seconds < 12.8) return 'BUILD · 蓄势';
  if (seconds < 25.6) return 'DROP · 跟上这一拍';
  return 'OUTRO · 余音';
}
