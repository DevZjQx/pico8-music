import { Type } from 'typebox';

/**
 * One declaration per tool, shared by the Pi (TypeBox) and DSH (raw JSON
 * Schema) adapters. TypeBox objects serialise to plain JSON Schema, so having
 * a single source here removes the range drift the two adapters used to have.
 */
export const helpParameters = Type.Object({}, { additionalProperties: false });

export const analyzeParameters = Type.Object(
  {
    path: Type.String({
      description: 'workspace-relative path to a 16-bit PCM WAV, usually a previous p8_music output',
    }),
  },
  { additionalProperties: false },
);

const postStep = Type.Object(
  {
    type: Type.Union([
      Type.Literal('tape'),
      Type.Literal('slow'),
      Type.Literal('lowpass'),
      Type.Literal('reverb'),
      Type.Literal('tilt'),
      Type.Literal('saturate'),
      Type.Literal('compress'),
      Type.Literal('loudness'),
      Type.Literal('limiter'),
    ]),
    speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 1.5 })),
    cutoffHz: Type.Optional(Type.Number({ minimum: 100, maximum: 22050 })),
    toneHz: Type.Optional(Type.Number({ minimum: 100, maximum: 22050 })),
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
        ],
        {
          description:
            'sound defaults: dry chip, glued hitech, slowed ambient, non-chip studio, warm lofi',
        },
      ),
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
        description: 'reverb send; default comes from the preset or post',
      }),
    ),
    toneHz: Type.Optional(
      Type.Number({
        minimum: 100,
        maximum: 22050,
        description: 'low-pass cutoff; default comes from the preset or post',
      }),
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
  },
  { additionalProperties: false },
);

/** JSON-safe schema node after TypeBox metadata is removed. */
type PlainSchema = Record<string, unknown>;

/**
 * DSH reads parameters through a lossless-JSON boundary. TypeBox keeps a
 * non-enumerable `~kind` tag on every node, so the raw schema must be detached
 * first. DSH also supports only its raw-schema subset: TypeBox's `anyOf` (the
 * literal unions here never overlap) maps to `oneOf`, and range keywords such
 * as `minimum` are dropped because the service validates them at execution.
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
