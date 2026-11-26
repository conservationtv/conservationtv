import type { FC } from 'react';
import { Color, Frame, Layer, Scene, Show, Text, Use, type AudioChannelInput } from '@strangecyan/vignette';

import { Clock } from './clock.frame.tsx';
import { CtvStream } from './ctv-stream.ts';
import { GRID_UNITS, layoutOf, type SlotRect } from './layouts.ts';
import { outline } from './outline.ts';
import { soundFrom, soundSources, type BroadcastCard, type BroadcastState, type BroadcastStream } from './state.ts';

// An organisation's broadcast (docs/shows.md), in two scenes. `main` is the grid: the show's layout (src/layouts.ts),
// each position holding a lineup camera's stream over its card, with its name centred across its top, or the empty
// card where there are fewer cameras than slots. `takeover` is one stream, fitted whole on black over its card. Both
// end with the same overlay, the show's own layers: a clock in Central Time in the top right corner. The show is on
// whichever scene its takeover says: `takeover` while one is live, else `main`. An armed takeover is placed in its
// scene off air, so its picture is already playing when it is cut to; while one is live the grid is not placed, so its
// cameras' inputs are released, and ending it brings the grid back through their cards.
//
// A card is under every video, and the video is always placed: a stream's health only chooses which card is there, so
// a late or wrong verdict can never hide a live picture, and a picture that returns covers its card at once. Cards and
// labels are built from the show's own colour and text sources, set in Nunito (`assets/fonts/Nunito.woff2`, from the
// bundle `vignette bundle` builds beside the clock's page), and scaled to their slot.
//
// Each stream placed with its picture is heard through its own channel (its level, mute and sync offset in the show),
// unless its sound comes `from` another stream: then it is placed without sound, and that other stream is placed once
// in the same scene for its sound alone, taking no space. A source is heard only while the scene on air places it, so
// an armed takeover is silent until it goes live, and the grid is silent while it is off. The show's own level is
// vignette's master bus (`<Show mix>`); vignette's mix has no mute, so muting the show mutes every channel.
//
// A show is a pure function of its state: it is composed afresh for each change, in a Durable Object that hibernates
// between them, so it holds no state and starts nothing (the lint rules for `*.show.tsx` refuse hooks and timers); the
// clock keeps time in its own page.

/** The broadcast's frame, and each stream's. */
const CANVAS = { width: 1920, height: 1080 };

/** One unit of the layouts' grid: 320 by 180, the canvas's shape a sixth the size. */
const UNIT = { width: CANVAS.width / GRID_UNITS, height: CANVAS.height / GRID_UNITS };

const FILL = { position: 'absolute', width: '100%', height: '100%' } as const;

/** The font the broadcast's text is set in: an asset of the show's bundle. */
const FONT = 'fonts/Nunito.woff2';

/** The zone the clock reads, Central Time. */
const CLOCK_TIME_ZONE = 'America/Chicago';

/** The clock's source, declared once for the show and placed by both scenes' overlay. */
const CLOCK_SOURCE = 'clock';

/**
 * Where the clock's page sits: over the whole canvas. The clock is one source both scenes place, and vignette lays a
 * shared source out at the canvas's size, so a smaller layer would squash its page; the page puts the time in its own
 * top right corner (clock.frame.tsx).
 */
const CLOCK_PLACEMENT = { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' } as const;

/** A label's height, type size, outline width and inset in a 2×2 slot; other slots scale them (`scaleOf`). */
const LABEL_HEIGHT = 48;
const LABEL_FONT_SIZE = 26;
const LABEL_OUTLINE = 2;
const LABEL_INSET = 16;

/** A card's type size in a 2×2 slot. */
const CARD_FONT_SIZE = 32;

/** The scenes: the grid, and a takeover. */
const MAIN = 'main';
const TAKEOVER = 'takeover';

/** What a card is: a stream's health (`BroadcastCard`), or an empty slot. */
type CardKind = BroadcastCard | 'empty';

/** Each card's colour, and what it says, if anything. */
const CARDS = {
  loading: { color: '#101010', text: 'Loading' },
  offline: { color: '#1a1a1a', text: 'Offline' },
  empty: { color: '#080808', text: undefined }
} satisfies Record<CardKind, CardLook>;

interface CardLook {
  color: string;
  text: string | undefined;
}

/** Where a slot sits on the canvas. */
function placement([column, row, width, height]: SlotRect) {
  return {
    position: 'absolute',
    left: column * UNIT.width,
    top: row * UNIT.height,
    width: width * UNIT.width,
    height: height * UNIT.height
  } as const;
}

/** How much a slot scales its label and card text by: 1 for a 2×2 slot, by its shorter side. */
function scaleOf([, , width, height]: SlotRect): number {
  return Math.min(width, height) / 2;
}

/** The whole canvas, as a slot: what a takeover fills. */
const WHOLE: SlotRect = [0, 0, GRID_UNITS, GRID_UNITS];

export interface BroadcastProps {
  state: BroadcastState;
}

/** The broadcast: the grid and the takeover, on whichever the takeover says, each under the overlay. */
export const Broadcast: FC<BroadcastProps> = ({ state }) => {
  const live = state.takeover?.live ?? false;
  const grid = live ? [] : state.cameras;
  const takeover = state.takeover === null ? [] : [state.takeover];
  return (
    // vignette's targets put the active scene on program whenever they start following, so OBS never stays on the
    // empty scene its fresh collection begins with (apps/agent/core/src/output/obs/settings.ts).
    <Show id="broadcast" canvas={CANVAS} activeScene={live ? TAKEOVER : MAIN} mix={{ volumeDb: state.mix.volumeDb }}>
      <Frame id={CLOCK_SOURCE} of={Clock} params={{ timeZone: CLOCK_TIME_ZONE }} />
      <Scene id={MAIN}>
        <Layer id="background" style={FILL}>
          <Color color="#000000" />
        </Layer>
        {live ? null : <Grid state={state} />}
        <Sounds state={state} pictured={grid} prefix="sound" />
        <Overlay />
      </Scene>
      <Scene id={TAKEOVER}>
        <Layer id="background" style={FILL}>
          <Color color="#000000" />
        </Layer>
        {state.takeover === null ? null : <Takeover state={state} stream={state.takeover} />}
        <Sounds state={state} pictured={takeover} prefix="takeover-sound" />
        <Overlay />
      </Scene>
    </Show>
  );
};

/** A stream that can be heard, as vignette mixes it: its own channel, muted while the whole show is. */
function heardChannel(state: BroadcastState, streamId: string): AudioChannelInput {
  const channel = state.audio[streamId];
  if (channel === undefined) return { muted: state.mix.muted };
  const { volumeDb, syncOffsetMs } = channel;
  return { volumeDb, muted: channel.muted || state.mix.muted, syncOffsetMs };
}

/** The channel a stream placed with its picture is heard through: none when its sound comes from another stream. */
function pictureChannel(state: BroadcastState, streamId: string): AudioChannelInput | false {
  return soundFrom(state.audio, streamId) === undefined ? heardChannel(state, streamId) : false;
}

interface SoundsProps {
  state: BroadcastState;
  /** The streams the scene places with their pictures. */
  pictured: readonly BroadcastStream[];
  /** What the scene's sound sources' IDs begin with, so no two scenes share one. */
  prefix: string;
}

/** The streams a scene places for their sound alone (`soundSources`): each taking no space, heard as its own. */
const Sounds: FC<SoundsProps> = ({ state, pictured, prefix }) => {
  const [first] = pictured;
  if (first === undefined) return null;
  const sources = soundSources(
    pictured.map(stream => stream.streamId),
    state.audio
  );
  return sources.map(streamId => {
    const id = `${prefix}-${streamId}`;
    return (
      <Layer key={id} id={id}>
        <CtvStream
          id={id}
          organisationId={first.organisationId}
          streamId={streamId}
          exposureId={state.exposures?.[streamId]}
          size={CANVAS}
          video={false}
          audio={heardChannel(state, streamId)}
        />
      </Layer>
    );
  });
};

interface GridProps {
  state: BroadcastState;
}

/** The layout's positions in order, each a camera, or the empty card past the last camera. */
const Grid: FC<GridProps> = ({ state }) => {
  const rects = layoutOf(state.slots);
  return rects.map((rect, index) => {
    const camera = state.cameras[index];
    if (camera === undefined) return <EmptySlot key={`empty-${String(index)}`} rect={rect} position={index + 1} />;
    return <CameraSlot key={camera.streamId} state={state} camera={camera} rect={rect} />;
  });
};

interface CameraSlotProps {
  state: BroadcastState;
  camera: BroadcastStream;
  rect: SlotRect;
}

/**
 * One camera in its slot: its card, its video over it, and its name across its top. Its layers and its source are
 * named for its stream, so a stream that moves to another slot keeps playing where it moved, at its new size, rather
 * than its player being replaced. The video is cropped to fill the slot, centred.
 */
const CameraSlot: FC<CameraSlotProps> = ({ state, camera, rect }) => {
  const id = `camera-${camera.streamId}`;
  const scale = scaleOf(rect);
  return (
    <Layer id={`slot-${camera.streamId}`} style={placement(rect)}>
      <Card id={`card-${camera.streamId}`} kind={camera.card} scale={scale} />
      <Layer id={id} style={FILL} fit="cover">
        <CtvStream
          id={id}
          organisationId={camera.organisationId}
          streamId={camera.streamId}
          exposureId={state.exposures?.[camera.streamId]}
          size={CANVAS}
          audio={pictureChannel(state, camera.streamId)}
        />
      </Layer>
      <Label id={`label-${camera.streamId}`} text={camera.name} scale={scale} />
    </Layer>
  );
};

interface EmptySlotProps {
  rect: SlotRect;
  position: number;
}

/** A position with no camera: the empty card. */
const EmptySlot: FC<EmptySlotProps> = ({ rect, position }) => {
  return (
    <Layer id={`empty-${String(position)}`} style={placement(rect)}>
      <Card id={`empty-card-${String(position)}`} kind="empty" scale={scaleOf(rect)} />
    </Layer>
  );
};

interface TakeoverProps {
  state: BroadcastState;
  stream: BroadcastStream;
}

/** The takeover's stream, fitted whole over its card; a source of its own, apart from the grid's. */
const Takeover: FC<TakeoverProps> = ({ state, stream }) => {
  const id = `takeover-${stream.streamId}`;
  return (
    <Layer id={`takeover-slot-${stream.streamId}`} style={FILL}>
      <Card id={`takeover-card-${stream.streamId}`} kind={stream.card} scale={scaleOf(WHOLE)} />
      <Layer id={id} style={FILL} fit="contain">
        <CtvStream
          id={id}
          organisationId={stream.organisationId}
          streamId={stream.streamId}
          exposureId={state.exposures?.[stream.streamId]}
          size={CANVAS}
          audio={pictureChannel(state, stream.streamId)}
        />
      </Layer>
    </Layer>
  );
};

interface CardProps {
  id: string;
  kind: CardKind;
  scale: number;
}

/** A card filling its slot: its colour, and what it says centred over it. */
const Card: FC<CardProps> = ({ id, kind, scale }) => {
  const look = CARDS[kind];
  return (
    <Layer id={id} style={FILL}>
      <Layer id={`${id}-color`} style={FILL}>
        <Color color={look.color} />
      </Layer>
      {look.text === undefined ? null : (
        <Layer id={`${id}-text`} style={FILL}>
          <Text
            text={look.text}
            font={FONT}
            style={{
              fontFamily: 'Nunito',
              fontWeight: 700,
              fontSize: CARD_FONT_SIZE * scale,
              color: '#8a8a8a',
              textAlign: 'center',
              verticalAlign: 'middle',
              textWrap: 'nowrap',
              maxLines: 1
            }}
          />
        </Layer>
      )}
    </Layer>
  );
};

interface LabelProps {
  id: string;
  text: string;
  scale: number;
}

/** A name centred across the top of its slot, white with a black outline, sized for the slot. */
const Label: FC<LabelProps> = ({ id, text, scale }) => {
  const inset = LABEL_INSET * scale;
  return (
    <Layer id={id} style={{ position: 'absolute', top: 0, left: inset, right: inset, height: LABEL_HEIGHT * scale }}>
      <Text
        text={text}
        font={FONT}
        style={{
          fontFamily: 'Nunito',
          fontWeight: 700,
          fontSize: LABEL_FONT_SIZE * scale,
          color: '#ffffff',
          textShadow: outline(LABEL_OUTLINE * scale),
          textAlign: 'center',
          verticalAlign: 'middle',
          textWrap: 'nowrap',
          maxLines: 1
        }}
      />
    </Layer>
  );
};

/** The show's own layers, over either scene: the clock. */
const Overlay: FC = () => {
  return (
    <Layer id="clock" style={CLOCK_PLACEMENT}>
      <Use source={CLOCK_SOURCE} />
    </Layer>
  );
};
