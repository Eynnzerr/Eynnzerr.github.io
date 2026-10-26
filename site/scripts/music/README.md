# Original rhythm-game recordings

`render_tracks.py` renders the three expansion recordings and both difficulty
charts from one authored event sequence. Every chart timestamp is the same
sample-rounded onset used to place its instrument in the recording.

| Recording | Musical direction | Tempo | Arrangement |
| --- | --- | --- | --- |
| Slipstream | Liquid Drum & Bass: broken drums, acoustic snare, electric piano, Reese bass | 174 BPM | 32 bars, F minor |
| Prism | Future Bass: opening chord pulses, bright lead, piano, half-time drums | 144 BPM | 28 bars, E major |
| Halcyon | Heaven Trap: piano, choir-like sustained synthesis, bells, sliding 808, hat rolls | 150 BPM | 28 bars, D major |

The original Melodic Bass recording is independent of this renderer.

## Reproduce

Dependencies: Python 3.10 or newer, NumPy, and `ffmpeg` with its `libmp3lame`
encoder. The render is local and needs no API credentials. A virtual
environment can provide NumPy without changing the system Python.

Prepare the six source WAV files in `./music-samples`, using the local names
listed below. From the repository root:

```sh
python3 site/scripts/music/render_tracks.py \
  --samples-dir ./music-samples \
  --work-dir /tmp/eynnzerr-music-render \
  --track all
```

Use `--track drum-and-bass`, `--track future-bass`, or `--track heaven-trap` to
render one recording. Each track has its own fixed random seed, so rendering
it alone uses the same synthesized phases and reflections as an `all` run.
MP3 binary output also depends on the installed ffmpeg encoder version.

The script writes:

- MP3 recordings to `site/public/audio/eynnzerr-<track>.mp3`.
- Chart data to `site/src/data/rhythm/<track>.json`.
- Intermediate PCM WAV files and `render-report.json` to `--work-dir`.

The report contains section boundaries, chart counts, simultaneous-note and
same-lane spacing measurements, integrated loudness, loudness range, true peak,
decoded PCM duration, and MP3/WAV onset correlation. These measurements describe
the generated files; listening remains part of reviewing the composition.

## Acoustic samples

The six one-shots are from [VSCO 2 Community Edition](https://versilian-studios.com/vsco-community/),
published by Versilian Studios under CC0. The piano recording is by
Simon Dalzell / Ivy Audio and was redistributed with the library.

Download the source files from the [VSCO-2-CE repository](https://github.com/sgossner/VSCO-2-CE)
and save them with these names:

| Local name | Upstream path | Piano root |
| --- | --- | --- |
| `piano-49.wav` | `Keys/Upright Piano/Player_dyn2_rr1_014.wav` | MIDI 49 |
| `piano-61.wav` | `Keys/Upright Piano/Player_dyn2_rr1_020.wav` | MIDI 61 |
| `piano-73.wav` | `Keys/Upright Piano/Player_dyn2_rr1_026.wav` | MIDI 73 |
| `piano-85.wav` | `Keys/Upright Piano/Player_dyn2_rr1_032.wav` | MIDI 85 |
| `acoustic-snare.wav` | `Percussion/Snare2-HitSN_v9_rr1_Sum.wav` | — |
| `crash.wav` | `Percussion/cymbal-crash1_ff_rr1.wav` | — |

The site retains the upstream license and piano information in
`site/public/audio/LICENSE.txt`, `PIANO-INFO.txt`, and `PIANO-MAPPING.txt`.
The renderer trims recording silence, tunes the piano one-shots, and combines
them with original synthesized drums, bass, chords, melodies, and effects.

## Chart policy

Easy charts use single notes and at least 180 ms between consecutive targets.
Challenge charts allow at most two simultaneous targets. Every lane keeps at
least 120 ms between targets. Dense drum rolls remain audible while only
selected attacks become playable notes. No chart events are moved to satisfy
these limits; collisions are resolved by selecting authored events.

The song JSON contains tempo, decoded duration, key, sections, and the two
arrays of `{time, lane}` notes. `time` is seconds from the decoded recording's
beginning. A stereo-linked limiter and phrase-level gain changes preserve the
quiet introductions, breaks, and louder main sections without shifting time.
