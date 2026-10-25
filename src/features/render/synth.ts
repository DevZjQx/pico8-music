import { secondsAtStep, stepSecondsAt, timelineOf } from '../score/feature.ts';
import type {
  DrumName,
  Envelope,
  Instrument,
  NoteEvent,
  Score,
  ScoreGroup,
  ScoreTrack,
  SendReverb,
} from '../score/feature.ts';
import { throwIfAborted } from './abort.ts';
import { analyseStem, type StemReading } from './analyze.ts';
import { renderDrumHit } from './drums.ts';
import { applyAutomatedLowpass, applyTrackEq, filterTrack } from './filters.ts';
import { addSectionRisers } from './fx.ts';
import { InstrumentVoice } from './instrument.ts';
import {
  applyDelay,
  applyDuck,
  applyTrackSectionFilter,
  hasSectionTrackAutomation,
  panGains,
  sectionTrackSegments,
} from './mix.ts';
import {
  SampleVoice,
  renderSampleOneShot,
  selectSampleSource,
  type SampleBank,
  type SampleSource,
} from './sample.ts';
import { createWaveState, sampleWaveformAt } from './waveform.ts';
import type { Quality } from './types.ts';

interface StereoBus {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** One stereo send destined for a reverb return. */
export interface SendBusAudio extends StereoBus {
  /** Group return settings; absent is the default send return. */
  readonly reverb?: SendReverb;
}

export interface SongAudio {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly loopSamples: number;
  /**
   * Stereo sends. The first bus, when present, is the default return used by
   * tracks without a group; each named group owns a separate return. Every bus
   * keeps the pan of its sources instead of folding them to mono.
   */
  readonly sendBuses: readonly SendBusAudio[];
  /** Per-track measurements taken before pan/sum; no track audio is retained. */
  readonly stems: readonly StemReading[];
}

function stereoBus(length: number): StereoBus {
  return { left: new Float32Array(length), right: new Float32Array(length) };
}

const ARP_SEMITONES = [0, 4, 7, 12] as const;
const OPEN_CUTOFF_HZ = 20000;
const SEED_MULTIPLIER = 0x9e3779b1;
const GHOST_VELOCITY = 0.45;
const GHOST_DECAY_SCALE = 0.6;
const GHOST_TONE_HZ = 4500;
const FLAM_VELOCITY = 0.45;
const ROLL_VELOCITY_STEP = 0.12;

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
 * The scheduling rule lives in `score` (it is symbolic, not audio), so the
 * symbolic structure reading and the synth always agree on which events exist.
 * The abort check stays here: expanding a long timeline is still render work.
 */
function buildTimeline(score: Score, track: ScoreTrack, signal?: AbortSignal): readonly NoteEvent[] {
  throwIfAborted(signal);
  return timelineOf(score, track);
}

/**
 * Positive swing delays odd steps, negative swing pushes them earlier. The
 * parser caps the magnitude at half a step, so an odd step can never cross
 * the even step before it.
 */
function swingSeconds(score: Score, step: number): number {
  return score.swing !== 0 && step % 2 === 1 ? score.swing * stepSecondsAt(score, step) : 0;
}

/** Folds the score seed into a per-event seed without losing integer precision. */
function seedFor(score: Score, value: number): number {
  return (value ^ Math.imul(score.seed, SEED_MULTIPLIER)) >>> 0;
}

const HUMANIZE_TIMING_SALT = 0x51ed270b;
const HUMANIZE_VELOCITY_SALT = 0x2545f491;

/**
 * A stateless integer hash in [0, 1). Humanize must not depend on iteration
 * order: the same (seed, track, event, voice) gives the same offset on every
 * render, including each repeated pass of a loop.
 */
function humanizeUnit(
  score: Score,
  trackIndex: number,
  eventIndex: number,
  voice: number,
  salt: number,
): number {
  let value = (score.seed ^ salt) >>> 0;
  value = Math.imul(value ^ (trackIndex + 1), 0x9e3779b1) >>> 0;
  value = Math.imul(value ^ (eventIndex + 1), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (voice + 1), 0xc2b2ae35) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function humanizeTimingSamples(
  score: Score,
  trackIndex: number,
  eventIndex: number,
  voice: number,
  rate: number,
): number {
  if (score.humanize.timingMs <= 0) return 0;
  const unit = humanizeUnit(score, trackIndex, eventIndex, voice, HUMANIZE_TIMING_SALT);
  return Math.round((unit * 2 - 1) * score.humanize.timingMs * 0.001 * rate);
}

function humanizeGain(
  score: Score,
  trackIndex: number,
  eventIndex: number,
  voice: number,
): number {
  if (score.humanize.velocity <= 0) return 1;
  const unit = humanizeUnit(score, trackIndex, eventIndex, voice, HUMANIZE_VELOCITY_SALT);
  return Math.max(0, Math.min(1.5, 1 + (unit * 2 - 1) * score.humanize.velocity * 0.5));
}

interface MelodicNote {
  readonly track: ScoreTrack;
  readonly event: NoteEvent;
  readonly eventIndex: number;
  readonly trackIndex: number;
  readonly startSample: number;
  readonly gateSamples: number;
  /** Seconds per step at the event's position; drives slide and arp timing. */
  readonly stepSeconds: number;
  readonly slideFrom: number;
  readonly seed: number;
  /** Deterministic velocity variation; 1 leaves the authored volume alone. */
  readonly humanizeGain: number;
  /** Absent keeps the historical eight-waveform path, sample for sample. */
  readonly instrument?: Instrument;
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
  instrument: Instrument | undefined,
  signal?: AbortSignal,
): readonly MelodicNote[] {
  const notes: MelodicNote[] = [];
  const maxGateSamples = Math.max(1, Math.round(score.durationSeconds * rate));
  const events = buildTimeline(score, track, signal);
  const lastFrequency = new Map<number, number>();

  events.forEach((event, eventIndex) => {
    const voice = event.voice ?? 0;
    const eventStepSeconds = stepSecondsAt(score, event.step);
    const startSeconds = secondsAtStep(score, event.step) + swingSeconds(score, event.step);
    const gateSteps = Math.max(1, event.gateSteps ?? event.steps);
    notes.push({
      track,
      event,
      eventIndex,
      trackIndex,
      startSample:
        Math.round(startSeconds * rate) +
        humanizeTimingSamples(score, trackIndex, eventIndex, voice, rate),
      gateSamples: Math.min(
        maxGateSamples,
        Math.max(1, Math.round(gateSteps * eventStepSeconds * rate)),
      ),
      stepSeconds: eventStepSeconds,
      slideFrom: lastFrequency.get(voice) ?? event.frequency,
      seed: seedFor(score, (trackIndex + 1) * 0x9e3779b9 + eventIndex * 131 + 1),
      humanizeGain: humanizeGain(score, trackIndex, eventIndex, voice),
      ...(instrument === undefined ? {} : { instrument }),
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
  sampleBank: SampleBank | undefined,
  quality: Quality,
  signal?: AbortSignal,
): void {
  const { track, event } = note;
  const wave = createWaveState(note.seed);
  const sampleName = note.instrument?.type === 'sample' ? note.instrument.sample : undefined;
  const sampleEntry = sampleName === undefined ? undefined : sampleBank?.get(sampleName);
  if (sampleName !== undefined && sampleEntry === undefined) {
    throw new Error(`sample ${JSON.stringify(sampleName)} is missing from the render bank`);
  }
  const noteVelocity = Math.max(0, Math.min(1, (event.volume / 7) * note.humanizeGain));
  // A zone set answers per note, so the same track can cross key or velocity
  // boundaries; a plain source is returned unchanged.
  const sampleSource =
    sampleEntry === undefined
      ? undefined
      : selectSampleSource(sampleEntry, event.midi, noteVelocity);
  const sampleVoice =
    sampleSource === undefined ? undefined : new SampleVoice(sampleSource, rate);
  const voice =
    note.instrument === undefined || note.instrument.type === 'sample'
      ? undefined
      : new InstrumentVoice(
          note.instrument,
          event.midi,
          rate,
          note.seed,
          event.frequency,
          noteVelocity,
          quality,
        );
  let phase = 0;
  const noteDuration = note.gateSamples / rate;
  const envelope = event.envelope ?? track.envelope;
  const start = wrap
    ? ((note.startSample % loopSamples) + loopSamples) % loopSamples
    : Math.max(0, note.startSample);

  if (!wrap && start >= samples.length) return;

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
        const slideSeconds = (event.effectParams?.slideSteps ?? 1) * note.stepSeconds;
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
        const period = event.effect === 6 ? note.stepSeconds / 2 : note.stepSeconds;
        const arpIndex = Math.floor(noteSeconds / period) % ARP_SEMITONES.length;
        frequency = event.frequency * 2 ** ((ARP_SEMITONES[arpIndex] ?? 0) / 12);
        break;
      }
    }

    const gain = (event.volume / 7) * level * (event.gain ?? 1) * note.humanizeGain;
    if (gain <= 0) continue;

    if (sampleVoice !== undefined) {
      samples[index] = (samples[index] ?? 0) + sampleVoice.sample(frequency) * gain;
      continue;
    }

    if (voice !== undefined) {
      samples[index] = (samples[index] ?? 0) + voice.sample(frequency, noteSeconds, noteDuration) * gain;
      continue;
    }

    phase += frequency / rate;
    if (phase > 1e6) phase -= Math.floor(phase);
    wave.phase = phase;

    const key = Math.min(63, Math.max(0, event.midi - 36));
    samples[index] =
      (samples[index] ?? 0) + sampleWaveformAt(quality, track.waveform, wave, key, frequency / rate) * gain;
  }
}

interface DrumHit {
  readonly offset: number;
  readonly drum: DrumName;
  readonly velocity: number;
  readonly seed: number;
  readonly decayScale?: number;
  readonly toneHz?: number;
  readonly pitchSemitones?: number;
  /** Present when `drumSamples` maps this voice to a persisted WAV. */
  readonly sample?: SampleSource;
}

function buildDrumHits(
  score: Score,
  rate: number,
  track: ScoreTrack,
  trackIndex: number,
  sampleBank: SampleBank | undefined,
  signal?: AbortSignal,
): readonly DrumHit[] {
  const hits: DrumHit[] = [];
  buildTimeline(score, track, signal).forEach((event, eventIndex) => {
    const drum = event.drum;
    if (!drum) return;
    const mappedSample = score.drumSamples.get(drum);
    const sampleEntry = mappedSample === undefined ? undefined : sampleBank?.get(mappedSample);
    if (mappedSample !== undefined && sampleEntry === undefined) {
      throw new Error(`sample ${JSON.stringify(mappedSample)} for drum ${drum} is missing from the render bank`);
    }
    const startSeconds = secondsAtStep(score, event.step) + swingSeconds(score, event.step);
    const slotSeconds = Math.max(0, event.steps * stepSecondsAt(score, event.step));
    const effect = event.drumEffect;
    const params = event.drumParams;
    const seedBase = (trackIndex + 1) * 0x9e3779b9 + eventIndex * 131 + event.midi;

    let velocity = (event.volume / 7) * (event.gain ?? 1) * humanizeGain(score, trackIndex, eventIndex, event.voice ?? 0);
    const timingSamples = humanizeTimingSamples(
      score,
      trackIndex,
      eventIndex,
      event.voice ?? 0,
      rate,
    );
    let decayScale: number | undefined = params?.decayScale;
    let toneHz: number | undefined = params?.toneHz;
    const pitchSemitones = params?.pitchSemitones;
    if (effect?.kind === 'ghost') {
      velocity *= GHOST_VELOCITY;
      // An explicit ~decay multiplies the ghost's shorter shape instead of
      // replacing it, so the two suffixes compose predictably.
      decayScale = (decayScale ?? 1) * GHOST_DECAY_SCALE;
      toneHz = toneHz ?? GHOST_TONE_HZ;
    }

    const pushHit = (offsetSeconds: number, hitVelocity: number, hitIndex: number): void => {
      const level = Math.max(0, hitVelocity);
      // Zone selection happens per hit so velocity layers also follow `~ghost`,
      // `~flam`, and `~roll`, not just the authored volume.
      const sample =
        sampleEntry === undefined
          ? undefined
          : selectSampleSource(sampleEntry, event.midi, Math.min(1, level));
      hits.push({
        offset: Math.round((startSeconds + offsetSeconds) * rate) + timingSamples,
        drum,
        velocity: level,
        seed: seedFor(score, seedBase + hitIndex * 17),
        ...(decayScale === undefined ? {} : { decayScale }),
        ...(toneHz === undefined ? {} : { toneHz }),
        ...(pitchSemitones === undefined ? {} : { pitchSemitones }),
        ...(sample === undefined ? {} : { sample }),
      });
    };

    if (effect?.kind === 'flam') {
      pushHit(0, velocity, 0);
      pushHit(effect.offsetMs / 1000, velocity * FLAM_VELOCITY, 1);
      return;
    }
    if (effect?.kind === 'roll') {
      for (let i = 0; i < effect.hits; i += 1) {
        const offsetSeconds = slotSeconds * (i / effect.hits);
        const hitVelocity = velocity * Math.max(0.2, 1 - ROLL_VELOCITY_STEP * i);
        pushHit(offsetSeconds, hitVelocity, i);
      }
      return;
    }
    pushHit(0, velocity, 0);
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

    const audio =
      hit.sample === undefined
        ? renderDrumHit(hit.drum, rate, hit.velocity, hit.seed, {
            ...(hit.decayScale === undefined ? {} : { decayScale: hit.decayScale }),
            ...(hit.toneHz === undefined ? {} : { toneHz: hit.toneHz }),
            ...(hit.pitchSemitones === undefined ? {} : { pitchSemitones: hit.pitchSemitones }),
          })
        : renderSampleOneShot(
            hit.sample,
            rate,
            hit.velocity,
            hit.pitchSemitones ?? 0,
            hit.toneHz,
            hit.decayScale,
          );
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

  // A song with a tail has silence after the last step; do not wrap its filter
  // phase back to the first section while that tail rings out.
  const loopSamples =
    score.mode === 'song'
      ? Math.max(1, samples.length)
      : Math.max(1, Math.round(score.durationSeconds * rate));
  const sections = score.sections;
  let sectionIndex = 0;
  const cutoffAt = (index: number): number => {
    const local = index % loopSamples;
    while (sectionIndex < sections.length - 1) {
      const current = sections[sectionIndex];
      if (!current || local < (current.startSeconds + current.durationSeconds) * rate) break;
      sectionIndex += 1;
    }
    const section = sections[sectionIndex];
    if (!section || section.filterHz === undefined) return OPEN_CUTOFF_HZ;
    const start = section.startSeconds * rate;
    const length = Math.max(1, section.durationSeconds * rate);
    const progress = Math.min(1, Math.max(0, (local - start) / length));
    const end = section.filterEndHz ?? section.filterHz;
    const energyFactor = 0.35 + 0.65 * (section.energy ?? 1);
    return section.filterHz * energyFactor * (end / section.filterHz) ** progress;
  };

  applyAutomatedLowpass(samples, cutoffAt, rate);
}

/**
 * Section-level `space`: scales each send bus drive before its reverb, so
 * distance can move without touching the dry level. 1 is neutral, 0 is dry,
 * 2 is twice the send. A score with no track send has no bus and no-op's; the
 * parser warns about that combination instead of failing the render.
 */
function applySectionSend(samples: Float32Array, score: Score, rate: number): void {
  if (!score.sections.some((section) => (section.space ?? 1) !== 1)) return;
  let cursor = 0;
  for (const section of score.sections) {
    const end = Math.min(
      samples.length,
      Math.max(cursor, Math.round((section.startSeconds + section.durationSeconds) * rate)),
    );
    const gain = section.space ?? 1;
    if (gain !== 1) {
      for (let i = cursor; i < end; i += 1) samples[i] = (samples[i] ?? 0) * gain;
    }
    cursor = end;
  }
  // The tail is the last section's ring-out and keeps its space.
  const tailGain = score.sections[score.sections.length - 1]?.space ?? 1;
  if (tailGain !== 1) {
    for (let i = cursor; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) * tailGain;
  }
}

function collectKickOffsets(
  score: Score,
  rate: number,
  sampleBank: SampleBank | undefined,
  signal?: AbortSignal,
): readonly number[] {
  const offsets: number[] = [];
  score.tracks.forEach((track, index) => {
    if (!track.isDrums) return;
    for (const hit of buildDrumHits(score, rate, track, index, sampleBank, signal)) {
      if (hit.drum === 'kick') offsets.push(hit.offset);
    }
  });
  offsets.sort((a, b) => a - b);
  return offsets;
}

/**
 * Role-based instruments a style supplies. An explicit `track.instrument`
 * always wins; `default` is the fallback for a role the style does not name.
 */
export type RoleInstruments = Readonly<Record<string, Instrument>>;

function instrumentFor(track: ScoreTrack, defaults: RoleInstruments | undefined): Instrument | undefined {
  if (track.isDrums) return undefined;
  if (track.instrument !== undefined) return track.instrument;
  if (defaults === undefined) return undefined;
  return defaults[track.role.toLowerCase()] ?? defaults.default;
}

/**
 * Direct-form chip waves fold harmonics above Nyquist back into the audible
 * band. This is a cheap score-level warning, not a spectral measurement: the
 * report says "risk" and the model can A/B the clean additive path.
 */
const ALIAS_WAVEFORMS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);
const ALIAS_FLOOR_MIDI = 84; // C6

function aliasRiskOf(track: ScoreTrack, quality: Quality): boolean {
  if (track.isDrums) return false;
  const waveform =
    track.instrument?.type === 'chip'
      ? track.instrument.waveform
      : track.instrument === undefined
        ? track.waveform
        : undefined;
  if (waveform === undefined || !ALIAS_WAVEFORMS.has(waveform)) return false;
  // PolyBLEP removes the jump that folds on saw and pulse. The continuous
  // waveforms in the risk set (tilted saw, organ) keep the heuristic.
  if (quality === 'clean' && (waveform === 2 || waveform === 3 || waveform === 4)) return false;
  const events = track.timeline ?? track.events;
  for (const event of events) {
    if (event.midi >= ALIAS_FLOOR_MIDI) return true;
  }
  return false;
}

/**
 * Renders one sample-exact pass of the score. Each track gets its own buffer so
 * filters, panning, delay, ducking, and sends stay per-track; the buffers are
 * summed only after the mix-stage processing.
 */
export function renderScore(
  score: Score,
  rate: number,
  signal?: AbortSignal,
  roleInstruments?: RoleInstruments,
  sampleBank?: SampleBank,
  quality: Quality = 'pico',
): SongAudio {
  const musicSamples = Math.max(1, Math.round(score.durationSeconds * rate));
  const tailSamples = score.mode === 'song' ? Math.max(0, Math.round(score.tailSeconds * rate)) : 0;
  const loopSamples = musicSamples + tailSamples;
  const wrap = score.mode === 'loop';
  const left = new Float32Array(loopSamples);
  const right = new Float32Array(loopSamples);
  // Section track state is a song-only add-on. Old scores have none, so every
  // extra scan and branch below is skipped for the common legacy path.
  const hasTrackSections = score.sections.some((section) => section.trackStates !== undefined);
  const groupBuffers = new Map<string, StereoBus>();
  const groupSends = new Map<string, StereoBus>();
  let defaultSend: StereoBus | undefined;

  const bufferForGroup = (group: ScoreGroup): StereoBus => {
    const existing = groupBuffers.get(group.name);
    if (existing !== undefined) return existing;
    const created = stereoBus(loopSamples);
    groupBuffers.set(group.name, created);
    return created;
  };
  const sendForGroup = (group: ScoreGroup | undefined): StereoBus => {
    if (group === undefined) {
      defaultSend ??= stereoBus(loopSamples);
      return defaultSend;
    }
    const existing = groupSends.get(group.name);
    if (existing !== undefined) return existing;
    const created = stereoBus(loopSamples);
    groupSends.set(group.name, created);
    return created;
  };

  const kicks = collectKickOffsets(score, rate, sampleBank, signal);
  const stems: StemReading[] = [];

  score.tracks.forEach((track, trackIndex) => {
    throwIfAborted(signal);
    const buffer = new Float32Array(loopSamples);

    if (track.isDrums) {
      addDrumHits(
        buffer,
        buildDrumHits(score, rate, track, trackIndex, sampleBank, signal),
        rate,
        loopSamples,
        wrap,
        signal,
      );
    } else {
      const instrument = instrumentFor(track, roleInstruments);
      for (const note of buildMelodicNotes(score, rate, track, trackIndex, instrument, signal)) {
        renderMelodicNote(buffer, note, score, rate, loopSamples, wrap, sampleBank, quality, signal);
      }
    }

    if (track.filter) filterTrack(buffer, track.filter, rate);
    if (track.highpassHz !== undefined || track.lowShelf !== undefined || track.highShelf !== undefined) {
      applyTrackEq(
        buffer,
        {
          ...(track.highpassHz === undefined ? {} : { highpassHz: track.highpassHz }),
          ...(track.lowShelf === undefined ? {} : { lowShelf: track.lowShelf }),
          ...(track.highShelf === undefined ? {} : { highShelf: track.highShelf }),
        },
        rate,
      );
    }
    if (track.delay) {
      applyDelay(buffer, track.delay, score, rate, loopSamples, wrap, signal);
    }
    if (track.duck > 0) applyDuck(buffer, kicks, track.duck, rate, loopSamples, wrap, signal);
    // A section can filter this track alone; it runs after the track's own
    // filter/EQ/delay/duck and before pan/send, so neighboring tracks keep
    // their highs when one part closes.
    if (hasTrackSections) applyTrackSectionFilter(buffer, score, track, rate);

    // Measure the finished stem before pan/send: this is the only place where
    // the report can attribute a band to a track without keeping its audio.
    stems.push(
      analyseStem(buffer, rate, {
        name: track.name,
        role: track.role,
        pan: track.pan,
        send: track.send,
        aliasRisk: aliasRiskOf(track, quality),
      }),
    );

    const group = track.group === undefined ? undefined : score.groups.get(track.group);
    if (track.group !== undefined && group === undefined) {
      throw new Error(`track ${track.name} references unknown group ${track.group}`);
    }
    const sendGroup =
      track.sendBus === undefined ? group : score.groups.get(track.sendBus);
    if (track.sendBus !== undefined && sendGroup === undefined) {
      throw new Error(`track ${track.name} references unknown send return ${track.sendBus}`);
    }
    const destination = group === undefined ? { left, right } : bufferForGroup(group);
    // A member's send is post its source group's fader and pan, so muting or
    // moving the group moves its return too. A cross-group send keeps the
    // source group's balance and targets the other group's return.
    const [groupLeftGain, groupRightGain] =
      group === undefined ? [1, 1] : panGains(group.pan);
    const sendScaleLeft = group === undefined ? 1 : group.gain * groupLeftGain;
    const sendScaleRight = group === undefined ? 1 : group.gain * groupRightGain;

    if (hasTrackSections && hasSectionTrackAutomation(score, track)) {
      for (const segment of sectionTrackSegments(score, track, rate, loopSamples)) {
        const [leftGain, rightGain] = panGains(segment.pan);
        const send = segment.send > 0 ? sendForGroup(sendGroup) : undefined;
        const sendMono = track.sendStereo === false;
        for (let i = segment.start; i < segment.end; i += 1) {
          if ((i & 16383) === 0) throwIfAborted(signal);
          const value = buffer[i] ?? 0;
          const leftValue = value * leftGain;
          const rightValue = value * rightGain;
          destination.left[i] = (destination.left[i] ?? 0) + leftValue;
          destination.right[i] = (destination.right[i] ?? 0) + rightValue;
          if (send !== undefined) {
            const sendLeft = sendMono ? value * segment.send : leftValue * segment.send;
            const sendRight = sendMono ? value * segment.send : rightValue * segment.send;
            send.left[i] = (send.left[i] ?? 0) + sendLeft * sendScaleLeft;
            send.right[i] = (send.right[i] ?? 0) + sendRight * sendScaleRight;
          }
        }
      }
    } else {
      const [leftGain, rightGain] = panGains(track.pan);
      const send = track.send > 0 ? sendForGroup(sendGroup) : undefined;
      const sendMono = track.sendStereo === false;
      for (let i = 0; i < loopSamples; i += 1) {
        if ((i & 16383) === 0) throwIfAborted(signal);
        const value = buffer[i] ?? 0;
        const leftValue = value * leftGain;
        const rightValue = value * rightGain;
        destination.left[i] = (destination.left[i] ?? 0) + leftValue;
        destination.right[i] = (destination.right[i] ?? 0) + rightValue;
        if (send !== undefined) {
          const sendLeft = sendMono ? value * track.send : leftValue * track.send;
          const sendRight = sendMono ? value * track.send : rightValue * track.send;
          send.left[i] = (send.left[i] ?? 0) + sendLeft * sendScaleLeft;
          send.right[i] = (send.right[i] ?? 0) + sendRight * sendScaleRight;
        }
      }
    }
  });

  throwIfAborted(signal);

  // A group is a real submix: its members are summed before the group fader,
  // pan, filter, delay, and duck. This is what lets a drum or pad group share
  // one send and one bus treatment instead of every track owning its own.
  for (const group of score.groups.values()) {
    const bus = groupBuffers.get(group.name);
    if (bus === undefined) continue;
    throwIfAborted(signal);

    if (group.filter) {
      filterTrack(bus.left, group.filter, rate);
      filterTrack(bus.right, group.filter, rate);
    }
    if (
      group.highpassHz !== undefined ||
      group.lowShelf !== undefined ||
      group.highShelf !== undefined
    ) {
      const eq = {
        ...(group.highpassHz === undefined ? {} : { highpassHz: group.highpassHz }),
        ...(group.lowShelf === undefined ? {} : { lowShelf: group.lowShelf }),
        ...(group.highShelf === undefined ? {} : { highShelf: group.highShelf }),
      };
      applyTrackEq(bus.left, eq, rate);
      applyTrackEq(bus.right, eq, rate);
    }
    if (group.delay) {
      applyDelay(bus.left, group.delay, score, rate, loopSamples, wrap, signal);
      applyDelay(bus.right, group.delay, score, rate, loopSamples, wrap, signal);
    }
    if (group.duck > 0) {
      applyDuck(bus.left, kicks, group.duck, rate, loopSamples, wrap, signal);
      applyDuck(bus.right, kicks, group.duck, rate, loopSamples, wrap, signal);
    }

    const [leftGain, rightGain] = panGains(group.pan);
    const send = group.send > 0 ? sendForGroup(group) : undefined;
    for (let i = 0; i < loopSamples; i += 1) {
      if ((i & 16383) === 0) throwIfAborted(signal);
      const leftValue = (bus.left[i] ?? 0) * group.gain * leftGain;
      const rightValue = (bus.right[i] ?? 0) * group.gain * rightGain;
      left[i] = (left[i] ?? 0) + leftValue;
      right[i] = (right[i] ?? 0) + rightValue;
      if (send !== undefined) {
        send.left[i] = (send.left[i] ?? 0) + leftValue * group.send;
        send.right[i] = (send.right[i] ?? 0) + rightValue * group.send;
      }
    }
  }

  addSectionRisers(left, right, score, rate, signal);
  applySectionFilter(left, score, rate);
  applySectionFilter(right, score, rate);
  // A send is part of the section's mix too. Filtering it before the reverb
  // keeps a low-passed section from returning unfiltered highs through its
  // tail; the reverb is linear, so filtering its input is equivalent to
  // filtering its return. Each group send gets the same treatment.
  const sendBuses: SendBusAudio[] = [];
  if (defaultSend !== undefined) {
    applySectionFilter(defaultSend.left, score, rate);
    applySectionFilter(defaultSend.right, score, rate);
    applySectionSend(defaultSend.left, score, rate);
    applySectionSend(defaultSend.right, score, rate);
    sendBuses.push(defaultSend);
  }
  for (const group of score.groups.values()) {
    const send = groupSends.get(group.name);
    if (send === undefined) continue;
    applySectionFilter(send.left, score, rate);
    applySectionFilter(send.right, score, rate);
    applySectionSend(send.left, score, rate);
    applySectionSend(send.right, score, rate);
    sendBuses.push({
      ...send,
      ...(group.reverb === undefined ? {} : { reverb: group.reverb }),
    });
  }

  return { left, right, loopSamples, stems, sendBuses };
}
