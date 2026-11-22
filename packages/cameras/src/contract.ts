import { z } from 'zod';

// The contract cameras are controlled by, whatever kind they are: what a camera can do (its capabilities), where it
// points (its position), and the commands it takes. A driver (control/) translates it to one kind of camera; the agent
// that reaches the camera serves it over iroh (apps/agent/core/src/cameras), and the studio builds its controls from
// it. A camera that cannot move is one whose capabilities list no moves: there is no separate kind for it.
//
// Units are the contract's, the same for every camera, and each driver converts:
//
//   pan, tilt     degrees: pan positive to the right, tilt positive upwards;
//   zoom, focus   a fraction of the camera's range, 0 (widest, nearest) to 1;
//   point, region fractions of the picture, from its top left corner;
//   drive         a velocity on each axis, -1 to 1, as a fraction of the camera's fastest.

const DegreesSchema = z.number().min(-360).max(360);
export type Degrees = z.output<typeof DegreesSchema>;
const FractionSchema = z.number().min(0).max(1);
export type Fraction = z.output<typeof FractionSchema>;
const VelocitySchema = z.number().min(-1).max(1);
export type Velocity = z.output<typeof VelocitySchema>;

/** Where a camera points, on each axis it has and reports. */
export const CameraPositionSchema = z
  .strictObject({
    pan: DegreesSchema.optional(),
    tilt: DegreesSchema.optional(),
    zoom: FractionSchema.optional(),
    focus: FractionSchema.optional()
  })
  .describe(
    'Where a camera points: `pan` and `tilt` in degrees, `zoom` and `focus` as a fraction of its range, each only when the camera has that axis.'
  );
export type CameraPosition = z.output<typeof CameraPositionSchema>;

/** The ways a camera can be moved. */
export const CAMERA_MOVES = ['absolute', 'relative', 'point', 'region', 'continuous'] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

/** How far an axis travels, in degrees. */
const RangeSchema = z.object({ min: z.number(), max: z.number() });
export type Range = z.output<typeof RangeSchema>;

/** Something of the camera's own that is set to one of a few values, such as its IR cut filter. */
const CameraOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  values: z.array(z.string()).min(1)
});
export type CameraOption = z.output<typeof CameraOptionSchema>;

/** Something the camera does when asked, with nothing to set, such as running its wiper. */
const CameraActionSchema = z.object({ name: z.string(), label: z.string() });
export type CameraAction = z.output<typeof CameraActionSchema>;

/** What a camera can do, as it says itself: what the studio builds its controls from. */
export const CameraCapabilitiesSchema = z
  .object({
    moves: z.array(z.enum(CAMERA_MOVES)),
    pan: RangeSchema.optional(),
    tilt: RangeSchema.optional(),
    zoom: z.boolean(),
    focus: z.boolean(),
    options: z.array(CameraOptionSchema),
    actions: z.array(CameraActionSchema)
  })
  .describe(
    'What the camera can do: the `moves` it takes, how far it pans and tilts in degrees, whether it zooms and focuses, the `options` it has with the values each takes, and the `actions` it runs. A camera that cannot move lists no moves.'
  );
export type CameraCapabilities = z.output<typeof CameraCapabilitiesSchema>;

/** A camera with nothing to control: a fixed one, or one whose driver only reads its stream. */
export const NO_CAPABILITIES: CameraCapabilities = { moves: [], zoom: false, focus: false, options: [], actions: [] };

/** What a camera's options are set to now, by key. */
export const CameraOptionValuesSchema = z.record(z.string(), z.string());
export type CameraOptionValues = z.output<typeof CameraOptionValuesSchema>;

const MoveToSchema = z.strictObject({
  kind: z.literal('moveTo'),
  pan: DegreesSchema.optional(),
  tilt: DegreesSchema.optional(),
  zoom: FractionSchema.optional(),
  focus: FractionSchema.optional()
});
export type MoveTo = z.output<typeof MoveToSchema>;

const MoveBySchema = z.strictObject({
  kind: z.literal('moveBy'),
  pan: DegreesSchema.optional(),
  tilt: DegreesSchema.optional(),
  zoom: z.number().min(-1).max(1).optional()
});
export type MoveBy = z.output<typeof MoveBySchema>;

const MoveToPointSchema = z.strictObject({ kind: z.literal('moveToPoint'), x: FractionSchema, y: FractionSchema });
export type MoveToPoint = z.output<typeof MoveToPointSchema>;

const MoveToRegionSchema = z.strictObject({
  kind: z.literal('moveToRegion'),
  x: FractionSchema,
  y: FractionSchema,
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1)
});
export type MoveToRegion = z.output<typeof MoveToRegionSchema>;

const DriveSchema = z.strictObject({
  kind: z.literal('drive'),
  pan: VelocitySchema.optional(),
  tilt: VelocitySchema.optional(),
  zoom: VelocitySchema.optional(),
  focus: VelocitySchema.optional()
});
export type Drive = z.output<typeof DriveSchema>;

const StopSchema = z.strictObject({ kind: z.literal('stop') });
export type Stop = z.output<typeof StopSchema>;

const ConfigureSchema = z.strictObject({
  kind: z.literal('configure'),
  key: z.string().min(1).max(120),
  value: z.string().max(120)
});
export type Configure = z.output<typeof ConfigureSchema>;

const RunSchema = z.strictObject({ kind: z.literal('run'), action: z.string().min(1).max(120) });
export type Run = z.output<typeof RunSchema>;

/**
 * One thing a camera is told to do. `drive` keeps the camera moving only while it is repeated: the agent stops a
 * camera whose driver goes quiet, so a lost connection never leaves it turning.
 */
export const CameraCommandSchema = z
  .discriminatedUnion('kind', [
    MoveToSchema,
    MoveBySchema,
    MoveToPointSchema,
    MoveToRegionSchema,
    DriveSchema,
    StopSchema,
    ConfigureSchema,
    RunSchema
  ])
  .describe(
    'A command, by `kind`: `moveTo` a position, `moveBy` an offset, `moveToPoint` or `moveToRegion` of the picture, `drive` at a velocity on each axis (repeated while it should keep moving), `stop`, `configure` one of its options, or `run` one of its actions.'
  );
export type CameraCommand = z.output<typeof CameraCommandSchema>;

/** The move a command needs the camera to take, if it is one. */
export function moveOf(command: CameraCommand): CameraMove | undefined {
  switch (command.kind) {
    case 'moveTo':
      return 'absolute';
    case 'moveBy':
      return 'relative';
    case 'moveToPoint':
      return 'point';
    case 'moveToRegion':
      return 'region';
    case 'drive':
    case 'stop':
      return 'continuous';
    case 'configure':
    case 'run':
      return undefined;
  }
}
