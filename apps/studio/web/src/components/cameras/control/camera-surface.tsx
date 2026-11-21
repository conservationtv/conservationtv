import {
  Suspense,
  useRef,
  useState,
  type ComponentProps,
  type FC,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ArrowsOutCardinalIcon, CrosshairIcon, ProhibitIcon, SelectionIcon, type Icon } from '@phosphor-icons/react';
import type { CameraCapabilities, CameraCommand } from '@conservationtv/cameras';
import { ToggleGroup, ToggleGroupItem } from '@conservationtv/ui/components/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';
import { cn } from '@conservationtv/ui/lib/utils';

import { useCameraCapabilities } from '@/components/cameras/control/camera-capabilities';
import { useCameraCommand } from '@/components/cameras/control/camera-commands';
import { useCameraControl, useCameraLock } from '@/components/cameras/control/camera-control-context';
import { CameraLockOverlay } from '@/components/cameras/control/camera-lock';
import { useDriveFailure, useSteer } from '@/components/cameras/control/camera-drive-context';
import { useCameraPicture } from '@/components/cameras/control/camera-picture-context';
import { eased, keySteering, STEERING_KEYS, STILL } from '@/components/cameras/control/camera-steering';
import { CameraSurfaceModeSchema, type CameraSurfaceMode } from '@/lib/camera-surface-mode';
import { cameraSurfaceModeQueryOptions, useSetCameraSurfaceMode } from '@/queries/this-device';

// Moving a camera on its own picture: a layer over the video, for whoever is in a control session. What a press on
// the picture means is chosen, not guessed, with a switch in the picture's corner that offers what the camera can do:
//
//   steer   press and pull: the line from where the press began is the velocity, further for faster, until let go;
//   point   click a spot, and the camera centres on it (`moveToPoint`);
//   box     drag a rectangle, and the camera moves so that it fills the picture (`moveToRegion`);
//   off     the picture takes no presses, so nothing moves by accident.
//
// Whatever the mode, the arrow keys steer while the picture has the focus (Shift for faster), and `+` and `-` zoom.
// Steering is not sent from here: the drag and the keys feed the loop that drives the camera (camera-drive-context.ts).
// The choice is kept on this browser. Outside a control session, or for a camera that can't be moved, it is just the
// video.

/** How far a drag pulls for full speed, as a fraction of the picture's height. */
const FULL_SPEED_PULL = 0.4;
/** The least of the picture a box may cover, each way, to mean anything: less is a slip of the hand. */
const BOX_LEAST = 0.04;

/** A mode, and how the switch shows it: its name, what choosing it means, and what the picture then says to do. */
interface SurfaceModeDetails {
  mode: CameraSurfaceMode;
  label: string;
  description: string;
  hint: string;
  icon: Icon;
}

const SURFACE_MODES: SurfaceModeDetails[] = [
  {
    mode: 'steer',
    label: 'Steer',
    description: 'Steer: press and drag to drive the camera',
    hint: 'Drag to steer',
    icon: ArrowsOutCardinalIcon
  },
  {
    mode: 'point',
    label: 'Point',
    description: 'Point: click a spot to centre the camera on it',
    hint: 'Click a spot to centre on it',
    icon: CrosshairIcon
  },
  {
    mode: 'box',
    label: 'Box',
    description: 'Box: drag a rectangle to fill the picture with it',
    hint: 'Drag a box to fill the picture with it',
    icon: SelectionIcon
  },
  {
    mode: 'off',
    label: 'Off',
    description: 'Off: the picture takes no clicks',
    hint: 'The picture takes no clicks',
    icon: ProhibitIcon
  }
];

/** The modes a camera can be offered, by the moves it takes. Off is always one. */
function surfaceModesOf(capabilities: CameraCapabilities): SurfaceModeDetails[] {
  const offered = new Set<CameraSurfaceMode>(['off']);
  if (capabilities.moves.includes('continuous')) offered.add('steer');
  if (capabilities.moves.includes('point')) offered.add('point');
  if (capabilities.moves.includes('region')) offered.add('box');
  return SURFACE_MODES.filter(details => offered.has(details.mode));
}

/** A point of the layer, in pixels from its top left. */
interface Point {
  x: number;
  y: number;
}

/** A drag under way: where the press began, and where the pointer is now. */
interface Pull {
  from: Point;
  to: Point;
}

/** Where a pointer is on the layer it is over, held to the layer: a captured pointer may wander off it. */
function pointOf(event: PointerEvent<HTMLDivElement>): Point {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(bounds.width, Math.max(0, event.clientX - bounds.left)),
    y: Math.min(bounds.height, Math.max(0, event.clientY - bounds.top))
  };
}

/**
 * The camera's video, with what moves the camera on it while the camera is being controlled here; otherwise the
 * video as it is. The video stays mounted either way. It is also the frame a still of the camera is taken from.
 */
export const CameraSurface: FC<ComponentProps<'div'>> = ({ className, children, ...props }) => {
  const control = useCameraControl();
  const picture = useCameraPicture();
  return (
    <div ref={picture?.frame} className={cn('relative', className)} {...props}>
      {children}
      {control && (
        <Suspense fallback={null}>
          <CapableSurface />
        </Suspense>
      )}
    </div>
  );
};

/** What the camera is called, over the top left of its picture. */
export const CameraSurfaceTitle: FC<ComponentProps<'p'>> = ({ className, ...props }) => {
  return (
    <p
      className={cn(
        'pointer-events-none absolute top-3 left-3 max-w-[60%] truncate rounded-md bg-black/45 px-2 py-0.5 text-custom-13 font-semibold text-white backdrop-blur-sm',
        className
      )}
      {...props}
    />
  );
};

/** The layer, once the camera's agent has said what the camera can do: nothing for one that can't be moved on it. */
const CapableSurface: FC = () => {
  const capabilities = useCameraCapabilities();
  const lock = useCameraLock();
  if (capabilities === null) return null;
  // While someone else is controlling the camera the picture takes no presses: it says who, and how to take over.
  if (lock !== null) return <CameraLockOverlay />;
  const modes = surfaceModesOf(capabilities);
  if (modes.length === 1) return null;
  return <SurfaceControls modes={modes} steers={capabilities.moves.includes('continuous')} />;
};

interface SurfaceControlsProps {
  /** The modes the camera can be offered, off among them. */
  modes: SurfaceModeDetails[];
  /** Whether the camera can be driven: the drag, and the keys. */
  steers: boolean;
}

/** The layer in the mode this browser last chose, or the first the camera has; the switch; and what to do. */
const SurfaceControls: FC<SurfaceControlsProps> = ({ modes, steers }) => {
  const driveFailure = useDriveFailure();
  const preferenceQuery = useSuspenseQuery(cameraSurfaceModeQueryOptions());
  const choose = useSetCameraSurfaceMode();
  const command = useCameraCommand();
  const [focused, setFocused] = useState(false);
  const chosen = modes.find(details => details.mode === preferenceQuery.data) ?? modes[0];
  if (!chosen) return null;
  return (
    <>
      <SurfaceFrame steers={steers} label={chosen.description} onFocusChange={setFocused}>
        {chosen.mode === 'steer' && <SteerLayer />}
        {chosen.mode === 'point' && <PointLayer run={command.mutate} />}
        {chosen.mode === 'box' && <BoxLayer run={command.mutate} />}
      </SurfaceFrame>
      <ToggleGroup
        aria-label="What a press on the picture does"
        value={[chosen.mode]}
        onValueChange={values => {
          // Pressing the mode that is on would leave none: it stays.
          const next = CameraSurfaceModeSchema.safeParse(values[0]);
          if (!next.success) return;
          command.reset();
          choose.mutate(next.data);
        }}
        spacing={0}
        className="absolute top-3 right-3 gap-0.5 rounded-lg bg-black/55 p-0.5 backdrop-blur-sm"
      >
        {modes.map(details => (
          <SurfaceModeItem key={details.mode} details={details} />
        ))}
      </ToggleGroup>
      <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-custom-12 text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
        <span>{chosen.hint}</span>
        {steers && focused && <span>Arrow keys steer, + and − zoom</span>}
        <SurfaceFailure failure={command.error?.message ?? driveFailure} />
      </div>
    </>
  );
};

interface SurfaceModeItemProps {
  details: SurfaceModeDetails;
}

/** One mode of the switch: its icon, with what it means on hover. */
const SurfaceModeItem: FC<SurfaceModeItemProps> = ({ details }) => {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ToggleGroupItem
            value={details.mode}
            size="sm"
            aria-label={details.label}
            className="rounded-md px-1.5 text-white/75 hover:bg-white/15 hover:text-white aria-pressed:bg-white/25 aria-pressed:text-white [&_svg:not([class*='size-'])]:size-3.5"
          />
        }
      >
        <details.icon />
      </TooltipTrigger>
      <TooltipContent side="bottom">{details.description}</TooltipContent>
    </Tooltip>
  );
};

interface SurfaceFailureProps {
  /** Why the camera didn't take the last command, if it didn't. */
  failure: string | undefined;
}

const SurfaceFailure: FC<SurfaceFailureProps> = ({ failure }) => {
  if (failure === undefined) return null;
  return <span className="text-red-300">{failure}</span>;
};

interface SurfaceFrameProps {
  steers: boolean;
  /** What a press on the picture does now, for whoever can't see the switch. */
  label: string;
  onFocusChange: (focused: boolean) => void;
  /** The current mode's layer, if it takes presses. */
  children: ReactNode;
}

/**
 * The picture as something that takes the focus: with it, the arrow keys steer the camera and `+` and `-` zoom,
 * whatever a press on the picture does. Losing the focus lets every key go.
 */
const SurfaceFrame: FC<SurfaceFrameProps> = ({ steers, label, onFocusChange, children }) => {
  const steer = useSteer('keys');
  const heldKeysRef = useRef(new Set<string>());
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!steers || !STEERING_KEYS.includes(event.key)) return;
    // The arrow keys would scroll the page, which is not what they are for while the picture has the focus.
    event.preventDefault();
    const held = heldKeysRef.current;
    if (event.type === 'keydown') held.add(event.key);
    else held.delete(event.key);
    steer(keySteering(held, event.shiftKey));
  };
  return (
    <div
      role="application"
      aria-label={steers ? `${label}. With the picture focused, the arrow keys steer and + and − zoom.` : label}
      tabIndex={0}
      className="absolute inset-0 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onKeyDown={onKey}
      onKeyUp={onKey}
      onFocus={() => onFocusChange(true)}
      onBlur={() => {
        heldKeysRef.current.clear();
        steer(STILL);
        onFocusChange(false);
      }}
      onContextMenu={event => event.preventDefault()}
    >
      {children}
    </div>
  );
};

/** Steering by dragging: the pull from where the press began is the velocity, drawn as it is held. */
const SteerLayer: FC = () => {
  const steer = useSteer('surface');
  const [pull, setPull] = useState<Pull | null>(null);
  const release = () => {
    steer(STILL);
    setPull(null);
  };
  return (
    <div
      className={cn('absolute inset-0 touch-none', pull ? 'cursor-grabbing' : 'cursor-grab')}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const from = pointOf(event);
        setPull({ from, to: from });
      }}
      onPointerMove={event => {
        if (!pull) return;
        const to = pointOf(event);
        setPull({ from: pull.from, to });
        // The pull as a velocity: its length against the picture's height, upwards on screen being upwards for the
        // camera.
        const reach = event.currentTarget.clientHeight * FULL_SPEED_PULL;
        steer({ ...STILL, pan: eased((to.x - pull.from.x) / reach), tilt: eased((pull.from.y - to.y) / reach) });
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <SurfaceMarks>{pull && <PullMark pull={pull} />}</SurfaceMarks>
    </div>
  );
};

interface CommandLayerProps {
  /** Sends the camera the command a press comes to. */
  run: (command: CameraCommand) => void;
}

/** Centring by clicking: the spot, as fractions of the picture, is where the camera goes. */
const PointLayer: FC<CommandLayerProps> = ({ run }) => {
  const [target, setTarget] = useState<Point | null>(null);
  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={event => {
        if (event.button !== 0) return;
        const at = pointOf(event);
        setTarget(at);
        run({
          kind: 'moveToPoint',
          x: at.x / event.currentTarget.clientWidth,
          y: at.y / event.currentTarget.clientHeight
        });
      }}
    >
      <SurfaceMarks>{target && <TargetMark key={`${target.x},${target.y}`} at={target} />}</SurfaceMarks>
    </div>
  );
};

/** Framing by dragging a box: let go, the camera moves so that what is in the box fills the picture. */
const BoxLayer: FC<CommandLayerProps> = ({ run }) => {
  const [pull, setPull] = useState<Pull | null>(null);
  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const from = pointOf(event);
        setPull({ from, to: from });
      }}
      onPointerMove={event => {
        if (pull) setPull({ from: pull.from, to: pointOf(event) });
      }}
      onPointerUp={event => {
        if (!pull) return;
        setPull(null);
        // The box as fractions of the picture from its top left, whichever way it was dragged.
        const { clientWidth, clientHeight } = event.currentTarget;
        const width = Math.abs(pull.to.x - pull.from.x) / clientWidth;
        const height = Math.abs(pull.to.y - pull.from.y) / clientHeight;
        if (width < BOX_LEAST || height < BOX_LEAST) return;
        const x = Math.min(pull.from.x, pull.to.x) / clientWidth;
        const y = Math.min(pull.from.y, pull.to.y) / clientHeight;
        run({ kind: 'moveToRegion', x, y, width, height });
      }}
      onPointerCancel={() => setPull(null)}
    >
      <SurfaceMarks>{pull && <BoxMark pull={pull} />}</SurfaceMarks>
    </div>
  );
};

/** What a layer draws over the picture as it is used. It takes no presses of its own. */
const SurfaceMarks: FC<ComponentProps<'svg'>> = props => {
  return <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden {...props} />;
};

interface PullMarkProps {
  pull: Pull;
}

/** The drag as it is: a ring where the press began, and the line pulled from it. */
const PullMark: FC<PullMarkProps> = ({ pull }) => {
  const { from, to } = pull;
  return (
    <g stroke="white" strokeWidth={2} fill="none" style={{ filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.7))' }}>
      <circle cx={from.x} cy={from.y} r={10} strokeOpacity={0.7} />
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} strokeLinecap="round" />
      <circle cx={to.x} cy={to.y} r={4} fill="white" />
    </g>
  );
};

/** The box as it is dragged, from the corner the press began at to where the pointer is. */
const BoxMark: FC<PullMarkProps> = ({ pull }) => {
  const { from, to } = pull;
  return (
    <rect
      x={Math.min(from.x, to.x)}
      y={Math.min(from.y, to.y)}
      width={Math.abs(to.x - from.x)}
      height={Math.abs(to.y - from.y)}
      rx={2}
      stroke="white"
      strokeWidth={2}
      fill="rgb(255 255 255 / 0.12)"
      style={{ filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.7))' }}
    />
  );
};

interface TargetMarkProps {
  at: Point;
}

/** Where a click sent the camera: a mark on the spot, which fades as the picture moves away under it. */
const TargetMark: FC<TargetMarkProps> = ({ at }) => {
  return (
    <g
      stroke="white"
      strokeWidth={2}
      fill="none"
      className="animate-out fade-out fill-mode-forwards duration-1000"
      style={{ filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.7))' }}
    >
      <circle cx={at.x} cy={at.y} r={12} />
      <line x1={at.x - 18} y1={at.y} x2={at.x - 6} y2={at.y} />
      <line x1={at.x + 6} y1={at.y} x2={at.x + 18} y2={at.y} />
      <line x1={at.x} y1={at.y - 18} x2={at.x} y2={at.y - 6} />
      <line x1={at.x} y1={at.y + 6} x2={at.x} y2={at.y + 18} />
    </g>
  );
};
