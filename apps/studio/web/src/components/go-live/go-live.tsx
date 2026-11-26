import { Suspense, useEffect, useRef, useState, type ComponentProps, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { BroadcastIcon, CameraIcon, MonitorIcon, StopIcon } from '@phosphor-icons/react';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { Field, FieldLabel } from '@conservationtv/ui/components/field';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { ToggleGroup, ToggleGroupItem } from '@conservationtv/ui/components/toggle-group';
import { cn } from '@conservationtv/ui/lib/utils';

import { useGoLiveSession, type GoLivePhase, type GoLiveStatus } from '@/components/go-live/go-live-session';
import { QuietBoundary } from '@/components/common/quiet-boundary';
import { useOrganisationId } from '@/hooks/use-organisation';
import {
  canShareScreen,
  capture,
  captureDevices,
  release,
  type CaptureDevices,
  type CaptureSource
} from '@/lib/publishing';
import { liveExposureListQueryOptions, liveStreamIds } from '@/queries/publishing';

// Going live from this browser, on a phone or a computer (docs/shows.md, Going live): pick a camera or a screen, see
// what will be sent, and go live. It goes to conservation.tv by MoQ, at every size readers draw it at, each sent only
// while someone watches it: there is nothing else to choose. The stream is yours for this kind of device, made the
// first time and kept, so a show that took it over before finds it again.

/**
 * The whole of going live: the capture and its preview, what to send, and the session's state. The capture stays
 * while the session starts and stops, and goes when the page does.
 */
export const GoLive: FC = () => {
  const organisationId = useOrganisationId();
  const session = useGoLiveSession(organisationId);
  const capturing = useCapture(session.stop);
  const [source, setSource] = useState<CaptureSource>('camera');
  const [devices, setDevices] = useState<CaptureDevices>({});
  const { media } = capturing;
  const { phase, streamId } = session.status;
  const sending = phase !== 'idle' && phase !== 'failed';
  // A choice takes effect once its capture does: one cancelled or refused leaves what was being sent, and says so.
  const chooseSource = async (next: CaptureSource) => {
    if (media !== undefined && !(await capturing.preview(next, devices))) return;
    setSource(next);
  };
  const chooseDevices = async (chosen: CaptureDevices) => {
    if (!(await capturing.preview(source, chosen))) return;
    setDevices(chosen);
  };
  return (
    <div className="flex flex-col gap-5">
      <GoLivePreview media={media}>
        <GoLiveState status={session.status} className="absolute top-3 left-3" />
      </GoLivePreview>
      <GoLiveMessage status={session.status} captureError={capturing.error} />
      {/* A hint the session can go without: the live list failing to load leaves the session and the capture alone. */}
      {streamId !== undefined && sending && (
        <QuietBoundary>
          <Suspense fallback={null}>
            <GoLiveReaders streamId={streamId} />
          </Suspense>
        </QuietBoundary>
      )}
      <div className="flex flex-col gap-4">
        {canShareScreen() && (
          <GoLiveSource value={source} disabled={sending} onChoose={next => void chooseSource(next)} />
        )}
        {source === 'camera' && media !== undefined && (
          <GoLiveDevices
            available={capturing.available}
            chosen={devices}
            disabled={sending}
            onChoose={chosen => void chooseDevices(chosen)}
          />
        )}
        <GoLiveActions
          source={source}
          media={media}
          sending={sending}
          onCapture={() => void capturing.preview(source, devices)}
          onTurnOff={capturing.turnOff}
          onStart={captured => void session.start(captured, source)}
          onStop={session.stop}
        />
      </div>
    </div>
  );
};

/**
 * The capture the page sends: made afresh from a source and devices (`preview`, which says whether it was), letting go
 * of the last one, and released by `turnOff` or the page going. A capture whose video the browser's own controls end
 * (a screen share stopped from its bar) is gone, and `ended` is told, rather than black being sent.
 */
function useCapture(ended: () => void) {
  const [media, setMedia] = useState<MediaStream | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [available, setAvailable] = useState<MediaDeviceInfo[]>([]);
  const mediaRef = useRef<MediaStream | undefined>(undefined);
  // Counts what was last asked for: a capture can arrive long after it was asked (a permission prompt left open), by
  // when the page may have gone, been turned off, or asked for another, and only the latest one asked for is kept.
  const asking = useRef(0);
  useEffect(
    () => () => {
      asking.current += 1;
      release(mediaRef.current);
    },
    []
  );
  const replace = (next: MediaStream | undefined) => {
    release(mediaRef.current);
    mediaRef.current = next;
    setMedia(next);
  };
  const preview = async (source: CaptureSource, devices: CaptureDevices): Promise<boolean> => {
    // A failure is told, and a capture kept, only if nothing was asked for since; one that arrives late is let go.
    asking.current += 1;
    const asked = asking.current;
    setError(undefined);
    let captured: MediaStream | undefined = undefined;
    try {
      captured = await capture(source, devices);
    } catch (failure) {
      const message =
        failure instanceof Error ? captureFailure(source, failure) : 'The camera or screen couldn’t be used.';
      if (asked === asking.current) setError(message);
      return false;
    }
    if (asked !== asking.current) {
      release(captured);
      return false;
    }
    replace(captured);
    for (const track of captured.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (mediaRef.current !== captured) return;
        ended();
        replace(undefined);
      });
    }
    const named = await captureDevices();
    if (asked === asking.current) setAvailable(named);
    return true;
  };
  const turnOff = () => {
    asking.current += 1;
    ended();
    replace(undefined);
  };
  return { media, error, available, preview, turnOff };
}

/**
 * Why a capture failed, in words its person can act on. A screen picker that was cancelled and one the browser was
 * not allowed to show fail alike in some browsers, so what is said of a screen is true of both.
 */
function captureFailure(source: CaptureSource, error: Error): string {
  if (error.name === 'NotAllowedError' && source === 'screen') {
    return 'Nothing was shared. Try again to pick what to share; if the browser offered no choice, allow screen sharing in its settings.';
  }
  if (error.name === 'NotAllowedError') {
    return 'The browser wasn’t allowed to use the camera or microphone. Allow it in the browser’s settings, then try again.';
  }
  if (error.name === 'NotFoundError') return 'There is no camera or microphone to use.';
  return error.message;
}

interface GoLiveActionsProps {
  source: CaptureSource;
  media: MediaStream | undefined;
  sending: boolean;
  onCapture: () => void;
  onTurnOff: () => void;
  onStart: (media: MediaStream) => void;
  onStop: () => void;
}

/**
 * What can be done now: with nothing captured, turn the camera on (or choose a screen); captured, go live or turn it
 * off; while sending, stop.
 */
const GoLiveActions: FC<GoLiveActionsProps> = ({ source, media, sending, onCapture, onTurnOff, onStart, onStop }) => {
  if (media === undefined) {
    return (
      <Button size="lg" onClick={onCapture}>
        {source === 'screen' ? <MonitorIcon /> : <CameraIcon />}
        {source === 'screen' ? 'Choose what to share' : 'Turn on camera'}
      </Button>
    );
  }
  if (sending) {
    return (
      <Button size="lg" variant="destructive" onClick={onStop}>
        <StopIcon />
        Stop
      </Button>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button size="lg" variant="outline" onClick={onTurnOff}>
        Turn off
      </Button>
      <Button size="lg" onClick={() => onStart(media)}>
        <BroadcastIcon />
        Go live
      </Button>
    </div>
  );
};

interface GoLiveSourceProps {
  value: CaptureSource;
  disabled: boolean;
  onChoose: (source: CaptureSource) => void;
}

/** What to send: the camera, or a screen, window or tab. Only where the browser can share a screen. */
const GoLiveSource: FC<GoLiveSourceProps> = ({ value, disabled, onChoose }) => {
  return (
    <ToggleGroup
      aria-label="What to send"
      value={[value]}
      disabled={disabled}
      onValueChange={values => {
        // Pressing the one that is on would leave none: it stays.
        const next = values[0];
        if (next === 'camera' || next === 'screen') onChoose(next);
      }}
      variant="outline"
    >
      <ToggleGroupItem value="camera">
        <CameraIcon />
        Camera
      </ToggleGroupItem>
      <ToggleGroupItem value="screen">
        <MonitorIcon />
        Screen
      </ToggleGroupItem>
    </ToggleGroup>
  );
};

export interface GoLivePreviewProps extends ComponentProps<'div'> {
  media: MediaStream | undefined;
}

/** What will be sent, as it is captured, silent; a black frame with a word before there is anything. */
export const GoLivePreview: FC<GoLivePreviewProps> = ({ media, className, children, ...props }) => {
  // The video element plays the capture: set only when it changed, since setting it again restarts the picture.
  const attach = (video: HTMLVideoElement | null) => {
    if (video !== null && video.srcObject !== (media ?? null)) video.srcObject = media ?? null;
  };
  return (
    <div className={cn('relative aspect-video w-full overflow-hidden rounded-xl bg-black', className)} {...props}>
      {media === undefined ? (
        <p className="absolute inset-0 flex items-center justify-center text-custom-13 text-white/60">
          Nothing to send yet
        </p>
      ) : (
        <video ref={attach} className="size-full object-contain" autoPlay muted playsInline />
      )}
      {children}
    </div>
  );
};

/** How a phase looks: what it is called, and its badge's variant. */
interface PhaseLook {
  label: string;
  variant: ComponentProps<typeof Badge>['variant'];
}

/** What each phase is called, and how its badge looks. */
const PHASES = {
  idle: { label: 'Not live', variant: 'outline' },
  starting: { label: 'Starting', variant: 'secondary' },
  connecting: { label: 'Connecting', variant: 'secondary' },
  live: { label: 'Live', variant: 'destructive' },
  lost: { label: 'Connection lost, retrying', variant: 'secondary' },
  failed: { label: 'Not live', variant: 'outline' }
} satisfies Record<GoLivePhase, PhaseLook>;

export interface GoLiveStateProps extends ComponentProps<typeof Badge> {
  status: GoLiveStatus;
}

/** Where going live is, as a badge: not live, starting, connecting, live, or lost and retrying. */
export const GoLiveState: FC<GoLiveStateProps> = ({ status, ...props }) => {
  const { label, variant } = PHASES[status.phase];
  return (
    <Badge variant={variant} aria-live="polite" {...props}>
      {label}
    </Badge>
  );
};

interface GoLiveMessageProps {
  status: GoLiveStatus;
  captureError: string | undefined;
}

/** Why it isn't live, or what it is waiting for; and how it is sent, once it is. */
const GoLiveMessage: FC<GoLiveMessageProps> = ({ status, captureError }) => {
  const text = captureError ?? status.message ?? (status.phase === 'live' ? 'Sending to conservation.tv.' : undefined);
  if (text === undefined) return null;
  const failing = captureError !== undefined || status.phase === 'failed';
  return <p className={cn('text-custom-13', failing ? 'text-destructive' : 'text-muted-foreground')}>{text}</p>;
};

interface GoLiveReadersProps {
  streamId: string;
}

/** Whether the studio sees the stream live now, as its delivery's gateway says: what a show's controls go by. */
const GoLiveReaders: FC<GoLiveReadersProps> = ({ streamId }) => {
  const organisationId = useOrganisationId();
  const liveQuery = useSuspenseQuery({
    ...liveExposureListQueryOptions(organisationId),
    select: exposures => liveStreamIds(exposures).has(streamId)
  });
  return (
    <p className="text-custom-13 text-muted-foreground">
      {liveQuery.data
        ? 'The studio sees you live: a show’s controls offer you to take over.'
        : 'Waiting for the studio to see you live.'}
    </p>
  );
};

interface GoLiveDevicesProps {
  available: MediaDeviceInfo[];
  chosen: CaptureDevices;
  disabled: boolean;
  onChoose: (devices: CaptureDevices) => void;
}

/** Which camera and microphone to send, among those the browser names once it may use them. */
const GoLiveDevices: FC<GoLiveDevicesProps> = ({ available, chosen, disabled, onChoose }) => {
  const cameras = available.filter(device => device.kind === 'videoinput' && device.deviceId !== '');
  const microphones = available.filter(device => device.kind === 'audioinput' && device.deviceId !== '');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cameras.length > 1 && (
        <Field>
          <FieldLabel htmlFor="go-live-camera">Camera</FieldLabel>
          <NativeSelect
            id="go-live-camera"
            className="w-full"
            value={chosen.cameraId ?? ''}
            disabled={disabled}
            onChange={event => onChoose({ ...chosen, cameraId: event.target.value || undefined })}
          >
            <NativeSelectOption value="">The browser’s choice</NativeSelectOption>
            {cameras.map((device, index) => (
              <NativeSelectOption key={device.deviceId} value={device.deviceId}>
                {device.label || `Camera ${index + 1}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
      {microphones.length > 1 && (
        <Field>
          <FieldLabel htmlFor="go-live-microphone">Microphone</FieldLabel>
          <NativeSelect
            id="go-live-microphone"
            className="w-full"
            value={chosen.microphoneId ?? ''}
            disabled={disabled}
            onChange={event => onChoose({ ...chosen, microphoneId: event.target.value || undefined })}
          >
            <NativeSelectOption value="">The browser’s choice</NativeSelectOption>
            {microphones.map((device, index) => (
              <NativeSelectOption key={device.deviceId} value={device.deviceId}>
                {device.label || `Microphone ${index + 1}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
    </div>
  );
};
