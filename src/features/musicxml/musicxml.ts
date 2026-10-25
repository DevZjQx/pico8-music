import {
  WAVEFORM_NAMES,
  timelineOf,
  type DrumName,
  type NoteEvent,
  type Score,
  type ScoreKey,
  type ScoreSection,
  type ScoreTrack,
} from '../score/feature.ts';

/**
 * Uncompressed MusicXML is the plain `.musicxml` XML document, not the zipped
 * `.mxl` container. The score is already a validated symbol grid, so this file
 * only serialises it: no DSP, no sample decoding, and no file I/O.
 */

export interface MusicXmlOptions {
  /** Written into `<work-title>`; the score format has no title field of its own. */
  readonly title?: string;
}

interface NoteType {
  readonly name: string;
  readonly quarters: number;
}

interface TypeReading {
  readonly type?: string;
  readonly dots?: number;
  readonly timeModification?: { readonly actual: number; readonly normal: number };
}

interface Segment {
  readonly event: NoteEvent;
  /** Measure-local start, in score steps. */
  readonly start: number;
  /** Measure-local notated duration, in score steps (gate capped at the slot). */
  readonly duration: number;
  readonly tieStart: boolean;
  readonly tieStop: boolean;
}

const NOTE_TYPES: readonly NoteType[] = [
  { name: 'whole', quarters: 4 },
  { name: 'half', quarters: 2 },
  { name: 'quarter', quarters: 1 },
  { name: 'eighth', quarters: 0.5 },
  { name: '16th', quarters: 0.25 },
  { name: '32nd', quarters: 0.125 },
  { name: '64th', quarters: 0.0625 },
  { name: '128th', quarters: 0.03125 },
  { name: '256th', quarters: 0.015625 },
  { name: '512th', quarters: 0.0078125 },
  { name: '1024th', quarters: 0.00390625 },
];

/** Dotted values MusicXML can express with a `<dot/>` after the type. */
const DOT_FACTORS = [1, 1.5, 1.75, 1.875] as const;

/**
 * Common tuplets. `actual` notes occupy the time of `normal` notes, so the
 * notated value is `base * normal / actual` (an eighth triplet is three in the
 * time of two eighths).
 */
const TUPLETS: readonly (readonly [number, number])[] = [
  [3, 2],
  [5, 2],
  [5, 4],
  [7, 4],
  [7, 8],
  [9, 8],
  [11, 8],
  [13, 8],
];

const SHARP_STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'] as const;
const SHARP_ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0] as const;
const FLAT_STEPS = ['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B'] as const;
const FLAT_ALTERS = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0] as const;

/** Major-key key signatures, indexed by pitch class. Minor keys use the relative major. */
const MAJOR_FIFTHS = [0, 7, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5] as const;

interface DrumNotation {
  readonly name: string;
  readonly midi: number;
  readonly step: string;
  readonly octave: number;
  readonly notehead?: string;
}

const DRUM_NOTATION: Readonly<Record<DrumName, DrumNotation>> = {
  kick: { name: 'Kick', midi: 36, step: 'F', octave: 4 },
  snare: { name: 'Snare', midi: 38, step: 'C', octave: 5 },
  clap: { name: 'Clap', midi: 39, step: 'E', octave: 5, notehead: 'x' },
  rim: { name: 'Rim', midi: 37, step: 'D', octave: 5, notehead: 'x' },
  hat: { name: 'Closed Hi-Hat', midi: 42, step: 'G', octave: 5, notehead: 'x' },
  openhat: { name: 'Open Hi-Hat', midi: 46, step: 'A', octave: 5, notehead: 'x' },
  tom: { name: 'Tom', midi: 45, step: 'A', octave: 4 },
  crash: { name: 'Crash', midi: 49, step: 'B', octave: 5, notehead: 'x' },
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Stable number text: no `-0`, no exponent, and no floating-point droppings. */
function numberText(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10000) / 10000;
  return rounded === 0 ? '0' : String(rounded);
}

function keyFifths(key: ScoreKey): number {
  const relativeMajor = key.mode === 'minor' ? (key.tonic + 3) % 12 : key.tonic;
  let fifths = MAJOR_FIFTHS[relativeMajor] ?? 0;
  // F# and Gb are enharmonic; honour the author's flat spelling when it fits.
  if (key.label.includes('b') && fifths > 0 && Math.abs(fifths - 12) <= 7) fifths -= 12;
  return fifths;
}

function instrumentNameOf(track: ScoreTrack): string {
  const waveform = WAVEFORM_NAMES[track.waveform] ?? 'chip';
  const instrument = track.instrument;
  if (instrument?.type === 'sample') {
    return `sample ${instrument.sample ?? ''}`.trim();
  }
  if (instrument === undefined) return `chip ${waveform}`;
  return instrument.type === 'chip' ? `chip ${waveform}` : instrument.type;
}

function noteTypeOf(steps: number, divisions: number): TypeReading {
  const quarters = steps / divisions;
  const epsilon = 1e-9;

  for (const base of NOTE_TYPES) {
    for (let dot = 0; dot < DOT_FACTORS.length; dot += 1) {
      if (Math.abs(quarters - base.quarters * DOT_FACTORS[dot]!) < epsilon) {
        return {
          type: base.name,
          ...(dot === 0 ? {} : { dots: dot }),
        };
      }
    }
  }
  for (const base of NOTE_TYPES) {
    for (const [actual, normal] of TUPLETS) {
      if (Math.abs(quarters - (base.quarters * normal) / actual) < epsilon) {
        return {
          type: base.name,
          timeModification: { actual, normal },
        };
      }
    }
  }
  // The duration remains authoritative even when no common note value fits.
  return {};
}

function typeXml(reading: TypeReading): string {
  if (reading.type === undefined) return '';
  const dots = '<dot/>'.repeat(reading.dots ?? 0);
  const time =
    reading.timeModification === undefined
      ? ''
      : `<time-modification><actual-notes>${reading.timeModification.actual}</actual-notes><normal-notes>${reading.timeModification.normal}</normal-notes></time-modification>`;
  return `<type>${reading.type}</type>${dots}${time}`;
}

function pitchXml(event: NoteEvent, preferFlats: boolean): string {
  const midi = Math.round(event.midi);
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const step = preferFlats ? (FLAT_STEPS[pitchClass] ?? 'C') : (SHARP_STEPS[pitchClass] ?? 'C');
  const writtenAlter = preferFlats ? (FLAT_ALTERS[pitchClass] ?? 0) : (SHARP_ALTERS[pitchClass] ?? 0);

  // MusicXML 3.1+ allows a fractional <alter>, so the score tuning survives as
  // a microtonal spelling instead of being flattened to 12-TET. A4=442, for
  // example, becomes +0.0785 on every written pitch.
  let cents = 0;
  if (Number.isFinite(event.frequency) && event.frequency > 0) {
    const equalTempered = 440 * 2 ** ((midi - 69) / 12);
    cents = 1200 * Math.log2(event.frequency / equalTempered);
  }
  let alter = writtenAlter + cents / 100;
  if (Math.abs(alter) < 0.0001) alter = 0;

  const alterXml = alter === 0 ? '' : `<alter>${numberText(alter)}</alter>`;
  return `<pitch><step>${step}</step>${alterXml}<octave>${octave}</octave></pitch>`;
}

function tieXml(segment: Segment): string {
  const ties: string[] = [];
  if (segment.tieStop) ties.push('<tie type="stop"/>');
  if (segment.tieStart) ties.push('<tie type="start"/>');
  return ties.join('');
}

function notationsXml(segment: Segment): string {
  const tied: string[] = [];
  if (segment.tieStop) tied.push('<tied type="stop"/>');
  if (segment.tieStart) tied.push('<tied type="start"/>');
  return tied.length === 0 ? '' : `<notations>${tied.join('')}</notations>`;
}

function noteXml(
  segment: Segment,
  options: {
    readonly chord: boolean;
    readonly divisions: number;
    readonly preferFlats: boolean;
    readonly instrumentId: string;
    readonly drum?: DrumNotation;
  },
): string {
  const event = segment.event;
  const duration = Math.max(1, segment.duration);
  const type = typeXml(noteTypeOf(duration, options.divisions));
  const chord = options.chord ? '<chord/>' : '';
  const commonHead = `<duration>${duration}</duration>${tieXml(segment)}<instrument id="${escapeXml(options.instrumentId)}"/><voice>1</voice>`;
  const notation = notationsXml(segment);

  if (options.drum !== undefined) {
    const notehead =
      options.drum.notehead === undefined ? '' : `<notehead>${options.drum.notehead}</notehead>`;
    return `<note>${chord}<unpitched><display-step>${options.drum.step}</display-step><display-octave>${options.drum.octave}</display-octave></unpitched>${commonHead}${type}${notehead}${notation}</note>`;
  }

  const pitch = pitchXml(event, options.preferFlats);
  return `<note>${chord}${pitch}${commonHead}${type}${notation}</note>`;
}

function restXml(
  duration: number,
  divisions: number,
  fullMeasure: boolean,
): string {
  const type = typeXml(noteTypeOf(duration, divisions));
  const rest = fullMeasure ? '<rest measure="yes"/>' : '<rest/>';
  return `<note>${rest}<duration>${duration}</duration><voice>1</voice>${type}</note>`;
}

/**
 * Splits one event at measure boundaries. The notated duration is the sounding
 * gate, capped at the authored slot: a staccato token leaves a rest inside its
 * slot, while a legato gate that outlasts its slot is written as the slot so
 * it never overlaps the next note in the same MusicXML voice. Notes that cross
 * a bar line become tied segments.
 */
function segmentsOf(
  score: Score,
  track: ScoreTrack,
  measureSteps: number,
  measureCount: number,
): Segment[][] {
  const byMeasure: Segment[][] = Array.from({ length: measureCount }, () => []);
  for (const event of timelineOf(score, track)) {
    if (event.step >= score.totalSteps) continue;
    const slot = Math.max(1, Math.min(event.steps, score.totalSteps - event.step));
    const gate = event.gateSteps ?? event.steps;
    const duration = Math.max(1, Math.min(slot, gate));

    let start = event.step;
    let remaining = duration;
    let first = true;
    while (remaining > 0) {
      const measure = Math.floor(start / measureSteps);
      if (measure >= measureCount) break;
      const measureStart = measure * measureSteps;
      const measureEnd = measureStart + measureSteps;
      const end = Math.min(start + remaining, measureEnd);
      const length = end - start;
      if (length <= 0) break;

      byMeasure[measure]?.push({
        event,
        start: start - measureStart,
        duration: length,
        tieStop: !first,
        tieStart: end < start + remaining,
      });
      remaining -= length;
      start = end;
      first = false;
    }
  }
  return byMeasure;
}

function measureBodyXml(
  segments: readonly Segment[],
  track: ScoreTrack,
  partIndex: number,
  measureSteps: number,
  divisions: number,
  preferFlats: boolean,
): string[] {
  if (segments.length === 0) {
    return [restXml(measureSteps, divisions, true)];
  }

  const sorted = [...segments].sort((a, b) => a.start - b.start || a.event.midi - b.event.midi);
  const lines: string[] = [];
  let cursor = 0;
  let index = 0;

  while (index < sorted.length) {
    const rawStart = sorted[index]!.start;
    const group: Segment[] = [];
    while (index < sorted.length && sorted[index]!.start === rawStart) {
      group.push(sorted[index]!);
      index += 1;
    }

    if (rawStart > cursor) {
      lines.push(restXml(rawStart - cursor, divisions, false));
    }
    // A malformed overlap must not produce notes outside the measure or an
    // invalid backwards timeline; clamp it forward instead of dropping it.
    const start = Math.max(cursor, rawStart);
    let groupEnd = start + 1;
    for (let voice = 0; voice < group.length; voice += 1) {
      const segment = group[voice]!;
      const drum = track.isDrums
        ? segment.event.drum === undefined
          ? undefined
          : DRUM_NOTATION[segment.event.drum]
        : undefined;
      const instrumentId = track.isDrums
        ? `P${partIndex + 1}-I${drum?.midi ?? segment.event.midi}`
        : `P${partIndex + 1}-I1`;
      const duration = Math.max(1, Math.min(segment.duration, measureSteps - start));
      const effective: Segment = duration === segment.duration ? segment : { ...segment, duration };
      lines.push(
        noteXml(effective, {
          chord: voice > 0,
          divisions,
          preferFlats,
          instrumentId,
          ...(drum === undefined ? {} : { drum }),
        }),
      );
      groupEnd = Math.max(groupEnd, start + duration);
    }
    cursor = groupEnd;
  }

  if (cursor < measureSteps) {
    lines.push(restXml(measureSteps - cursor, divisions, false));
  }
  return lines;
}

function partListEntryXml(
  track: ScoreTrack,
  partIndex: number,
  drums: readonly DrumNotation[],
): string[] {
  const partId = `P${partIndex + 1}`;
  const lines = [
    `    <score-part id="${partId}">`,
    `      <part-name>${escapeXml(track.name)}</part-name>`,
  ];

  if (track.isDrums) {
    // MusicXML groups every score-instrument before every midi-instrument.
    for (const drum of drums) {
      const id = `${partId}-I${drum.midi}`;
      lines.push(
        `      <score-instrument id="${id}">`,
        `        <instrument-name>${escapeXml(drum.name)}</instrument-name>`,
        `      </score-instrument>`,
      );
    }
    for (const drum of drums) {
      const id = `${partId}-I${drum.midi}`;
      lines.push(
        `      <midi-instrument id="${id}">`,
        `        <midi-channel>10</midi-channel>`,
        `        <midi-unpitched>${drum.midi}</midi-unpitched>`,
        `      </midi-instrument>`,
      );
    }
  } else {
    const id = `${partId}-I1`;
    const channel = ((partIndex % 15) + 1) === 10 ? 11 : (partIndex % 15) + 1;
    lines.push(
      `      <score-instrument id="${id}">`,
      `        <instrument-name>${escapeXml(instrumentNameOf(track))}</instrument-name>`,
      `      </score-instrument>`,
      `      <midi-instrument id="${id}">`,
      `        <midi-channel>${channel}</midi-channel>`,
      `        <midi-program>1</midi-program>`,
      `      </midi-instrument>`,
    );
  }

  lines.push('    </score-part>');
  return lines;
}

function attributesXml(score: Score, track: ScoreTrack, divisions: number): string[] {
  const clef = track.isDrums
    ? '<clef><sign>percussion</sign><line>2</line></clef>'
    : track.role === 'bass'
      ? '<clef><sign>F</sign><line>4</line></clef>'
      : '<clef><sign>G</sign><line>2</line></clef>';
  const key =
    score.key === undefined
      ? ''
      : `<key><fifths>${keyFifths(score.key)}</fifths><mode>${score.key.mode}</mode></key>`;
  return [
    '      <attributes>',
    `        <divisions>${divisions}</divisions>`,
    ...(key === '' ? [] : [`        ${key}`]),
    `        <time><beats>${score.beatsPerBar}</beats><beat-type>4</beat-type></time>`,
    `        ${clef}`,
    '      </attributes>',
  ];
}

function directionXml(bpm: number, label?: string): string[] {
  const rehearsal =
    label === undefined
      ? ''
      : `<direction-type><rehearsal>${escapeXml(label)}</rehearsal></direction-type>`;
  return [
    '      <direction placement="above">',
    ...(rehearsal === '' ? [] : [`        ${rehearsal}`]),
    `        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${numberText(bpm)}</per-minute></metronome></direction-type>`,
    `        <sound tempo="${numberText(bpm)}"/>`,
    '      </direction>',
  ];
}

function sectionMeasures(score: Score, measureSteps: number): Map<number, ScoreSection> {
  const result = new Map<number, ScoreSection>();
  for (const section of score.sections) {
    result.set(Math.floor(section.startStep / measureSteps), section);
  }
  return result;
}

function trackDrumsOf(score: Score, track: ScoreTrack): DrumNotation[] {
  const used = new Set<DrumName>();
  for (const event of timelineOf(score, track)) {
    if (event.drum !== undefined) used.add(event.drum);
  }
  return [...used]
    .map((name) => DRUM_NOTATION[name])
    .sort((a, b) => a.midi - b.midi);
}

/**
 * Serialise one normalised score as a MusicXML 4.0 partwise document. The loop
 * is written once (`totalSteps`); songs are written on their absolute timeline,
 * including section tempo changes and rehearsal names.
 */
export function musicXmlOf(score: Score, options: MusicXmlOptions = {}): string {
  const divisions = score.stepsPerBeat;
  const measureSteps = Math.max(1, score.stepsPerBeat * score.beatsPerBar);
  const measureCount = Math.max(1, Math.ceil(score.totalSteps / measureSteps));
  const preferFlats = score.key !== undefined && keyFifths(score.key) < 0;
  const sectionAtMeasure = sectionMeasures(score, measureSteps);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
  ];

  if (options.title !== undefined && options.title.trim() !== '') {
    lines.push(
      '  <work>',
      `    <work-title>${escapeXml(options.title)}</work-title>`,
      '  </work>',
    );
  }
  lines.push(
    '  <identification>',
    '    <encoding>',
    '      <software>pico8-music</software>',
    '    </encoding>',
    '  </identification>',
    '  <part-list>',
  );

  score.tracks.forEach((track, partIndex) => {
    lines.push(...partListEntryXml(track, partIndex, trackDrumsOf(score, track)));
  });
  lines.push('  </part-list>');

  score.tracks.forEach((track, partIndex) => {
    const segments = segmentsOf(score, track, measureSteps, measureCount);
    lines.push(`  <part id="P${partIndex + 1}">`);

    for (let measure = 0; measure < measureCount; measure += 1) {
      lines.push(`    <measure number="${measure + 1}">`);
      if (measure === 0) lines.push(...attributesXml(score, track, divisions));

      // Tempo is a global direction; one part is enough and avoids duplicate
      // metronome marks in importers that merge parts.
      if (partIndex === 0) {
        const section = sectionAtMeasure.get(measure);
        if (section !== undefined) {
          lines.push(...directionXml(section.bpm, section.name));
        } else if (measure === 0 && score.sections.length === 0) {
          lines.push(...directionXml(score.bpm));
        }
      }

      lines.push(
        ...measureBodyXml(
          segments[measure] ?? [],
          track,
          partIndex,
          measureSteps,
          divisions,
          preferFlats,
        ),
      );
      lines.push('    </measure>');
    }

    lines.push('  </part>');
  });

  lines.push('</score-partwise>', '');
  return lines.join('\n');
}
