import { Type } from 'typebox';

/**
 * One declaration per tool, shared by the Pi (TypeBox) and DSH (raw JSON
 * Schema) adapters. TypeBox objects serialise to plain JSON Schema, so having
 * a single source here removes the range drift the two adapters used to have.
 */
export const helpParameters = Type.Object({}, { additionalProperties: false });

export const exportParameters = Type.Object(
  {
    score: Type.Optional(
      Type.String({
        description:
          'inline JSON score string (composition only); provide this or scoreFile, not both; call p8_help for the DSL',
      }),
    ),
    scoreFile: Type.Optional(
      Type.String({
        description:
          'workspace-relative path to a JSON score file (.json is appended when omitted); provide this or score, not both',
      }),
    ),
    out: Type.Optional(
      Type.String({
        description:
          'workspace-relative output path ending in .musicxml (uncompressed MusicXML); default pico8-music.musicxml',
      }),
    ),
  },
  { additionalProperties: false },
);

const targetProfile = Type.Object(
  {
    lowMidMax: Type.Optional(
      Type.Number({ minimum: 0, maximum: 1, description: 'maximum 150-500 Hz share' }),
    ),
    harshMax: Type.Optional(
      Type.Number({ minimum: 0, maximum: 1, description: 'maximum 2-5 kHz share' }),
    ),
    crestMin: Type.Optional(
      Type.Number({ description: 'minimum peak-minus-RMS crest in dB' }),
    ),
    truePeakMax: Type.Optional(
      Type.Number({ description: 'maximum 4x-oversampled true peak in dBTP' }),
    ),
    width: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] side/mid RMS ratio',
      }),
    ),
    correlation: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] L/R waveform correlation, -1..1',
      }),
    ),
    balanceMax: Type.Optional(
      Type.Number({ description: 'maximum absolute left/right RMS difference in dB' }),
    ),
    lufs: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] integrated loudness',
      }),
    ),
    centroidHz: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] spectrum centroid in Hz',
      }),
    ),
  },
  { additionalProperties: false },
);

const target = Type.Optional(
  Type.Union(
    [
      Type.Literal('soft'),
      Type.Literal('clear'),
      Type.Literal('punchy'),
      Type.Literal('bright'),
      Type.Literal('dark'),
      Type.Literal('lofi'),
      Type.Literal('hitech'),
      targetProfile,
    ],
    {
      description:
        'optional profile name or inline ranges; findings then name deviations from the declared target, without a total score',
    },
  ),
);

const sectionInput = Type.Object(
  {
    name: Type.String({ minLength: 1, description: 'section label shown in the report' }),
    startSeconds: Type.Number({
      minimum: 0,
      description: 'start time in output-file seconds, after any tape/slow resampling',
    }),
    durationSeconds: Type.Optional(
      Type.Number({
        minimum: 0.001,
        description: 'duration in seconds; omitted runs to the next section, and the last to contentSeconds',
      }),
    ),
  },
  { additionalProperties: false },
);

const assertProfile = Type.Object(
  {
    peakMaxDb: Type.Optional(Type.Number({ description: 'maximum sample peak, dBFS' })),
    truePeakMaxDb: Type.Optional(Type.Number({ description: 'maximum 4x-oversampled true peak, dBTP' })),
    rmsDb: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] integrated RMS, dBFS',
      }),
    ),
    lufs: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] integrated loudness, LUFS',
      }),
    ),
    lra: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] loudness range, LU',
      }),
    ),
    crest: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] peak-minus-RMS crest, dB',
      }),
    ),
    width: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] side/mid RMS ratio',
      }),
    ),
    correlation: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed [min, max] L/R waveform correlation, -1..1',
      }),
    ),
    balanceMaxDb: Type.Optional(
      Type.Number({ description: 'maximum absolute left/right RMS difference, dB' }),
    ),
    sectionLevelSpreadDb: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed max-minus-min section RMS, dB; requires at least two sections',
      }),
    ),
    sectionRmsDb: Type.Optional(
      Type.Array(Type.Number(), {
        minItems: 2,
        maxItems: 2,
        description: 'allowed RMS for every measured section, dBFS',
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'optional hard ranges; any miss makes the tool call fail, unlike target which only reports deviations',
  },
);

export const analyzeParameters = Type.Object(
  {
    path: Type.String({
      description: 'workspace-relative path to a 16-bit PCM WAV, usually a previous p8_music output',
    }),
    detail: Type.Optional(
      Type.Union([Type.Literal('summary'), Type.Literal('raw')], {
        description:
          'summary (default) or raw: write the complete analysis to a sibling .analysis.json and return its path',
      }),
    ),
    sections: Type.Optional(
      Type.Array(sectionInput, {
        description:
          'optional section boundaries in output-file seconds; omit durationSeconds to run to the next start',
      }),
    ),
    contentSeconds: Type.Optional(
      Type.Number({
        minimum: 0.001,
        description:
          'musical content length for section mapping; excludes a rendered tail when shorter than the file',
      }),
    ),
    target,
    assert: Type.Optional(
      assertProfile,
    ),
  },
  { additionalProperties: false },
);

export const probeParameters = Type.Object(
  {
    score: Type.Optional(
      Type.String({
        description:
          'inline JSON score string (composition only); provide this or scoreFile, not both; the probe reads the selected track instrument',
      }),
    ),
    scoreFile: Type.Optional(
      Type.String({
        description:
          'workspace-relative path to a JSON score file (.json is appended when omitted); provide this or score, not both',
      }),
    ),
    track: Type.Optional(
      Type.String({
        description:
          'melodic track name to probe; omitted uses the first non-drum track',
      }),
    ),
    note: Type.Optional(
      Type.String({
        description: 'fixed note name such as A4, C3 or F#2; default A4',
      }),
    ),
    volume: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 7,
        description: 'fixed velocity 0-7; default 5',
      }),
    ),
    seconds: Type.Optional(
      Type.Number({
        minimum: 0.25,
        maximum: 4,
        description: 'gate length in seconds; default 1.5',
      }),
    ),
    quality: Type.Optional(
      Type.Union([Type.Literal('pico'), Type.Literal('clean')], {
        description: 'oscillator precision; default pico or the style default',
      }),
    ),
    style: Type.Optional(
      Type.Union(
        [
          Type.Literal('chip'),
          Type.Literal('hitech'),
          Type.Literal('ambient'),
          Type.Literal('studio'),
          Type.Literal('lofi'),
          Type.Literal('soft'),
        ],
        {
          description:
            'style role instrument defaults, matching the p8_music render; explicit track.instrument wins',
        },
      ),
    ),
    bypassFilter: Type.Optional(
      Type.Boolean({
        description:
          'measure the source without the instrument filter; default false',
      }),
    ),
    sensitivity: Type.Optional(
      Type.Boolean({
        description:
          'render a few parameter variants and report measured deltas; default true',
      }),
    ),
    detail: Type.Optional(
      Type.Union([Type.Literal('summary'), Type.Literal('raw')], {
        description:
          'summary (default) or raw: write the full probe reading to a sibling .json artifact',
      }),
    ),
    out: Type.Optional(
      Type.String({
        description:
          'workspace-relative .json path for detail:raw; default p8-probe.json',
      }),
    ),
  },
  { additionalProperties: false },
);

const postStep = Type.Object(
  {
    type: Type.Union([
      Type.Literal('tape'),
      Type.Literal('slow'),
      Type.Literal('lowpass'),
      Type.Literal('highpass'),
      Type.Literal('highShelf'),
      Type.Literal('reverb'),
      Type.Literal('tilt'),
      Type.Literal('saturate'),
      Type.Literal('compress'),
      Type.Literal('loudness'),
      Type.Literal('limiter'),
    ]),
    speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 1.5 })),
    cutoffHz: Type.Optional(Type.Number({ minimum: 100, maximum: 22050 })),
    /** 1 = 6 dB/oct, 2 = 12 dB/oct, 4 = 24 dB/oct (lowpass only). */
    order: Type.Optional(
      Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(4)], {
        description: 'lowpass slope: 1 = 6 dB/oct, 2 = 12 dB/oct, 4 = 24 dB/oct',
      }),
    ),
    highpassHz: Type.Optional(Type.Number({ minimum: 20, maximum: 500 })),
    toneHz: Type.Optional(Type.Number({ minimum: 100, maximum: 22050 })),
    hz: Type.Optional(
      Type.Number({ minimum: 20, maximum: 20000, description: 'highShelf corner in Hz' }),
    ),
    gainDb: Type.Optional(
      Type.Number({ minimum: -24, maximum: 24, description: 'highShelf gain in dB' }),
    ),
    wet: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    room: Type.Optional(Type.Number({ minimum: 0, maximum: 0.98 })),
    damp: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    tiltDb: Type.Optional(Type.Number({ minimum: -12, maximum: 12 })),
    drive: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    mix: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    thresholdDb: Type.Optional(Type.Number({ minimum: -60, maximum: 0 })),
    ratio: Type.Optional(Type.Number({ minimum: 1, maximum: 40 })),
    attack: Type.Optional(Type.Number({ minimum: 0.0005, maximum: 1 })),
    release: Type.Optional(Type.Number({ minimum: 0.01, maximum: 2 })),
    makeupDb: Type.Optional(Type.Number({ minimum: -12, maximum: 24 })),
    targetLufs: Type.Optional(Type.Number({ minimum: -40, maximum: -5 })),
    ceilingDb: Type.Optional(Type.Number({ minimum: -12, maximum: 0 })),
    predelayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
    lowCutHz: Type.Optional(Type.Number({ minimum: 20, maximum: 1000 })),
    highCutHz: Type.Optional(Type.Number({ minimum: 1000, maximum: 20000 })),
    modDepth: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    modRateHz: Type.Optional(Type.Number({ minimum: 0.05, maximum: 5 })),
  },
  { additionalProperties: false },
);

export const musicParameters = Type.Object(
  {
    score: Type.Optional(
      Type.String({
        description:
          'inline JSON score string (composition only); provide this or scoreFile, not both; call p8_help for the DSL',
      }),
    ),
    scoreFile: Type.Optional(
      Type.String({
        description:
          'workspace-relative path to a JSON score file (.json is appended when omitted); provide this or score, not both',
      }),
    ),
    preset: Type.Optional(
      Type.Union([Type.Literal('classic'), Type.Literal('dreamy'), Type.Literal('tape')], {
        description: 'post preset (default classic); cannot be combined with style',
      }),
    ),
    style: Type.Optional(
      Type.Union(
        [
          Type.Literal('chip'),
          Type.Literal('hitech'),
          Type.Literal('ambient'),
          Type.Literal('studio'),
          Type.Literal('lofi'),
          Type.Literal('soft'),
        ],
        {
          description:
            'sound defaults: dry chip, glued hitech, slowed ambient, non-chip studio, warm lofi, clean slow-attack soft',
        },
      ),
    ),
    quality: Type.Optional(
      Type.Union([Type.Literal('pico'), Type.Literal('clean')], {
        description:
          'pico keeps the direct-form chip output; clean band-limits saw/pulse and limits FM sidebands; style default',
      }),
    ),
    post: Type.Optional(
      Type.Array(postStep, {
        description: 'explicit post chain; [] renders dry; omit to use the style or preset',
      }),
    ),
    speed: Type.Optional(
      Type.Number({
        minimum: 0.5,
        maximum: 1.5,
        description: 'tape speed; default comes from the preset or post',
      }),
    ),
    wet: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 1,
        description:
          'reverb dry/wet mix 0-1 (the wet path sits ~5 dB under the dry, so 0.3 is light); default comes from the preset or post',
      }),
    ),
    toneHz: Type.Optional(
      Type.Number({
        minimum: 100,
        maximum: 22050,
        description: 'low-pass cutoff; default comes from the preset or post',
      }),
    ),
    width: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 2,
        description: 'master side gain after the post chain: 0 mono, 1 unchanged, 2 wide',
      }),
    ),
    monoBelowHz: Type.Optional(
      Type.Number({
        minimum: 20,
        maximum: 500,
        description: 'fold everything below this frequency to mono; omitted means no fold',
      }),
    ),
    target,
    assert: Type.Optional(
      assertProfile,
    ),
    minutes: Type.Optional(
      Type.Number({
        minimum: 0.05,
        maximum: 15,
        description: 'loop output length in minutes, default 2; ignored in song mode',
      }),
    ),
    out: Type.Optional(
      Type.String({ description: 'workspace-relative output .wav path; default pico8-music.wav' }),
    ),
    detail: Type.Optional(
      Type.Union([Type.Literal('summary'), Type.Literal('raw')], {
        description:
          'summary (default) or raw: write the complete render report, including stems and dry facts, to a sibling .analysis.json',
      }),
    ),
  },
  { additionalProperties: false },
);

/** JSON-safe schema node after TypeBox metadata is removed. */
type PlainSchema = Record<string, unknown>;

/**
 * DSH reads parameters through a lossless-JSON boundary. TypeBox keeps a
 * non-enumerable `~kind` tag on every node, so the raw schema must be detached
 * first. DSH also supports only its raw-schema subset: TypeBox's `anyOf` (the
 * literal unions here never overlap) maps to `oneOf`, and range keywords are
 * dropped because the render service clamps those values to their documented
 * bounds at execution.
 */
const DSH_SCHEMA_KEYS = new Set([
  'type',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

function toDshNode(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;

  const node: PlainSchema = {};
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(child)) {
      node.oneOf = child.map(toDshNode);
    } else if (key === 'items') {
      node.items = toDshNode(child);
    } else if (key === 'properties' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
      node.properties = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, toDshNode(schema)]),
      );
    } else if (DSH_SCHEMA_KEYS.has(key)) {
      node[key] = child;
    }
  }
  return node;
}

/** Project one TypeBox declaration onto the JSON Schema DSH accepts. */
export function dshParameters(schema: unknown): PlainSchema {
  const detached: unknown = JSON.parse(JSON.stringify(schema));
  const projected = toDshNode(detached);
  if (projected === null || typeof projected !== 'object' || Array.isArray(projected)) {
    throw new Error('tool parameters must project to a JSON Schema object');
  }
  return projected as PlainSchema;
}
