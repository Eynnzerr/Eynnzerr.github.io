import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BEAT_SECONDS, GRADE_WEIGHTS, createChart, judgeTiming, missWindow,
  normalizedScore, sectionAt, type Difficulty,
} from '../src/lib/rhythm-chart.ts';

describe('timing judgement', () => {
  for (const [difficulty, boundaries] of [
    ['easy', [0.085, 0.145, 0.205]],
    ['challenge', [0.055, 0.1, 0.155]],
  ] as const) {
    it(`${difficulty}: early and late inputs share inclusive grade boundaries`, () => {
      for (const sign of [-1, 1]) {
        assert.equal(judgeTiming(0, difficulty), 'perfect');
        assert.equal(judgeTiming(sign * boundaries[0], difficulty), 'perfect');
        assert.equal(judgeTiming(sign * (boundaries[0] + 0.0001), difficulty), 'great');
        assert.equal(judgeTiming(sign * boundaries[1], difficulty), 'great');
        assert.equal(judgeTiming(sign * (boundaries[1] + 0.0001), difficulty), 'good');
        assert.equal(judgeTiming(sign * boundaries[2], difficulty), 'good');
        assert.equal(judgeTiming(sign * (boundaries[2] + 0.0001), difficulty), null);
      }
      assert.equal(missWindow(difficulty), boundaries[2]);
    });
  }

  it('the same 70 ms timing error is less forgiving in challenge mode', () => {
    assert.equal(judgeTiming(0.07, 'easy'), 'perfect');
    assert.equal(judgeTiming(0.07, 'challenge'), 'great');
    assert.equal(judgeTiming(0.18, 'easy'), 'good');
    assert.equal(judgeTiming(0.18, 'challenge'), null);
  });
});

describe('authored charts', () => {
  for (const difficulty of ['easy', 'challenge'] satisfies Difficulty[]) {
    it(`${difficulty}: remains deterministic, playable, and aligned to the composition`, () => {
      const notes = createChart(difficulty);
      assert.deepEqual(notes, createChart(difficulty));
      assert.ok(notes.length > 0);
      assert.equal(notes[0].time, 0);
      assert.ok(notes.at(-1)!.time < 32, 'All playable notes finish before the reverb tail.');
      assert.equal(new Set(notes.map((note) => note.id)).size, notes.length);
      assert.equal(new Set(notes.map((note) => `${note.time}:${note.lane}`)).size, notes.length);

      notes.forEach((note, index) => {
        assert.ok(note.lane >= 0 && note.lane <= 3 && Number.isInteger(note.lane));
        assert.ok(note.time >= 0);
        assert.ok(index === 0 || note.time >= notes[index - 1].time);
        const sixteenthNote = note.time / (BEAT_SECONDS / 4);
        assert.ok(Math.abs(sixteenthNote - Math.round(sixteenthNote)) < 0.000001);
      });

      for (const time of new Set(notes.map((note) => note.time))) {
        assert.ok(notes.filter((note) => note.time === time).length <= 2, 'No chord requires more than two fingers.');
      }
      for (let lane = 0; lane < 4; lane += 1) {
        const laneNotes = notes.filter((note) => note.lane === lane);
        laneNotes.forEach((note, index) => {
          assert.ok(index === 0 || note.time - laneNotes[index - 1].time >= 0.1199,
            'Repeated attacks in one lane retain a playable gap.');
        });
      }
      assert.ok(notes.some((note) => note.time === 12.8), 'The first drop downbeat remains playable.');
    });
  }

  it('easy uses single taps; challenge adds denser attacks and two-finger chords', () => {
    const easy = createChart('easy');
    const challenge = createChart('challenge');
    assert.equal(new Set(easy.map((note) => note.time)).size, easy.length);
    assert.ok(challenge.length > easy.length);
    assert.ok(new Set(challenge.map((note) => note.time)).size < challenge.length);
    assert.ok(challenge.filter((note) => note.time >= 12.8 && note.time < 25.6).length
      > easy.filter((note) => note.time >= 12.8 && note.time < 25.6).length);
  });
});

describe('score and song structure', () => {
  it('all-perfect and all-miss rounds have stable endpoints for either chart', () => {
    for (const difficulty of ['easy', 'challenge'] satisfies Difficulty[]) {
      const count = createChart(difficulty).length;
      assert.equal(normalizedScore(count, count), 1_000_000);
      assert.equal(normalizedScore(0, count), 0);
      assert.ok(normalizedScore(count - 1, count) < 1_000_000);
    }
  });

  it('misses stay in the denominator and weaker grades reduce the score', () => {
    const weightedHits = GRADE_WEIGHTS.perfect + GRADE_WEIGHTS.great + GRADE_WEIGHTS.good;
    assert.equal(normalizedScore(weightedHits, 4), 537_500);
    assert.equal(normalizedScore(3, 4), 750_000);
    assert.equal(normalizedScore(2, 3), 666_667);
  });

  it('section labels change on the exact audible bar boundaries', () => {
    assert.equal(sectionAt(0), 'INTRO · 旋律浮现');
    assert.equal(sectionAt(6.3999), 'INTRO · 旋律浮现');
    assert.equal(sectionAt(6.4), 'BUILD · 蓄势');
    assert.equal(sectionAt(12.7999), 'BUILD · 蓄势');
    assert.equal(sectionAt(12.8), 'DROP · 跟上这一拍');
    assert.equal(sectionAt(25.5999), 'DROP · 跟上这一拍');
    assert.equal(sectionAt(25.6), 'OUTRO · 余音');
  });
});
