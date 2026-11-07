import type { FC } from 'react';
import { Color, Layer, Scene, Show, Text } from '@strangecyan/vignette';

import { CtvStream } from './ctv-stream.ts';

// An organisation's broadcast: up to six cameras on a grid of thirds, one double size in the top right, three down the
// left and two below the big one, filled in that order with the streams the studio API chooses (src/shows in the
// studio API), the rest left black; or a note that there is nothing to show. A show is a pure
// function of its state: it is composed afresh for each change, in a Durable Object that hibernates between them, so
// it holds no state and starts nothing (the lint rules for `*.show.tsx` refuse hooks and timers).

/** A camera: which exposure of which stream to watch. */
export interface BroadcastCamera {
  organisationId: string;
  streamId: string;
  exposureId: string;
}

/** Everything the broadcast is composed from. */
export interface BroadcastState {
  /** The cameras, in slot order (the big one, then down the left, then along the bottom): at most six, maybe none. */
  cameras: BroadcastCamera[];
}

/** The broadcast's frame, and each stream's: every slot is the same shape, so a stream fills one. */
const CANVAS = { width: 1920, height: 1080 };

const FILL = { position: 'absolute', width: '100%', height: '100%' } as const;

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
      </Scene>
    </Show>
  );
};

interface CameraSlotProps {
  camera: BroadcastCamera;
  index: number;
}

/**
 * One camera in its slot. Its layer and source are named for its stream, so a stream that moves to another slot keeps
 * playing where it moved, at its new size, rather than its player being replaced.
 */
const CameraSlot: FC<CameraSlotProps> = ({ camera, index }) => {
  const id = `camera-${camera.streamId}`;
  return (
    <Layer id={id} style={placement(index)} fit="cover">
      <CtvStream
        id={id}
        organisationId={camera.organisationId}
        streamId={camera.streamId}
        exposureId={camera.exposureId}
        size={CANVAS}
      />
    </Layer>
  );
};
