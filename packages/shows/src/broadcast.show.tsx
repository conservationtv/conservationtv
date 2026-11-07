import type { FC } from 'react';
import { Color, Frame, Layer, Scene, Show, Text } from '@strangecyan/vignette';

import { Clock } from './clock.frame.tsx';
import { CtvStream } from './ctv-stream.ts';

// An organisation's broadcast: up to six cameras on a grid of thirds, one double size in the top right, three down the
// left and two below the big one, filled in that order with the streams the studio API chooses (src/shows in the studio
// API), the rest left black; or a note that there is nothing to show. Each camera has its stream's name centred across
// its top, outlined in black, and a clock in Central Time sits in the top right corner, both set in Nunito
// (`assets/fonts/Nunito.woff2`, from the bundle `vignette bundle` builds beside the clock's page). A show is a pure
// function of its state: it is composed afresh for each change, in a Durable Object that hibernates between them, so it
// holds no state and starts nothing (the lint rules for `*.show.tsx` refuse hooks and timers); the clock keeps time in
// its own page.

/** A camera: which exposure of which stream to watch, and the stream's name to label it with. */
export interface BroadcastCamera {
  organisationId: string;
  streamId: string;
  exposureId: string;
  name: string;
}

/** Everything the broadcast is composed from. */
export interface BroadcastState {
  /** The cameras, in slot order (the big one, then down the left, then along the bottom): at most six, maybe none. */
  cameras: BroadcastCamera[];
}

/** The broadcast's frame, and each stream's: every slot is the same shape, so a stream fills one. */
const CANVAS = { width: 1920, height: 1080 };

const FILL = { position: 'absolute', width: '100%', height: '100%' } as const;

/** The font the broadcast's text is set in: an asset of the show's bundle. */
const FONT = 'fonts/Nunito.woff2';

/** The zone the clock reads, Central Time. */
const CLOCK_TIME_ZONE = 'America/Chicago';

/** Where the clock sits: the top right corner, over the big camera's label. */
const CLOCK_PLACEMENT = { position: 'absolute', top: 0, right: 0, width: 480, height: 96 } as const;

/** A label's height, type size and outline width in a one-cell slot; a bigger slot scales them by its span. */
const LABEL_HEIGHT = 48;
const LABEL_FONT_SIZE = 26;
const LABEL_OUTLINE = 2;

/** The eight directions a label's outline is drawn in, as unit offsets. */
const OUTLINE_DIRECTIONS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
] as const;

/**
 * A black outline `width` pixels thick, as text shadows: text has no stroke the targets all render, so a hard-edged
 * shadow in each of eight directions draws one around every letter.
 */
function outline(width: number): string {
  return OUTLINE_DIRECTIONS.map(([x, y]) => `${String(x * width)}px ${String(y * width)}px 0 #000000`).join(', ');
}

/** One cell of the grid of thirds: 640 by 360, the canvas's shape a third the size. */
const CELL = { width: CANVAS.width / 3, height: CANVAS.height / 3 };

/** A slot on the grid: its column and row, from the top left, and how many cells it spans each way. */
interface Slot {
  column: number;
  row: number;
  span: number;
}

/**
 *   ┌───┬───────┐
 *   │ 2 │       │
 *   ├───┤   1   │
 *   │ 3 │       │
 *   ├───┼───┬───┤
 *   │ 4 │ 5 │ 6 │
 *   └───┴───┴───┘
 *
 * The slots, in the order cameras fill them: the big one, the three down the left, then the two below the big one.
 */
const SLOTS: readonly Slot[] = [
  { column: 1, row: 0, span: 2 },
  { column: 0, row: 0, span: 1 },
  { column: 0, row: 1, span: 1 },
  { column: 0, row: 2, span: 1 },
  { column: 1, row: 2, span: 1 },
  { column: 2, row: 2, span: 1 }
];

/** How many cameras the broadcast has room for: one per slot. */
export const BROADCAST_CAMERAS = SLOTS.length;

/** Where the slot at `index` sits on the canvas. */
function placement(index: number) {
  const slot = SLOTS[index % SLOTS.length]!;
  return {
    position: 'absolute',
    left: slot.column * CELL.width,
    top: slot.row * CELL.height,
    width: slot.span * CELL.width,
    height: slot.span * CELL.height
  } as const;
}

export interface BroadcastProps {
  state: BroadcastState;
}

/** The broadcast: black, with a camera in each slot it has one for, or the note in their place. */
export const Broadcast: FC<BroadcastProps> = ({ state }) => {
  const cameras = state.cameras.slice(0, BROADCAST_CAMERAS);
  return (
    <Show id="broadcast" canvas={CANVAS}>
      <Scene id="main">
        <Layer id="background" style={FILL}>
          <Color color="#000000" />
        </Layer>
        {cameras.length === 0 ? (
          <Layer id="no-streams" style={FILL}>
            <Text
              text="No streams to show"
              style={{ fontSize: 72, color: '#ffffff', textAlign: 'center', verticalAlign: 'middle' }}
            />
          </Layer>
        ) : (
          cameras.map((camera, index) => <CameraSlot key={camera.streamId} camera={camera} index={index} />)
        )}
        <Layer id="clock" style={CLOCK_PLACEMENT}>
          <Frame of={Clock} params={{ timeZone: CLOCK_TIME_ZONE }} />
        </Layer>
      </Scene>
    </Show>
  );
};

interface CameraSlotProps {
  camera: BroadcastCamera;
  index: number;
}

/**
 * One camera in its slot, with its stream's name across its top. Its layers and sources are named for its stream, so a
 * stream that moves to another slot keeps playing where it moved, at its new size, rather than its player being
 * replaced. The label is the name centred across the top, white with a black outline, sized for the slot.
 */
const CameraSlot: FC<CameraSlotProps> = ({ camera, index }) => {
  const id = `camera-${camera.streamId}`;
  const span = SLOTS[index % SLOTS.length]!.span;
  const labelHeight = LABEL_HEIGHT * span;
  return (
    <Layer id={`slot-${camera.streamId}`} style={placement(index)}>
      <Layer id={id} style={FILL} fit="cover">
        <CtvStream
          id={id}
          organisationId={camera.organisationId}
          streamId={camera.streamId}
          exposureId={camera.exposureId}
          size={CANVAS}
        />
      </Layer>
      <Layer
        id={`label-${camera.streamId}`}
        style={{ position: 'absolute', top: 0, left: 16 * span, right: 16 * span, height: labelHeight }}
      >
        <Text
          text={camera.name}
          font={FONT}
          style={{
            fontFamily: 'Nunito',
            fontWeight: 700,
            fontSize: LABEL_FONT_SIZE * span,
            color: '#ffffff',
            textShadow: outline(LABEL_OUTLINE * span),
            textAlign: 'center',
            verticalAlign: 'middle',
            textWrap: 'nowrap',
            maxLines: 1
          }}
        />
      </Layer>
    </Layer>
  );
};
