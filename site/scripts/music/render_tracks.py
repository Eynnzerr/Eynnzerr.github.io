#!/usr/bin/env python3
"""Render three original recordings and their charts from the same event lists.

Requires NumPy, ffmpeg, and the six CC0 one-shots listed in README.md.
The renderer uses no network service. Intermediate WAVs and measurements go
to --work-dir; only MP3 recordings and chart JSON are placed in the site.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from functools import lru_cache
import json
from pathlib import Path
import re
import subprocess

import numpy as np

SR = 44100  # Shared rendering and decoded-audio inspection sample rate.
RNG = np.random.default_rng(20261020)  # Reset to a stable seed for each recording.


def timeline(seconds):
    """Return sample times for a finite sound."""
    return np.arange(round(seconds * SR)) / SR


def hz(note):
    """Convert a MIDI note to its equal-tempered frequency."""
    return 440 * 2 ** ((note - 69) / 12)


def stereo(signal, pan=0):
    """Place a mono sound with equal-power panning."""
    angle = (pan + 1) * np.pi / 4
    return np.column_stack((signal * np.cos(angle), signal * np.sin(angle)))


def filtered(signal, low=0, high=16000):
    """Apply smooth spectral band limits without a playback-time offset."""
    n = 1 << (len(signal) - 1).bit_length()
    frequencies = np.fft.rfftfreq(n, 1 / SR)
    response = 1 / np.sqrt(1 + (frequencies / high) ** 8)
    if low:
        response *= frequencies ** 4 / (frequencies ** 4 + low ** 4)
    spectrum = np.fft.rfft(signal, n=n, axis=0)
    if signal.ndim == 2:
        response = response[:, None]
    return np.fft.irfft(spectrum * response, n=n, axis=0)[:len(signal)]


def level(signal, rms):
    """Set a texture's RMS before its expressive envelope."""
    return signal * rms / max(1e-9, np.sqrt(np.mean(signal ** 2)))


def envelope(t, held, attack=.008, release=.15, sustain=.8):
    """Create a finite, click-free note envelope with a mild attack decay."""
    return (np.minimum(t / attack, 1) ** .8
            * (sustain + (1 - sustain) * np.exp(-t / .18))
            * np.clip(1 - np.maximum(t - held, 0) / release, 0, 1) ** 2)


def saw(t, frequency, phase=0):
    """Generate a polyBLEP saw with reduced discontinuity aliasing."""
    cycle = (t * frequency + phase) % 1
    step = frequency / SR
    correction = np.zeros(len(t))
    first = cycle < step
    x = cycle[first] / step
    correction[first] = x + x - x * x - 1
    last = cycle > 1 - step
    x = (cycle[last] - 1) / step
    correction[last] = x * x + x + x + 1
    return 2 * cycle - 1 - correction


@dataclass(frozen=True)
class Event:
    """One audible attack and its optional authored chart role.

    Attributes:
        beat: Onset in quarter notes from the recording's beginning.
        voice: Instrument name dispatched by Instruments.voice.
        notes: MIDI pitches; an 808 may use separate start/end pitches.
        held: Dry note duration in seconds before its release.
        gain: Linear event level before bus mixing.
        pan: Stereo balance from -1 (left) to 1 (right).
        lane: Authored physical input lane, numbered 0 through 3.
        easy: Whether the attack is eligible for the relaxed chart.
        challenge: Whether it is eligible for the challenge chart.
        priority: Lower numbers win simultaneous-note limits.
    """

    beat: float
    voice: str
    notes: tuple[int, ...] = ()
    held: float = .4
    gain: float = 1
    pan: float = 0
    lane: int = 0
    easy: bool = False
    challenge: bool = False
    priority: int = 5


@dataclass(frozen=True)
class Track:
    """Composition metadata plus the shared audio/chart event sequence.

    Attributes:
        slug: Stable asset and chart filename stem.
        title: Display title embedded in the MP3 metadata.
        bpm: Quarter-note tempo throughout the recording.
        bars: Number of four-beat measures before the effect tail.
        key: Human-readable musical key.
        tail: Extra seconds reserved for reverb decay.
        sections: Ordered (bar index, label) section boundaries.
        events: The common source of rendered attacks and playable notes.
    """

    slug: str
    title: str
    bpm: int
    bars: int
    key: str
    tail: float
    sections: tuple[tuple[int, str], ...]
    events: tuple[Event, ...]


class Instruments:
    """Sampled piano/percussion and original synthesized instrument voices."""

    def __init__(self, samples):
        """Load and trim one-shots once, retaining their acoustic transients."""
        self.pianos = {n: self.load(samples / f"piano-{n}.wav") for n in (49, 61, 73, 85)}
        self.snare = self.load(samples / "acoustic-snare.wav")
        self.crash = self.load(samples / "crash.wav")[:round(2.8 * SR)]

    @staticmethod
    def load(path):
        """Decode a local sample and trim only its leading recording silence."""
        data = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path),
                                        "-f", "f32le", "-ar", str(SR), "-ac", "2", "-"])
        audio = np.frombuffer(data, "<f4").reshape(-1, 2).astype(float)
        peak = np.max(np.abs(audio))
        active = np.flatnonzero(np.max(np.abs(audio), axis=1) > peak * .0015)
        start = max(0, int(active[0]) - 44) if len(active) else 0
        return audio[start:] / peak

    @lru_cache(maxsize=192)
    def piano(self, note, held):
        """Resample the closest acoustic piano note with a pedal-like release."""
        root = min(self.pianos, key=lambda n: abs(n - note))
        source = self.pianos[root]
        t = timeline(held + .8)
        positions = np.arange(len(t)) * 2 ** ((note - root) / 12)
        sound = np.column_stack([np.interp(positions, np.arange(len(source)),
                                           source[:, c], right=0) for c in (0, 1)])
        return filtered(sound, 105, 10500) * (
            np.minimum(t / .001, 1)
            * np.clip(1 - np.maximum(t - held, 0) / .8, 0, 1) ** 1.7)[:, None]

    @lru_cache(maxsize=192)
    def voice(self, name, notes, held):
        """Synthesize or retrieve a deterministic sound for one event."""
        if name == "piano":
            result = sum(self.piano(n, held) for n in notes)
            return result / max(1, len(notes) ** .45)
        if name in ("kick", "snare", "rim", "hat", "openhat", "crash"):
            return self.percussion(name)
        if name in ("pad", "strings", "future", "choir"):
            return self.chord(name, notes, held)
        if name in ("reese", "808", "bass"):
            return self.low_end(name, notes, held)
        t = timeline(held + .38)
        frequency = hz(notes[0])
        if name == "bell":
            # Near-harmonic FM adds a glass attack without a narrow, piercing sine lead.
            sound = np.sin(2 * np.pi * frequency * t
                           + 1.6 * np.exp(-t / .13) * np.sin(2 * np.pi * frequency * 2 * t))
            sound += .19 * np.sin(2 * np.pi * frequency * 3 * t) * np.exp(-t / .08)
            sound = stereo(sound) * np.exp(-t / .48)[:, None]
            return sound * envelope(t, held, .003, .38)[:, None] * .22
        if name == "electric":
            sound = np.sin(2 * np.pi * frequency * t
                           + .9 * np.exp(-t / .2) * np.sin(2 * np.pi * frequency * t))
            sound += .12 * np.sin(2 * np.pi * frequency * 3 * t)
            return stereo(sound) * (np.exp(-t / 1.15) * envelope(t, held, .004, .38))[:, None] * .25
        # A restrained five-voice ensemble leaves the sampled piano attack audible.
        sound = sum(stereo(saw(t, frequency * 2 ** (c / 1200), RNG.random()), c / 20)
                    for c in (-10, -4, 0, 4, 10))
        sound = level(filtered(sound, 480, 5200), .095)
        sound += stereo(np.sin(2 * np.pi * frequency * t)) * .045
        return sound * envelope(t, held, .018, .38, .86)[:, None]

    @lru_cache(maxsize=8)
    def percussion(self, name):
        """Layer acoustic transients with original drum bodies and restrained highs."""
        if name == "crash":
            return filtered(self.crash, 900, 11800) * .42
        if name == "kick":
            t = timeline(.36)
            pitch = 48 + 135 * np.exp(-t / .018)
            body = np.sin(2 * np.pi * np.cumsum(pitch) / SR) * np.exp(-t / .072)
            click = filtered(RNG.normal(size=len(t)), 2500, 9000) * np.exp(-t / .005)
            return stereo(np.tanh(body * 1.5 + click * .12)
                          * np.minimum(t / .0005, 1)) * .72
        if name in ("snare", "rim"):
            t = timeline(.44 if name == "snare" else .22)
            body = np.sin(2 * np.pi * np.cumsum(182 + 40 * np.exp(-t / .01)) / SR)
            body *= np.exp(-t / .065)
            noise = filtered(RNG.normal(size=len(t)), 1550, 10200) * np.exp(-t / .065)
            sound = stereo(body * .27 + noise * .19)
            count = min(len(sound), len(self.snare))
            sound[:count] += self.snare[:count] * (.57 if name == "snare" else .35)
            return sound * np.minimum(t / .0005, 1)[:, None]
        opened = name == "openhat"
        t = timeline(.25 if opened else .075)
        noise = filtered(RNG.normal(size=len(t)), 6300, 13600)
        metallic = sum(np.sin(2 * np.pi * f * t) for f in (6230, 8170, 10210)) * .045
        return stereo((noise + metallic) * np.exp(-t / (.085 if opened else .018))
                      * np.minimum(t / .0006, 1)) * .34

    @lru_cache(maxsize=80)
    def chord(self, name, notes, held):
        """Separate sustained body, stereo presence, and acoustic-like upper texture."""
        release = .45 if name == "future" else .85
        t = timeline(held + release)
        sound = np.zeros((len(t), 2))
        if name in ("strings", "choir"):
            for n in notes:
                frequency = hz(n)
                for channel, detune in ((0, .9988), (1, 1.0012)):
                    phase = RNG.uniform(0, 2 * np.pi)
                    for harmonic in range(1, 13):
                        partial = frequency * detune * harmonic
                        shape = (.2 + np.exp(-((partial - 680) / 430) ** 2)
                                 + .6 * np.exp(-((partial - 2200) / 800) ** 2))
                        vibrato = .012 * harmonic * np.sin(2 * np.pi * 4.8 * t + phase)
                        sound[:, channel] += np.sin(2 * np.pi * partial * t + phase + vibrato) * shape / harmonic ** 1.2
            sound = level(filtered(sound, 220, 6500), .068 if name == "strings" else .085)
            return sound * envelope(t, held, .11, release, .95)[:, None]
        for n in notes:
            for cents, pan in ((-15, -.9), (-6, -.35), (0, 0), (6, .35), (15, .9)):
                sound += stereo(saw(t, hz(n) * 2 ** (cents / 1200), RNG.random()), pan)
        low = level(filtered(sound, 170, 1750), .12 if name == "future" else .065)
        high = level(filtered(sound, 1250, 7900), .068 if name == "future" else .022)
        # The Future Bass filter blooms after the transient instead of remaining static.
        bloom = .2 + .8 * (1 - np.exp(-t / .055)) * np.exp(-t / .44)
        result = low + high * bloom[:, None]
        return result * envelope(t, held, .012 if name == "future" else .09, release, .88)[:, None]

    @lru_cache(maxsize=128)
    def low_end(self, name, notes, held):
        """Keep sub energy mono while adding Reese movement or an authored 808 glide."""
        t = timeline(held + .1)
        start = hz(notes[0])
        if name == "808":
            finish = hz(notes[-1])
            glide_start = held * .62
            glide = np.clip((t - glide_start) / max(.04, held * .25), 0, 1)
            frequency = start * (finish / start) ** (glide * glide * (3 - 2 * glide))
            frequency *= 1 + .2 * np.exp(-t / .018)
            phase = 2 * np.pi * np.cumsum(frequency) / SR
            sub = np.sin(phase) + .15 * np.sin(2 * phase)
            body = np.tanh(sub * 1.8) / 1.8
            return stereo(body) * (np.exp(-t / max(.45, held * 2.5))
                                   * envelope(t, held, .003, .1, .9))[:, None] * .39
        sub = stereo(np.sin(2 * np.pi * start * t)) * .27
        if name == "reese":
            mid = np.column_stack((
                saw(t, start * 1.992, .13) + saw(t, start * 2.008, .47),
                saw(t, start * 2.004, .31) + saw(t, start * 1.996, .68)))
            mid = level(filtered(np.tanh(mid * 1.4), 140, 1400), .07)
            movement = .7 + .3 * np.sin(2 * np.pi * 1.35 * t) ** 2
            sub += mid * movement[:, None]
        return sub * envelope(t, held, .005, .1, .95)[:, None]


def compose(slug):
    """Author each track's complete arrangement, including playable attack roles."""
    events = []

    def add(bar, beat, voice, notes=(), held=.4, gain=1, lane=0,
            easy=False, challenge=False, priority=5, pan=0):
        """Store one event in quarter-note coordinates shared by audio and charts."""
        events.append(Event(bar * 4 + beat, voice, tuple(notes), held, gain, pan,
                            lane, easy, challenge, priority))

    if slug == "drum-and-bass":
        bpm, bars, key, tail, title = 174, 32, "F MINOR", 1.7, "Slipstream"
        sections = ((0, "INTRO · 雾中微光"), (4, "FLOW · 碎拍启程"),
                    (16, "BREAK · 呼吸"), (20, "LIFT · 顺风疾驰"), (30, "OUTRO · 远去"))
        harmony = (((61, 65, 68, 72, 75), 37), ((60, 63, 68, 72, 75), 32),
                   ((58, 63, 67, 70, 77), 39), ((60, 65, 68, 72, 75), 41))
        themes = (((.0, 77, .7), (1.25, 75, .45), (2, 72, .7), (3.5, 68, .4)),
                  ((.0, 72, .8), (1.5, 75, .5), (2.5, 79, .7), (3.5, 75, .4)),
                  ((.0, 77, .7), (1, 79, .5), (2.5, 82, .65), (3.5, 79, .4)),
                  ((.0, 80, .8), (1.5, 77, .7), (2.75, 75, .6), (3.5, 72, .4)))
    elif slug == "future-bass":
        bpm, bars, key, tail, title = 144, 28, "E MAJOR", 1.8, "Prism"
        sections = ((0, "INTRO · 折光"), (4, "DROP · 色彩跃动"),
                    (12, "BREAK · 悬浮"), (16, "LIFT · 棱镜展开"), (26, "OUTRO · 余辉"))
        harmony = (((61, 64, 68, 71, 75), 37), ((57, 61, 64, 68, 71), 33),
                   ((59, 64, 68, 71, 78), 40), ((59, 63, 66, 68, 73), 35))
        themes = (((0, 80, .8), (1.5, 78, .4), (2.5, 76, .7), (3.5, 75, .4)),
                  ((.0, 76, .9), (1.25, 73, .5), (2.5, 76, .5), (3.25, 80, .6)),
                  ((.0, 83, .9), (1.5, 80, .4), (2.25, 78, .6), (3.25, 76, .6)),
                  ((.0, 78, .8), (1.25, 75, .55), (2.5, 73, .5), (3.5, 75, .4)))
    else:
        bpm, bars, key, tail, title = 150, 28, "D MAJOR", 2.0, "Halcyon"
        sections = ((0, "INTRO · 云端"), (4, "RISE · 微光聚拢"),
                    (8, "DROP · 天光"), (16, "BREAK · 回望"),
                    (20, "LIFT · 再次升起"), (26, "OUTRO · 安宁"))
        harmony = (((59, 62, 66, 69, 73), 35), ((55, 59, 62, 66, 69), 31),
                   ((57, 62, 66, 69, 76), 38), ((57, 61, 64, 69, 71), 33))
        themes = (((0, 78, 1.15), (1.5, 74, .65), (2.5, 73, .55), (3.5, 74, .4)),
                  ((0, 74, 1.1), (1.5, 71, .5), (2.5, 69, .6), (3.5, 71, .4)),
                  ((0, 78, 1.1), (1.5, 81, .6), (2.5, 78, .55), (3.5, 76, .4)),
                  ((0, 76, 1), (1.5, 73, .55), (2.5, 71, .6), (3.5, 69, .4)))
    beat_seconds = 60 / bpm
    for bar in range(bars):
        notes, root = harmony[(bar // 2 if slug == "drum-and-bass" else bar) % 4]
        if slug == "drum-and-bass":
            main = 4 <= bar < 16 or 20 <= bar < 30
            rise = bar in (3, 18, 19)
        elif slug == "future-bass":
            main = 4 <= bar < 12 or 16 <= bar < 26
            rise = bar in (3, 14, 15)
        else:
            main = 8 <= bar < 16 or 20 <= bar < 26
            rise = 4 <= bar < 8 or bar == 19
        ending = bar >= bars - 2
        # Long harmonic layers remain underneath rhythmic attacks, preserving fullness.
        chord_voice = "choir" if slug == "heaven-trap" else "strings"
        add(bar, 0, chord_voice, notes, 3.9 * beat_seconds, .78 if main else .46)
        add(bar, 0, "pad", notes, 3.9 * beat_seconds, .57 if main else .38)
        for index, note in enumerate(notes[:4]):
            add(bar, index * .035, "piano", (note,), 1.1, .2 if main else .3, pan=(index - 1.5) * .13)
        add(bar, 0, "piano", (root + 12,), 1.3, .18)

        for index, (beat, note, length) in enumerate(themes[bar % 4]):
            lane = (1, 3, 2, 0)[index] if bar % 2 == 0 else (2, 0, 1, 3)[index]
            voice = "electric" if slug == "drum-and-bass" else "bell" if slug == "heaven-trap" else "lead"
            if ending and index == 3:
                continue
            add(bar, beat, "piano", (note - (12 if not main else 0),),
                length * beat_seconds + .08, .35 if main else .5,
                lane, True, True, 1)
            add(bar, beat, voice, (note,), length * beat_seconds,
                .78 if main else .35, pan=(-.12 if index % 2 else .12))
            if main and slug == "heaven-trap":
                add(bar, beat + .02, "bell", (note + 12,), .2, .17, pan=.28)
        if slug == "drum-and-bass":
            if main:
                for beat, length, pitch in ((0, 1.3, root), (1.75, .55, root),
                                             (2.5, .9, root + (7 if bar % 4 == 3 else 0))):
                    add(bar, beat, "reese", (pitch,), length * beat_seconds, .95)
                kicks = (0, 2.5) if bar % 2 == 0 else (0, 1.75, 2.5)
                for beat in kicks:
                    add(bar, beat, "kick", gain=.88, lane=0, challenge=True, priority=2)
                for beat in (1, 3):
                    add(bar, beat, "snare", gain=.91, lane=3, easy=True, challenge=True, priority=0)
                for beat in (.75, 2.75):
                    add(bar, beat, "rim", gain=.14, lane=1, challenge=bar % 2 == 1, priority=4, pan=-.12)
                for step in range(8):
                    beat = step / 2
                    add(bar, beat, "openhat" if step in (3, 7) else "hat",
                        gain=.38 if step % 2 else .26, lane=1 if step < 4 else 2,
                        challenge=step in (1, 5), priority=4, pan=.3 if step % 2 else -.25)
                if bar % 4 == 3:
                    for step in range(3):
                        add(bar, 3.25 + step * .25, "rim", gain=.15 + step * .05,
                            lane=(1, 2, 0)[step], challenge=True, priority=3)
            else:
                for beat in (1, 3):
                    add(bar, beat, "rim", gain=.22 if rise else .12,
                        lane=3, easy=True, challenge=True, priority=2)
                if bar > 1:
                    add(bar, 0, "bass", (root,), 3.5 * beat_seconds, .35)
        elif slug == "future-bass":
            if main:
                rhythm = ((0, .62), (.75, .35), (1.5, .7), (2.75, .45), (3.5, .35))
                if bar % 2:
                    rhythm = ((0, .9), (1.25, .35), (2, .55), (2.75, .35), (3.5, .35))
                for index, (beat, length) in enumerate(rhythm):
                    add(bar, beat, "future", notes, length * beat_seconds, 1.15,
                        lane=(0, 2, 1, 3, 0)[index], challenge=True, priority=2)
                    add(bar, beat, "bass", (root,), length * beat_seconds, .9)
                for beat in ((0, 1.5, 3.5) if bar % 2 == 0 else (0, 2.75)):
                    add(bar, beat, "kick", gain=1, lane=0, challenge=True, priority=2)
                add(bar, 2, "snare", gain=1.1, lane=3, easy=True, challenge=True, priority=0)
                add(bar, 2.018, "rim", gain=.25)
                for step in range(8):
                    add(bar, step / 2, "openhat" if step == 5 else "hat",
                        gain=.24 if step % 2 else .17, pan=(-.4 if step % 2 else .3),
                        lane=1 if step < 4 else 2, challenge=step in (1, 5), priority=4)
                if bar % 4 == 3:
                    for index, beat in enumerate((3.25, 3.5, 3.75)):
                        add(bar, beat, "bell", (notes[(index + 2) % len(notes)] + 12,),
                            .14, .7, lane=(1, 2, 3)[index], challenge=True, priority=3)
            else:
                for beat in (1, 2, 3):
                    add(bar, beat, "rim", gain=.16 if rise else .08,
                        lane=3 if beat == 2 else 0, easy=beat == 2,
                        challenge=True, priority=3)
        else:
            if main:
                # Trap bass is an independent sustained phrase, not a copy of every kick.
                glide = root + 7 if bar % 4 == 3 else root + 12 if bar % 4 == 1 else root
                add(bar, 0, "808", (root, root), 1.45 * beat_seconds, 1)
                add(bar, 1.75, "808", (root, glide), 1.95 * beat_seconds, .95)
                for beat in ((0, 1.75, 3.25) if bar % 2 == 0 else (0, 2.75, 3.5)):
                    add(bar, beat, "kick", gain=.9, lane=0, challenge=True, priority=2)
                add(bar, 2, "snare", gain=.93, lane=3, easy=True, challenge=True, priority=0)
                add(bar, 2.014, "rim", gain=.24)
                for step in range(8):
                    add(bar, step / 2, "hat", gain=.24 if step % 2 else .16,
                        lane=(1 if step % 2 else 2), challenge=step in (1, 5), priority=4,
                        pan=(-.26 if step % 2 else .3))
                if bar % 2:
                    for index in range(6):
                        # Only three attacks in this audible roll become playable notes.
                        add(bar, 3 + index / 6, "hat", gain=.18 + index * .018,
                            lane=(0, 1, 2)[index // 2], challenge=index % 2 == 1,
                            priority=3, pan=-.35 + index * .14)
                if bar % 4 == 3:
                    add(bar, 3.5, "openhat", gain=.28, pan=.25)
            else:
                for beat in (1, 2, 3):
                    add(bar, beat, "rim", gain=.16 if rise else .065,
                        lane=3 if beat == 2 else 0, easy=beat == 2,
                        challenge=True, priority=3)
                add(bar, 0, "bass", (root,), 3.6 * beat_seconds, .19)
        if rise:
            for index, beat in enumerate((.5, 1.5, 2.5, 3, 3.5)):
                add(bar, beat, "rim", gain=.08 + index * .025, lane=index % 4,
                    challenge=True, priority=4)
        if bar in {s[0] for s in sections}:
            add(bar, 0, "crash", gain=.45 if main else .18)
        if main and bar % 4 == 0:
            # A second octave extends only the lifted phrase, keeping the opening lighter.
            add(bar, 0, "strings", tuple(n + 12 for n in notes[:3]),
                3.8 * beat_seconds, .32 if bar >= 16 else .18)
    return Track(slug, title, bpm, bars, key, tail, sections, tuple(events))


def chart_for(track, difficulty):
    """Select authored attacks without moving their audio timestamps or randomizing lanes."""
    result = []
    beat = 60 / track.bpm
    candidates = [e for e in track.events if getattr(e, difficulty)]
    # Priority resolves melodic/drum collisions before chronological lane spacing.
    candidates.sort(key=lambda e: (round(e.beat * beat * SR), e.priority, e.lane))
    last_lane = [-100.0] * 4
    for event in candidates:
        time = round(round(event.beat * beat * SR) / SR, 6)
        simultaneous = [n for n in result[-2:] if abs(n["time"] - time) < .001]
        if len(simultaneous) >= (1 if difficulty == "easy" else 2):
            continue
        if time - last_lane[event.lane] < .12:
            continue
        if difficulty == "easy" and result and time - result[-1]["time"] < .18:
            continue
        result.append({"time": time, "lane": event.lane})
        last_lane[event.lane] = time
    return result


def place(bus, sound, at, gain=1, pan=0):
    """Mix one sound at an exact sample boundary, preserving a shared chart onset."""
    start = round(at * SR)
    count = min(len(sound), len(bus) - start)
    if count <= 0:
        return
    # Stereo balance adjusts a sampled image without cross-channel phase tricks.
    balance = np.array([min(1, 1 - pan), min(1, 1 + pan)])
    bus[start:start + count] += sound[:count] * gain * balance


def hall(signal, decay=.65):
    """Create decorrelated filtered reflections with no dry-signal time shift."""
    t = timeline(2.8)
    impulse = np.zeros((len(t), 2))
    for channel in (0, 1):
        noise = filtered(RNG.normal(size=len(t)), 500, 5800)
        noise *= np.exp(-t / decay) * np.minimum(t / .09, 1)
        noise[:round(.03 * SR)] = 0
        impulse[:, channel] = noise / np.sqrt(np.sum(noise ** 2)) * .4
        for delay, gain in ((.043, .14), (.079, .08), (.131, .055)):
            impulse[round((delay + channel * .008) * SR), channel] += gain
    size = 1 << (len(signal) + len(impulse) - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(signal, n=size, axis=0)
                        * np.fft.rfft(impulse, n=size, axis=0), n=size, axis=0)[:len(signal)]


def master(signal):
    """Use stereo-linked peak control while retaining section-to-section dynamics."""
    signal = filtered(signal, 27, 16600)
    signal *= .23 / max(1e-9, np.sqrt(np.mean(signal ** 2)))
    block = 128
    padded = np.pad(signal, ((0, (-len(signal)) % block), (0, 0)))
    peaks = np.max(np.abs(padded.reshape(-1, block, 2)), axis=(1, 2))
    ahead = np.maximum.reduce((peaks, np.r_[peaks[1:], peaks[-1]],
                               np.r_[peaks[2:], peaks[-1], peaks[-1]]))
    targets = np.minimum(1, .82 / np.maximum(ahead, 1e-9))
    gains = np.ones(len(targets))
    release = np.exp(-block / (SR * .07))
    for index in range(1, len(gains)):
        gains[index] = min(targets[index], release * gains[index - 1] + (1 - release) * targets[index])
    signal *= np.interp(np.arange(len(signal)), np.arange(len(gains)) * block, gains)[:, None]
    signal *= min(1, .86 / np.max(np.abs(signal)))
    signal[:round(.008 * SR)] *= np.linspace(0, 1, round(.008 * SR))[:, None]
    signal[-round(1.25 * SR):] *= np.linspace(1, 0, round(1.25 * SR))[:, None] ** 1.4
    return signal


def write_wav(path, signal):
    """Write 24-bit-friendly floating audio through ffmpeg without changing its duration."""
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR),
                    "-ac", "2", "-i", "-", "-c:a", "pcm_s24le", str(path)],
                   input=signal.astype("<f4").tobytes(), check=True)


def measure(path, reference_wav):
    """Read integrated loudness, true peak, decoded duration, and silence intervals."""
    scan = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path),
                           "-af", "ebur128=peak=true,silencedetect=noise=-50dB:d=0.15",
                           "-f", "null", "-"], capture_output=True, text=True, check=True)
    summary = scan.stderr.rsplit("Summary:", 1)[-1]
    pcm = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path),
                                   "-f", "f32le", "-ar", str(SR), "-ac", "2", "-"])
    decoded = np.frombuffer(pcm, "<f4").reshape(-1, 2)
    reference_data = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(reference_wav), "-t", "3",
        "-f", "f32le", "-ar", str(SR), "-ac", "2", "-"])
    reference = np.frombuffer(reference_data, "<f4").reshape(-1, 2).mean(axis=1)
    observed = decoded[:len(reference)].mean(axis=1)
    fft_size = 1 << (len(reference) * 2 - 1).bit_length()
    correlation = np.fft.irfft(np.fft.rfft(observed, n=fft_size)
                               * np.conj(np.fft.rfft(reference, n=fft_size)), n=fft_size)
    # MP3 encoder delay would appear as a displaced correlation maximum.
    candidate_lags = np.arange(-2048, 2049)
    lag = int(candidate_lags[np.argmax(correlation[candidate_lags % fft_size])])
    return {
        "integrated_lufs": float(re.search(r"I:\s+([-\d.]+) LUFS", summary)[1]),
        "true_peak_dbfs": float(re.search(r"Peak:\s+([-\d.]+) dBFS", summary)[1]),
        "loudness_range_lu": float(re.search(r"LRA:\s+([-\d.]+) LU", summary)[1]),
        "decoded_frames": len(pcm) // 8,
        "decoded_duration": len(pcm) / 8 / SR,
        "encoded_onset_shift_samples": lag,
        "silence_log": re.findall(r"silence_(?:start|end):[^\n]+", scan.stderr),
    }


def section_dynamics(track, count):
    """Preserve phrase-level contrast without changing any event's musical onset."""
    beat = 60 / track.bpm
    curve = np.ones(count)
    levels = {"INTRO": .42, "RISE": .62, "BREAK": .45, "OUTRO": .42,
              "FLOW": .97, "DROP": .97, "LIFT": 1.06}
    previous = .42
    for index, (bar, label) in enumerate(track.sections):
        start = round(bar * 4 * beat * SR)
        end = (round(track.sections[index + 1][0] * 4 * beat * SR)
               if index + 1 < len(track.sections) else count)
        current = levels[label.split(" · ")[0]]
        curve[start:end] = current
        if start:
            # Finish the transition at the downbeat so the kick keeps its full transient.
            ramp = min(round(.025 * SR), start)
            curve[start - ramp:start] = np.linspace(previous, current, ramp)
        previous = current
    return curve


def render(track, instruments, site, work):
    """Render the authored event sequence, then export its matching playable charts."""
    global RNG
    RNG = np.random.default_rng(20261020 + ("drum-and-bass", "future-bass", "heaven-trap").index(track.slug))
    instruments.percussion.cache_clear()
    beat = 60 / track.bpm
    count = round((track.bars * 4 * beat + track.tail) * SR)
    buses = {name: np.zeros((count, 2), dtype=np.float32)
             for name in ("drums", "harmonic", "melody", "bass", "effects")}
    for index, event in enumerate(track.events):
        if index % 120 == 0:
            print(f"{track.title}: rendering event {index}/{len(track.events)}", flush=True)
        if event.voice in ("kick", "snare", "rim", "hat", "openhat"):
            bus = "drums"
        elif event.voice in ("bass", "808", "reese"):
            bus = "bass"
        elif event.voice in ("pad", "choir", "strings", "future"):
            bus = "harmonic"
        elif event.voice == "crash":
            bus = "effects"
        else:
            bus = "melody"
        sound = instruments.voice(event.voice, event.notes, round(event.held, 5))
        place(buses[bus], sound, event.beat * beat, event.gain, event.pan)
    print(f"{track.title}: mixing space, sidechain, and transitions", flush=True)
    duck = np.ones(count)
    for event in track.events:
        if event.voice != "kick":
            continue
        at = round(event.beat * beat * SR)
        t = timeline(.27)
        depth = .72 if track.slug == "future-bass" else .52
        shape = 1 - depth * np.exp(-t / (.085 if track.slug == "future-bass" else .045))
        end = min(at + len(shape), count)
        duck[at:end] = np.minimum(duck[at:end], shape[:end - at])
    wet = hall(buses["melody"] * .47 + buses["harmonic"] * .42,
               .8 if track.slug == "heaven-trap" else .55)
    musical = buses["harmonic"] + wet * (.65 if track.slug == "heaven-trap" else .42)
    buses["bass"] *= duck[:, None]
    musical *= (1 - (1 - duck) * (.45 if track.slug == "heaven-trap" else 1))[:, None]
    echoes = np.zeros_like(buses["melody"])
    for repeat in (1, 2, 3):
        shift = round(beat * .75 * repeat * SR)
        echoes[shift:] += buses["melody"][:-shift, ::-1] * .22 ** repeat
    # Reverse cymbal rises are free of an added timing offset at the following downbeat.
    for bar, label in track.sections:
        if "DROP" in label or "LIFT" in label or "FLOW" in label:
            duration = min(1.1, bar * 4 * beat)
            reverse = instruments.crash[:round(duration * SR)][::-1].copy()
            reverse *= np.linspace(0, 1, len(reverse))[:, None] ** 2
            place(buses["effects"], reverse, bar * 4 * beat - duration, .13)
    mix = master((buses["drums"] + musical + buses["melody"] + echoes
                  + buses["bass"] + buses["effects"]) * section_dynamics(track, count)[:, None])
    wav = work / f"{track.slug}.wav"
    destination = site / "public/audio" / f"eynnzerr-{track.slug}.mp3"
    destination.parent.mkdir(parents=True, exist_ok=True)
    write_wav(wav, mix)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav),
                    "-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", "1",
                    "-metadata", f"title={track.title}", "-metadata", "artist=Eynnzerr",
                    "-metadata", f"genre={track.slug}", str(destination)], check=True)
    measurement = measure(destination, wav)
    data = {"bpm": track.bpm, "duration": count / SR, "key": track.key,
            "sections": [{"time": round(round(bar * 4 * beat * SR) / SR, 6), "label": label}
                         for bar, label in track.sections],
            "charts": {mode: chart_for(track, mode) for mode in ("easy", "challenge")}}
    chart_path = site / "src/data/rhythm" / f"{track.slug}.json"
    chart_path.parent.mkdir(parents=True, exist_ok=True)
    chart_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    stats = {}
    for difficulty, chart in data["charts"].items():
        simultaneous = {}
        gaps = []
        prior = {}
        for note in chart:
            simultaneous[note["time"]] = simultaneous.get(note["time"], 0) + 1
            if note["lane"] in prior:
                gaps.append(note["time"] - prior[note["lane"]])
            prior[note["lane"]] = note["time"]
        stats[difficulty] = {"notes": len(chart), "notes_per_second": len(chart) / data["duration"],
                             "max_simultaneous": max(simultaneous.values()),
                             "minimum_same_lane_gap": min(gaps)}
    section_levels = []
    for index, (bar, label) in enumerate(track.sections):
        start = round(bar * 4 * beat * SR)
        end = (round(track.sections[index + 1][0] * 4 * beat * SR)
               if index + 1 < len(track.sections) else round(track.bars * 4 * beat * SR))
        section_levels.append({"label": label, "rms_dbfs": round(
            float(20 * np.log10(np.sqrt(np.mean(mix[start:end] ** 2)))), 2)})
    result = {"track": track.slug, "title": track.title, "bpm": track.bpm,
              "duration": data["duration"], "sections": data["sections"],
              "charts": stats, "audio": measurement,
              "section_rms_dbfs": section_levels,
              "pcm_duration_matches_json": measurement["decoded_frames"] == count,
              "source_events": len(track.events)}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    instruments.voice.cache_clear()
    instruments.chord.cache_clear()
    instruments.low_end.cache_clear()
    instruments.piano.cache_clear()
    return result


def main():
    """Render requested tracks with explicit input samples and temporary working files."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples-dir", type=Path, required=True)
    parser.add_argument("--site-dir", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--work-dir", type=Path, default=Path("/tmp/eynnzerr-music-render"))
    parser.add_argument("--track", choices=("drum-and-bass", "future-bass", "heaven-trap", "all"), default="all")
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    instruments = Instruments(args.samples_dir)
    slugs = ("drum-and-bass", "future-bass", "heaven-trap") if args.track == "all" else (args.track,)
    reports = []
    for slug in slugs:
        reports.append(render(compose(slug), instruments, args.site_dir, args.work_dir))
        (args.work_dir / "render-report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
