import {
  cameraProfile,
  captureCamera,
  captureScreen,
  screenProfile,
  type BroadcastPipeline,
  type BroadcastProfile,
  type CaptureDevices
} from '@conservationtv/broadcast';
import type { Net, Signals } from '@moq/publish';

// Publishing from this browser (docs/shows.md, Going live): what it captures, whether it can send it, and sending it.
// Plain I/O, like src/lib/agent-connection.ts; the page decides when (src/components/go-live).
//
// What is sent is a broadcast pipeline (`@conservationtv/broadcast`): the source's profile (a camera's or a
// screen's: nothing for its person to choose), resolved against the encoders this device has, captured at the size
// it is sent, and encoded by Mediabunny as a ladder of sizes, each only while someone watches it. It goes by MoQ,
// straight to conservation.tv, where the browser can: that is asked at runtime (`publishProtocols`), never assumed,
// since Safari on an iPhone may have neither WebTransport nor a WebCodecs encoder. Going live by WebRTC (WHIP to a
// gateway) is not offered for now: a WebRTC reader picks no size, and the gateway drops its sound.

export type { CaptureDevices } from '@conservationtv/broadcast';

/** What is captured: a camera (and its microphone), or a screen, window or tab. */
export type CaptureSource = 'camera' | 'screen';

/** The profile a source is sent by: a camera's or a screen's. */
export function profileFor(source: CaptureSource): BroadcastProfile {
  return source === 'screen' ? screenProfile() : cameraProfile();
}

/**
 * Capture from a camera and its microphone, or a screen with any sound it shares, as its profile asks: its largest
 * size and rate, and sound untouched by voice processing. Asks for permission.
 */
export async function capture(source: CaptureSource, devices: CaptureDevices): Promise<MediaStream> {
  const profile = profileFor(source);
  return source === 'screen' ? captureScreen(profile) : captureCamera(profile, devices);
}

/** Whether this browser can share a screen: no phone browser can. */
export function canShareScreen(): boolean {
  return 'mediaDevices' in navigator && 'getDisplayMedia' in navigator.mediaDevices;
}

/** The cameras and microphones there are; named once permission has been given. */
export async function captureDevices(): Promise<MediaDeviceInfo[]> {
  if (!('mediaDevices' in navigator)) return [];
  return navigator.mediaDevices.enumerateDevices();
}

/** Stop everything a capture holds, so the camera's light goes off. */
export function release(media: MediaStream | undefined): void {
  for (const track of media?.getTracks() ?? []) track.stop();
}

/** Which kind of device this is, for the stream its person goes live on from it: "Ada's phone", "Ada's computer". */
export function personalDevice(): 'phone' | 'computer' {
  const { userAgent, maxTouchPoints } = navigator;
  // iPadOS says it is a Mac, but a Mac has no touch screen.
  const tablet = /Macintosh/u.test(userAgent) && maxTouchPoints > 1;
  return tablet || /Android|iPhone|iPad|iPod|Mobile/u.test(userAgent) ? 'phone' : 'computer';
}

/**
 * The protocols this browser can publish by: MoQ where it can encode with WebCodecs (over WebTransport, or a
 * WebSocket where it has none), and none where it cannot.
 */
export async function publishProtocols(): Promise<string[]> {
  return (await moqSupport()) === 'none' ? [] : ['moq'];
}

/** How well `@moq/publish` works here: `full` with WebTransport, `partial` over a WebSocket, `none` without encoders. */
async function moqSupport(): Promise<'full' | 'partial' | 'none'> {
  try {
    // Each of encoding, capturing and sound is needed; then WebTransport decides between full and partial. The
    // support module itself failing to load (an old browser) is no support.
    const { isSupported } = await import('@moq/publish/support');
    const support = await isSupported();
    const codecs = support.video.encoding;
    const encodes =
      codecs !== undefined && Object.values(codecs).some(codec => codec.software || codec.hardware === true);
    const captures = support.video.capture !== 'none' && support.audio.capture;
    const sounds = support.audio.encoding.opus !== 'none' || support.audio.encoding.aac;
    if (!encodes || !captures || !sounds) return 'none';
    return support.webtransport === 'full' ? 'full' : 'partial';
  } catch {
    return 'none';
  }
}

/** Where a session is: dialling, sending, or cut off and trying again. */
export type SessionState = 'connecting' | 'live' | 'lost';

/** What a session reports as it goes. */
export interface SessionEvents {
  onState: (state: SessionState, detail?: string) => void;
}

/** A session sending a capture: told of a renewed credential, and closed when it is done. */
export interface PublishSession {
  /** Hand over a renewed credential, for the connection's next dial. */
  renew: (connection: PublishConnection) => void;
  close: () => void;
}

/** Where to publish over MoQ: the relay, the path on it the token is scoped to, and the broadcast under it. */
export interface MoqTarget {
  protocol: 'moq';
  relay: string;
  path: string;
  broadcast: string;
  token?: string;
}

/** Where to publish by URL (a WHIP endpoint, and its bearer token): what the API may answer, never asked for here. */
export interface UrlTarget {
  protocol: string;
  url: string;
  token?: string;
}

/** A publishing connection as the API gives one. */
export type PublishConnection = MoqTarget | UrlTarget;

/** The relay URL to dial at the path, carrying the token as `?jwt=`, as readers dial it too. */
function relayUrl(connection: MoqTarget): URL {
  const url = new URL(connection.path, connection.relay);
  if (connection.token !== undefined) url.searchParams.set('jwt', connection.token);
  return url;
}

/**
 * Publish a pipeline over MoQ as the broadcast readers watch: its renditions (the capture's picture, and a smaller one
 * beside it for small slots), each encoded only while someone watches it and limited to its share of the connection,
 * and its sound. The connection redials by itself when it drops, for as long as the session lasts, with whatever
 * credential it was last handed.
 */
export async function publishMoq(
  pipeline: BroadcastPipeline,
  target: MoqTarget,
  events: SessionEvents
): Promise<PublishSession> {
  const [Publish, { moqSink }] = await Promise.all([import('@moq/publish'), import('@conservationtv/broadcast/moq')]);
  // Retry for as long as the session lasts: a phone between networks comes back.
  const delay: Net.Connection.Backoff = { timeout: Publish.Net.Time.Milli(0) };
  const connection = new Publish.Net.Connection({ url: relayUrl(target), enabled: true, delay });
  const broadcast = new Publish.Broadcast({
    origin: connection.origin,
    enabled: true,
    name: Publish.Net.Path.from(target.broadcast)
  });
  const disconnect = pipeline.connect(moqSink(broadcast, { bandwidth: connection.bandwidth }));
  const watching = new Publish.Signals.Effect();
  watching.run(effect => reportStatus(effect, connection, events));
  // A renewed credential waits for the next dial. A new URL reconnects at once, so handing it over while connected
  // would drop and re-announce the broadcast on every renewal; the relay checks a token when a session connects, so
  // the session it admitted carries on. Once the connection is down (dropped, between retries, or refused for a
  // credential that has since expired) the renewed URL is dialled straight away.
  const renewed = new Publish.Signals.Signal<URL | undefined>(undefined);
  watching.run(effect => {
    const next = effect.get(renewed);
    if (next === undefined || effect.get(connection.status) === 'connected') return;
    renewed.set(undefined);
    connection.url.set(next);
  });
  return {
    renew: next => {
      if (next.protocol === 'moq' && 'relay' in next) renewed.set(relayUrl(next));
    },
    close: () => {
      watching.close();
      disconnect();
      broadcast.close();
      connection.close();
    }
  };
}

/** The connection's status as the session's state: connected is live, since the broadcast is announced while it is. */
function reportStatus(effect: Signals.Effect, connection: Net.Connection, events: SessionEvents) {
  const status = effect.get(connection.status);
  const error = effect.get(connection.error);
  if (status === 'connected') events.onState('live');
  else if (status === 'connecting') events.onState('connecting');
  else events.onState('lost', error?.message);
}
