import type { FC } from 'react';
import { Color, Layer, Scene, Show, Text } from '@strangecyan/vignette';

import { CtvStream } from './ctv-stream.ts';

// An organisation's broadcast: up to four cameras in quarters, filled in order with the streams the studio API chooses
// (src/shows in the studio API), the rest left black; or a note that there is nothing to show. A show is a pure
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
  /** The cameras, in quarter order (top left, top right, bottom left, bottom right): at most four, maybe none. */
  cameras: BroadcastCamera[];
}

/** The broadcast's frame, and each stream's: a quarter is the same shape, so a stream fills one. */
const CANVAS = { width: 1920, height: 1080 };

const FILL = { position: 'absolute', width: '100%', height: '100%' } as const;

/** The quarters, in the order cameras fill them: left to right, then top to bottom. */
const QUARTERS = [
  { left: '0%', top: '0%' },
  { left: '50%', top: '0%' },
  { left: '0%', top: '50%' },
  { left: '50%', top: '50%' }
] as const;

/** How many cameras the broadcast has room for: one per quarter. */
export const BROADCAST_CAMERAS = QUARTERS.length;

/** Where the quarter at `index` sits. */
function quarter(index: number) {
  const corner = QUARTERS[index % QUARTERS.length]!;
  return { position: 'absolute', width: '50%', height: '50%', ...corner } as const;
}

export interface BroadcastProps {
  state: BroadcastState;
}

/** The broadcast: black, with a camera in each quarter it has one for, or the note in their place. */
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
          cameras.map((camera, index) => <CameraQuarter key={camera.streamId} camera={camera} index={index} />)
        )}
      </Scene>
    </Show>
  );
};

interface CameraQuarterProps {
  camera: BroadcastCamera;
  index: number;
}

/**
 * One camera in its quarter. Its layer and source are named for its stream, so a stream that moves to another quarter
 * keeps playing where it moved, rather than its player being replaced.
 */
const CameraQuarter: FC<CameraQuarterProps> = ({ camera, index }) => {
  const id = `camera-${camera.streamId}`;
  return (
    <Layer id={id} style={quarter(index)} fit="cover">
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
