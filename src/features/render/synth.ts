import type { DrumName, Envelope, NoteEvent, Score, ScoreTrack } from '../score/feature.ts';
import { throwIfAborted } from './abort.ts';
import { renderDrumHit } from './drums.ts';
import { applyAutomatedLowpass, filterTrack } from './filters.ts';
import { applyDelay, applyDuck, panGains } from './mix.ts';
import { createWaveState, sampleWaveform } from './waveform.ts';

export interface SongAudio {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly loopSamples: number;
  /** Mono send bus, present only when some track has `send > 0`. */
  readonly sendBus?: Float32Array;
}

const ARP_SEMITONES = [0, 4, 7, 12] as const;
const OPEN_CUTOFF_HZ = 20000;
const SEED_MULTIPLIER = 0x9e3779b1;

/**
 * Piecewise ADSR in note-local seconds. Release is measured backwards from the
 * end of the sounding gate, so staccato notes fade instead of ringing forever.
 */
function envelopeAt(envelope: Envelope, noteSeconds: number, noteDuration: number): number {
  const { attack, decay, sustain, release } = envelope;

  let level: number;
  if (attack > 0 && noteSeconds < attack) {
    level = noteSeconds / attack;
  } else if (decay > 0 && noteSeconds < attack + decay) {
    level = 1 - (1 - sustain) * ((noteSeconds - attack) / decay);
  } else {
    level = sustain;
  }

  const remaining = noteDuration - noteSeconds;
  const releaseTime = Math.min(release, noteDuration);
  if (releaseTime > 0 && remaining < releaseTime) level *= remaining / releaseTime;

  return Math.max(0, Math.min(1, level));
}

/**
 * Expands the default pattern across the loop, or returns the arrangement's
 * absolute timeline in song mode. `steps` is the slot; `gateSteps` is the
 * sounding length and may be longer (legato) or shorter (staccato).
 */
function buildTimeline(score: Score, track: ScoreTrack, signal?: AbortSignal): readonly NoteEvent[] {
  if (track.timeline) return track.timeline;
  if (track.patternSteps <= 0) return [];

  const events: NoteEvent[] = [];
  for (let repeat = 0; repeat * track.patternSteps < score.totalSteps; repeat += 1) {
    throwIfAborted(signal);
    for (const event of track.events) {
      const step = event.step + repeat * track.patternSteps;
      if (step >= score.totalSteps) continue;
      const steps = Math.min(event.steps, score.totalSteps - step);
      if (steps <= 0) continue;
      const gateSteps = Math.min(event.gateSteps ?? event.steps, score.totalSteps);
      events.push({ ...event, step, steps, gateSteps });
    }
  }
  return events;
}

function swingSeconds(score: Score, step: number): number {
  return score.swing > 0 && step % 2 === 1 ? score.swing * score.stepSeconds : 0;
}

/** Folds the score seed into a per-event seed without losing integer precision. */
function seedFor(score: Score, value: number): number {
  return (value ^ Math.imul(score.seed, SEED_MULTIPLIER)) >>> 0;
}

interface MelodicNote {
  readonly track: ScoreTrack;
  readonly event: NoteEvent;
  readonly eventIndex: number;
  readonly trackIndex: number;
  readonly startSample: number;
  readonly gateSamples: number;
  readonly slideFrom: number;
  readonly seed: number;
}

/**
 * Flattens every melodic event into one scheduled note. Chords are already
 * separate NoteEvents at the same step, so this list is naturally polyphonic.
 */
function buildMelodicNotes(
  score: Score,
  rate: number,
  track: ScoreTrack,
  trackIndex: number,
  signal?: AbortSignal,
): readonly MelodicNote[] {
  const notes: MelodicNote[] = [];
  const maxGateSamples = Math.max(1, Math.round(score.durationSeconds * rate));
  const events = buildTimeline(score, track, signal);
  const lastFrequency = new Map<number, number>();

  events.forEach((event, eventIndex) => {
    const voice = event.voice ?? 0;
    const startSeconds = event.step * score.stepSeconds + swingSeconds(score, event.step);
    const gateSteps = Math.max(1, event.gateSteps ?? event.steps);
    notes.push({
      track,
      event,
      eventIndex,
      trackIndex,
      startSample: Math.round(startSeconds * rate),
      gateSamples: Math.min(maxGateSamples, Math.max(1, Math.round(gateSteps * score.stepSeconds * rate))),
      slideFrom: lastFrequency.get(voice) ?? event.frequency,
      seed: seedFor(score, (trackIndex + 1) * 0x9e3779b9 + eventIndex * 131 + 1),
    });
    lastFrequency.set(voice, event.frequency);
  });

  return notes;
}

/**
 * Renders one scheduled note. The oscillator starts at phase 0 for this note,
 * which is what makes overlapping chord voices and legato gates independent.
 */
function renderMelodicNote(
  samples: Float32Array,
  note: MelodicNote,
  score: Score,
  rate: number,
  loopSamples: number,
  wrap: boolean,
  signal?: AbortSignal,
): void {
  const { track, event } = note;
  const wave = createWaveState(note.seed);
  let phase = 0;
  const noteDuration = note.gateSamples / rate;
  const envelope = event.envelope ?? track.envelope;
  const start = wrap
    ? ((note.startSample % loopSamples) + loopSamples) % loopSamples
    : note.startSample;

  if (!wrap && (start < 0 || start >= samples.length)) return;

  for (let i = 0; i < note.gateSamples; i += 1) {
    if ((i & 8191) === 0) throwIfAborted(signal);
    let index = start + i;
    if (wrap) {
      if (index >= loopSamples) index %= loopSamples;
    } else if (index >= samples.length) {
      break;
    }
    if (index < 0) continue;

    const noteSeconds = i / rate;
    let frequency = event.frequency;
    let level = envelopeAt(envelope, noteSeconds, noteDuration);

    switch (event.effect) {
      case 1: {
        const from = note.slideFrom > 0 ? note.slideFrom : frequency;
        const slideSeconds = (event.effectParams?.slideSteps ?? 1) * score.stepSeconds;
        const amount = slideSeconds > 0 ? Math.min(1, noteSeconds / slideSeconds) : 1;
        frequency = from + (frequency - from) * amount;
        break;
      }
      case 2: {
        const depth = event.effectParams?.vibratoDepth ?? 0.5;
        const rateHz = event.effectParams?.vibratoRate ?? 7.5;
        const lfo = 1 - 2 * Math.abs(((rateHz * noteSeconds) % 1) - 0.5);
        frequency *= 2 ** ((lfo * depth) / 12);
        break;
      }
      case 3:
        frequency *= Math.max(0.001, 1 - noteSeconds / noteDuration);
        break;
      case 4:
        level *= Math.min(1, noteSeconds / noteDuration);
        break;
      case 5:
        level *= Math.max(0, 1 - noteSeconds / noteDuration);
        break;
      case 6:
      case 7: {
        const period = event.effect === 6 ? score.stepSeconds / 2 : score.stepSeconds;
        const arpIndex = Math.floor(noteSeconds / period) % ARP_SEMITONES.length;
        frequency = event.frequency * 2 ** ((ARP_SEMITONES[arpIndex] ?? 0) / 12);
        break;
      }
    }

    const gain = (event.volume / 7) * level * (event.gain ?? 1);
    if (gain <= 0) continue;

    phase += frequency / rate;
    if (phase > 1e6) phase -= Math.floor(phase);
    wave.phase = phase;

    const key = Math.min(63, Math.max(0, event.midi - 36));
    samples[index] = (samples[index] ?? 0) + sampleWaveform(track.waveform, wave, key) * gain;
  }
}

interface DrumHit {
  readonly offset: number;
  readonly drum: DrumName;
  readonly velocity: number;
  readonly seed: number;
}

function buildDrumHits(
  score: Score,
  rate: number,
  track: ScoreTrack,
  trackIndex: number,
  signal?: AbortSignal,
): readonly DrumHit[] {
  const hits: DrumHit[] = [];
  buildTimeline(score, track, signal).forEach((event, eventIndex) => {
    if (!event.drum) return;
    const startSeconds = event.step * score.stepSeconds + swingSeconds(score, event.step);
    hits.push({
      offset: Math.round(startSeconds * rate),
      drum: event.drum,
      velocity: (event.volume / 7) * (event.gain ?? 1),
      seed: seedFor(
        score,
        (trackIndex + 1) * 0x9e3779b9 + eventIndex * 131 + event.midi,
      ),
    });
  });
  return hits;
}

/**
 * Adds drum one-shots. Each hit is rendered independently, so a tail can
 * overlap the next hit. In loop mode the tail wraps into the same pass, which
 * keeps every repeated pass identical and the seam sample-exact.
 */
function addDrumHits(
  samples: Float32Array,
  hits: readonly DrumHit[],
  rate: number,
  loopSamples: number,
  wrap: boolean,
  signal?: AbortSignal,
): void {
  for (const hit of hits) {
    throwIfAborted(signal);
    const start = wrap
      ? ((hit.offset % loopSamples) + loopSamples) % loopSamples
      : Math.max(0, hit.offset);
    if (!wrap && start >= samples.length) continue;

    const audio = renderDrumHit(hit.drum, rate, hit.velocity, hit.seed);
    for (let i = 0; i < audio.length; i += 1) {
      let index = start + i;
      if (index >= loopSamples) {
        if (!wrap) break;
        index %= loopSamples;
      }
      samples[index] = (samples[index] ?? 0) + (audio[i] ?? 0);
    }
  }
}

/**
 * The arrangement's section filter. A section may sweep its cutoff from
 * `filterHz` to `filterEndHz`; equal endpoints mean a static section. The
 * filter state crosses section boundaries so a drop from a low cutoff to open
 * does not click.
 */
function applySectionFilter(samples: Float32Array, score: Score, rate: number): void {
  if (!score.sections.some((section) => section.filterHz !== undefined)) return;

  const loopSamples = Math.max(1, Math.round(score.durationSeconds * rate));
  const samplesPerStep = score.stepSeconds * rate;
  const sections = score.sections;
  let sectionIndex = 0;
  const cutoffAt = (index: number): number => {
    const local = index % loopSamples;
    while (sectionIndex < sections.length - 1) {
      const current = sections[sectionIndex];
      if (!current || local < (current.startStep + current.steps) * samplesPerStep) break;
      sectionIndex += 1;
    }
    const section = sections[sectionIndex];
    if (!section || section.filterHz === undefined) return OPEN_CUTOFF_HZ;
    const start = section.startStep * samplesPerStep;
    const length = Math.max(1, section.steps * samplesPerStep);
    const progress = Math.min(1, Math.max(0, (local - start) / length));
    const end = section.filterEndHz ?? section.filterHz;
    return section.filterHz * (end / section.filterHz) ** progress;
  };

  applyAutomatedLowpass(samples, cutoffAt, rate);
}

function collectKickOffsets(score: Score, rate: number, signal?: AbortSignal): readonly number[] {
  const offsets: number[] = [];
  score.tracks.forEach((track, index) => {
    if (!track.isDrums) return;
    for (const hit of buildDrumHits(score, rate, track, index, signal)) {
      if (hit.drum === 'kick') offsets.push(hit.offset);
    }
  });
  offsets.sort((a, b) => a - b);
  return offsets;
}

/**
 * Renders one sample-exact pass of the score. Each track gets its own buffer so
 * filters, panning, delay, ducking, and sends stay per-track; the buffers are
 * summed only after the mix-stage processing.
 */
export function renderScore(score: Score, rate: number, signal?: AbortSignal): SongAudio {
  const loopSamples = Math.max(1, Math.round(score.durationSeconds * rate));
  const wrap = score.mode === 'loop';
  const left = new Float32Array(loopSamples);
  const right = new Float32Array(loopSamples);
  const hasSend = score.tracks.some((track) => track.send > 0);
  const sendBus = hasSend ? new Float32Array(loopSamples) : undefined;
  const kicks = collectKickOffsets(score, rate, signal);

  score.tracks.forEach((track, trackIndex) => {
    throwIfAborted(signal);
    const buffer = new Float32Array(loopSamples);

    if (track.isDrums) {
      addDrumHits(
        buffer,
        buildDrumHits(score, rate, track, trackIndex, signal),
        rate,
        loopSamples,
        wrap,
        signal,
      );
    } else {
      for (const note of buildMelodicNotes(score, rate, track, trackIndex, signal)) {
        renderMelodicNote(buffer, note, score, rate, loopSamples, wrap, signal);
      }
    }

    if (track.filter) filterTrack(buffer, track.filter, rate);
    if (track.delay) {
      applyDelay(buffer, track.delay, score.stepSeconds, rate, loopSamples, wrap, signal);
    }
    if (track.duck > 0) applyDuck(buffer, kicks, track.duck, rate, loopSamples, wrap, signal);

    const [leftGain, rightGain] = panGains(track.pan);
    for (let i = 0; i < loopSamples; i += 1) {
      if ((i & 16383) === 0) throwIfAborted(signal);
      const value = buffer[i] ?? 0;
      left[i] = (left[i] ?? 0) + value * leftGain;
      right[i] = (right[i] ?? 0) + value * rightGain;
      if (sendBus && track.send > 0) {
        sendBus[i] = (sendBus[i] ?? 0) + value * track.send;
      }
    }
  });

  throwIfAborted(signal);
  applySectionFilter(left, score, rate);
  applySectionFilter(right, score, rate);

  return { left, right, loopSamples, ...(sendBus === undefined ? {} : { sendBus }) };
}
