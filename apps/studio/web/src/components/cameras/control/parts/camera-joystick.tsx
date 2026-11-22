import { Suspense, useState, type FC, type PointerEvent } from 'react';
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  GameControllerIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon
} from '@phosphor-icons/react';
import type { CameraCapabilities } from '@conservationtv/cameras';
import { Button, type ButtonProps } from '@conservationtv/ui/components/button';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';
import { cn } from '@conservationtv/ui/lib/utils';

import { useCameraCapabilities } from '@/components/cameras/control/camera-capabilities';
import { useCameraControl, useCameraLock } from '@/components/cameras/control/camera-control-context';
import {
  useGamepad,
  useSteer,
  useSteering,
  useZoomDrag
} from '@/components/cameras/control/drive/camera-drive-context';
import { eased, NUDGE_SPEED, STILL, uneased, type Steering } from '@/components/cameras/control/drive/camera-steering';
import { useCamera, zoomOf } from '@/components/cameras/control/store/camera-store';
import { StatusDot } from '@/components/common/status';

// The controls that drive a camera from beside its presets: a joystick for the axes it pans and tilts on, a slider
// for its zoom, and whether a gamepad drives it too. The joystick is sprung: how far its knob is from the middle is
// how fast the camera goes, and it goes back to the middle, and the camera stops, when it is let go. It only says
// what it asks for (the loop that drives the camera is the drive store's, camera-drive-context.ts), and draws its knob from the steering the
// loop is listening to, so a gamepad's stick, the keys and a drag on the picture all move it too. The slider is not
// sprung: its knob is where the camera's zoom is in its range, and dragging it sends the zoom there. It too only says
// where it is dragged and when it is let go: what is sent, and how often, is the drive store's.

/** How wide the knobs are, in pixels: what is taken off a pad's or a track's half-width for how far a knob travels. */
const KNOB_PX = 20;
/** How fast a held zoom or focus button drives. */
const HOLD_SPEED = 0.5;

/** How far out the joystick's knob is before the pad starts to glow under it, 0 to 1. */
const GLOW_FROM = 0.4;

/** A place on the joystick's pad from its middle, as fractions of how far the knob travels: -1 to 1 each way. */
interface Deflection {
  x: number;
  y: number;
}

/** Where a pointer is on the pad from its middle, on the axes the camera has, held to the circle the knob travels in. */
function deflectionOf(event: PointerEvent<HTMLElement>, pans: boolean, tilts: boolean): Deflection {
  const bounds = event.currentTarget.getBoundingClientRect();
  const reach = bounds.width / 2 - KNOB_PX / 2;
  const x = pans ? (event.clientX - (bounds.left + bounds.width / 2)) / reach : 0;
  const y = tilts ? (event.clientY - (bounds.top + bounds.height / 2)) / reach : 0;
  const scale = Math.min(1, 1 / Math.max(Math.hypot(x, y), Number.EPSILON));
  return { x: x * scale, y: y * scale };
}

/** Where a pointer is along the slider's track as a zoom: 1 with the knob at the top, 0 at the bottom. */
function zoomAt(event: PointerEvent<HTMLElement>): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  const along = (event.clientY - bounds.top - KNOB_PX / 2) / (bounds.height - KNOB_PX);
  return 1 - Math.min(1, Math.max(0, along));
}

export interface CameraHoldButtonProps extends ButtonProps {
  /** What the button asks of the camera for as long as it is held. */
  steering: Steering;
}

/**
 * A button that drives the camera while it is held, by pointer or with Space or Enter, and lets go however the hold
 * ends: released, cancelled, the pointer leaving, or the button losing the focus.
 */
export const CameraHoldButton: FC<CameraHoldButtonProps> = ({ steering, ...props }) => {
  const steer = useSteer('hold');
  const release = () => steer(STILL);
  return (
    <Button
      onPointerDown={event => {
        if (event.button === 0) steer(steering);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onBlur={release}
      // A long press on a touch screen is a hold, not a request for the menu.
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (!event.repeat && (event.key === ' ' || event.key === 'Enter')) steer(steering);
      }}
      onKeyUp={release}
      {...props}
    />
  );
};

/**
 * The controls that drive the camera by hand, for the axes it has. Nothing outside a control session, or for a
 * camera that can't be driven: a page sets it down either way.
 */
export const CameraJoystick: FC = () => {
  const control = useCameraControl();
  if (!control) return null;
  return (
    <Suspense fallback={<Skeleton className="m-2 h-36 w-44 shrink-0" />}>
      <CapableJoystick />
    </Suspense>
  );
};

/** The controls, once the camera's agent has said what the camera can do. */
const CapableJoystick: FC = () => {
  const capabilities = useCameraCapabilities();
  const locked = useCameraLock() !== null;
  if (capabilities === null || !capabilities.moves.includes('continuous')) return null;
  return (
    // While someone else is controlling the camera these still show where it is, faded, and take no presses.
    <div
      inert={locked}
      className={cn(
        'flex shrink-0 items-stretch justify-center gap-2.5 border-b border-border p-2 transition-opacity select-none sm:border-r sm:border-b-0',
        locked && 'opacity-40'
      )}
    >
      {capabilities.zoom && <CameraZoomSlider absolute={capabilities.moves.includes('absolute')} />}
      <CameraPadArea capabilities={capabilities} />
    </div>
  );
};

interface CameraZoomSliderProps {
  /** Whether the camera goes to a zoom it is sent: one that doesn't only shows where its zoom is. */
  absolute: boolean;
}

/**
 * The camera's zoom as a slider over its range, in at the top: the knob is where the zoom is, as the session's store
 * has it, so it moves however the camera is zoomed, from here or anywhere, and under the pointer while it is dragged.
 * Dragging it sends the camera's zoom to where it is dragged, as it goes and once more where it is let go (the drive
 * store's `zoomDragged` and `zoomReleased`); the session's store claims the zoom as each is sent, so the knob stays
 * where it was let go. A button at each end zooms while it is held.
 */
const CameraZoomSlider: FC<CameraZoomSliderProps> = ({ absolute }) => {
  const zoom = useCamera(zoomOf);
  const { dragged, drag, release } = useZoomDrag();
  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const target = zoomAt(event);
    drag(target);
  };
  const shown = dragged ?? zoom;
  return (
    <div className="flex flex-col items-center gap-1">
      <CameraHoldButton
        variant="ghost"
        size="icon-xs"
        aria-label="Zoom in while held"
        steering={{ ...STILL, zoom: HOLD_SPEED }}
      >
        <MagnifyingGlassPlusIcon />
      </CameraHoldButton>
      <div
        role="slider"
        aria-label="Zoom"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown === undefined ? undefined : Math.round(shown * 100)}
        aria-disabled={!absolute}
        tabIndex={-1}
        className={cn(
          'relative min-h-[4.4rem] w-5 flex-1 touch-none',
          !absolute && 'pointer-events-none',
          dragged === null ? 'cursor-grab' : 'cursor-grabbing'
        )}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          follow(event);
        }}
        onPointerMove={event => {
          if (dragged !== null) follow(event);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onContextMenu={event => event.preventDefault()}
      >
        <span className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-muted" />
        {shown !== undefined && (
          <span
            className={cn(
              'pointer-events-none absolute left-1/2 -ml-[10px] size-[20px] rounded-full bg-foreground/65 shadow-md',
              dragged === null && 'transition-[top] duration-300 ease-linear'
            )}
            style={{ top: `calc(${1 - shown} * (100% - ${KNOB_PX}px))` }}
          />
        )}
      </div>
      <CameraHoldButton
        variant="ghost"
        size="icon-xs"
        aria-label="Zoom out while held"
        steering={{ ...STILL, zoom: -HOLD_SPEED }}
      >
        <MagnifyingGlassMinusIcon />
      </CameraHoldButton>
    </div>
  );
};

interface CameraPadAreaProps {
  capabilities: CameraCapabilities;
}

/**
 * The joystick with a nudge button on each side the camera moves to, and the gamepad's switch at its corner. A
 * camera that only zooms has the switch alone.
 */
const CameraPadArea: FC<CameraPadAreaProps> = ({ capabilities }) => {
  // Each side is offered only if the camera has that axis: a camera that tilts but doesn't pan has no left or right.
  const pans = capabilities.pan !== undefined;
  const tilts = capabilities.tilt !== undefined;
  return (
    <div className="relative grid grid-cols-[1rem_auto_1rem] grid-rows-[1rem_auto_1rem] place-items-center gap-0.5">
      {tilts && (
        <CameraNudgeButton className="col-start-2 row-start-1" label="up" steering={{ ...STILL, tilt: NUDGE_SPEED }}>
          <CaretUpIcon weight="fill" />
        </CameraNudgeButton>
      )}
      {pans && (
        <CameraNudgeButton className="col-start-1 row-start-2" label="left" steering={{ ...STILL, pan: -NUDGE_SPEED }}>
          <CaretLeftIcon weight="fill" />
        </CameraNudgeButton>
      )}
      {(pans || tilts) && <CameraPad pans={pans} tilts={tilts} />}
      {pans && (
        <CameraNudgeButton className="col-start-3 row-start-2" label="right" steering={{ ...STILL, pan: NUDGE_SPEED }}>
          <CaretRightIcon weight="fill" />
        </CameraNudgeButton>
      )}
      {tilts && (
        <CameraNudgeButton className="col-start-2 row-start-3" label="down" steering={{ ...STILL, tilt: -NUDGE_SPEED }}>
          <CaretDownIcon weight="fill" />
        </CameraNudgeButton>
      )}
      <CameraGamepadSwitch className="absolute -top-0.5 -right-1" />
    </div>
  );
};

interface CameraNudgeButtonProps extends CameraHoldButtonProps {
  /** Which way it moves the camera, in a word. */
  label: string;
}

/** One of the small triangles around the joystick: moves the camera that way, gently, while it is held. */
const CameraNudgeButton: FC<CameraNudgeButtonProps> = ({ label, className, ...props }) => {
  return (
    <CameraHoldButton
      variant="ghost"
      size="icon-xs"
      aria-label={`Move ${label} while held`}
      className={cn('size-4 text-custom-text-secondary [&_svg:not([class*=size-])]:size-2.5', className)}
      {...props}
    />
  );
};

interface CameraPadProps {
  /** Whether the knob moves sideways, and up and down: each only if the camera has that axis. */
  pans: boolean;
  tilts: boolean;
}

/**
 * The joystick: a round pad that steers by how far the pointer is pulled from its middle. Its knob is drawn from the
 * steering the loop is listening to, which is the pull while the pad is held, and otherwise whatever else steers: a
 * gamepad's stick, the keys, a drag on the picture.
 */
const CameraPad: FC<CameraPadProps> = ({ pans, tilts }) => {
  const steer = useSteer('pad');
  const steering = useSteering();
  const [held, setHeld] = useState(false);
  // Which way the knob was last pulled, kept after it is let go so the glow fades where it was rather than jumping.
  const [towards, setTowards] = useState<Deflection>({ x: 0, y: 0 });
  const follow = (event: PointerEvent<HTMLDivElement>) => {
    // Up on the pad is up for the camera.
    const pull = deflectionOf(event, pans, tilts);
    steer({ ...STILL, pan: eased(pull.x), tilt: eased(-pull.y) });
  };
  const release = () => {
    setHeld(false);
    steer(STILL);
  };
  // Where the knob sits: the steering with its easing undone, so under the pointer it is exactly where it was pulled.
  const knob: Deflection = { x: uneased(steering.pan), y: -uneased(steering.tilt) };
  const reached = Math.min(1, Math.hypot(knob.x, knob.y));
  if (reached > 0 && (knob.x / reached !== towards.x || knob.y / reached !== towards.y)) {
    setTowards({ x: knob.x / reached, y: knob.y / reached });
  }
  return (
    <div
      role="application"
      aria-label="Joystick: drag from the middle to steer the camera, further for faster"
      className={cn(
        'relative col-start-2 row-start-2 size-[6.6rem] touch-none rounded-full border [container-type:inline-size] border-border bg-radial from-muted to-background',
        held ? 'cursor-grabbing' : 'cursor-grab'
      )}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setHeld(true);
        follow(event);
      }}
      onPointerMove={event => {
        if (held) follow(event);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={event => event.preventDefault()}
    >
      <CameraPadGlow towards={towards} reached={reached} />
      <span
        className={cn(
          'pointer-events-none absolute top-1/2 left-1/2 -mt-[10px] -ml-[10px] size-[20px] rounded-full bg-foreground/65 shadow-md',
          // Under the pointer the knob keeps up with it; otherwise it eases between what the loop reads ten times a
          // second, and back to the middle when let go.
          !held && 'transition-transform duration-100 ease-out'
        )}
        style={{
          transform: `translate(calc(${knob.x} * (50cqw - ${KNOB_PX / 2}px)), calc(${knob.y} * (50cqw - ${KNOB_PX / 2}px)))`
        }}
      />
    </div>
  );
};

interface CameraPadGlowProps {
  /** Which way the knob is pulled, as a unit vector from the pad's middle. */
  towards: Deflection;
  /** How far towards the edge the knob is: 0 in the middle, 1 at the limit. */
  reached: number;
}

/**
 * The warm glow on the pad's rim on the side the knob is pulled to: nothing while the knob is around the middle, and
 * at its strongest at the limit, where the camera is going as fast as it goes. It sits on the circumference and only
 * goes round it with the knob; what falls outside the pad is cut off.
 */
const CameraPadGlow: FC<CameraPadGlowProps> = ({ towards, reached }) => {
  const strength = Math.max(0, (reached - GLOW_FROM) / (1 - GLOW_FROM));
  return (
    <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
      <span
        className="absolute -mt-[40%] -ml-[40%] size-[80%] rounded-full bg-radial from-[hsl(15.5_44.7%_75.5%/0.6)] to-transparent to-70% transition-opacity duration-200 ease-out"
        style={{ left: `${50 + towards.x * 50}%`, top: `${50 + towards.y * 50}%`, opacity: strength }}
      />
    </span>
  );
};

/** What the gamepad's switch says of itself, by whether one is connected and whether it is on. */
function gamepadNoteOf(connected: boolean, enabled: boolean): string {
  if (!enabled) return 'Gamepad off: it does nothing until it is switched back on.';
  if (!connected) return 'No gamepad connected. Press a button on one for the browser to see it.';
  return 'Gamepad on: the left stick steers, the triggers zoom. Press to switch it off.';
}

interface CameraGamepadSwitchProps {
  className?: string;
}

/** Whether a gamepad drives the camera: on unless switched off, with a green dot while one is connected and on. */
const CameraGamepadSwitch: FC<CameraGamepadSwitchProps> = ({ className }) => {
  const { connected, enabled, setEnabled } = useGamepad();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={enabled}
            aria-label={enabled ? 'Switch the gamepad off' : 'Switch the gamepad on'}
            className={cn('h-5 gap-1 px-1', !(connected && enabled) && 'text-muted-foreground', className)}
            onClick={() => setEnabled(!enabled)}
          />
        }
      >
        <GameControllerIcon className="size-3.5" />
        {/* The dot keeps its place beside the icon when it is not shown, so the icon does not move as it comes and goes. */}
        <StatusDot status="ok" className={cn('shrink-0', !(connected && enabled) && 'invisible')} />
      </TooltipTrigger>
      <TooltipContent>{gamepadNoteOf(connected, enabled)}</TooltipContent>
    </Tooltip>
  );
};
