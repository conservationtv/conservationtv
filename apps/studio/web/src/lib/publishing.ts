import type { Audio, Net, Signals, Video } from '@moq/publish';

// Publishing from this browser (docs/shows.md, Going live): what it captures, what it can send, and the two ways it
// sends it. Plain I/O, like src/lib/agent-connection.ts; the page decides when (src/components/go-live).
//
//   MoQ   straight to conservation.tv, with the moq project's own publisher (`@moq/publish`, encoding with WebCodecs),
//         where the browser can: it is asked at runtime (`canPublishMoq`), never assumed, since Safari on an iPhone
//         may have neither WebTransport nor a WebCodecs encoder.
//   WHIP  WebRTC to a MediaMTX gateway, with the browser's own RTCPeerConnection: what any browser can send.
//
// The API chooses which, from the protocols this browser names in its order of preference and where its person says
// they are (`organisations.streams.connect`, `action: publish`).

/** What is captured: a camera (and its microphone), or a screen, window or tab. */
export type CaptureSource = 'camera' | 'screen';

/** The devices to capture from: undefined for whichever the browser chooses. */
export interface CaptureDevices {
  cameraId?: string;
  microphoneId?: string;
}

/** The picture asked of a camera: 720p at 30 fps, which a phone sends comfortably and a show's slots draw well. */
const CAMERA_VIDEO: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 }
};

/** Capture from a camera and its microphone, or a screen with any sound it shares. Asks for permission. */
export async function capture(source: CaptureSource, devices: CaptureDevices): Promise<MediaStream> {
  if (source === 'screen') return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const camera = devices.cameraId === undefined ? {} : { deviceId: { exact: devices.cameraId } };
  const microphone = devices.microphoneId === undefined ? true : { deviceId: { exact: devices.microphoneId } };
  return navigator.mediaDevices.getUserMedia({ video: { ...CAMERA_VIDEO, ...camera }, audio: microphone });
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
 * The protocols this browser can publish by, in its order of preference: MoQ first where it has WebTransport and can
 * encode with WebCodecs, after WebRTC where it would have to fall back to a WebSocket, and not at all where it cannot
 * encode; WebRTC (WHIP) wherever there is an RTCPeerConnection.
 */
export async function publishProtocols(): Promise<string[]> {
  const webrtc = 'RTCPeerConnection' in window ? ['webrtc'] : [];
  const moq = await moqSupport();
  if (moq === 'full') return ['moq', ...webrtc];
  if (moq === 'partial') return [...webrtc, 'moq'];
  return webrtc;
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

/** Where to publish by URL: a WHIP endpoint, and the token to present as a bearer token. */
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

/** The largest picture of the smaller rung published beside the capture's own: a 640-wide slot's (docs/shows.md, Sizes). */
const SMALL_RUNG_PIXELS = 640 * 360;

/**
 * Publish the capture over MoQ as the broadcast readers watch: its picture as it is captured, a 640-wide one beside it
 * for small slots (each encoded only while someone watches it), and its sound. The connection redials by itself when
 * it drops, for as long as the session lasts, with whatever credential it was last handed.
 */
export async function publishMoq(
  media: MediaStream,
  target: MoqTarget,
  events: SessionEvents
): Promise<PublishSession> {
  const Publish = await import('@moq/publish');
  // Retry for as long as the session lasts: a phone between networks comes back.
  const delay: Net.Connection.Backoff = { timeout: Publish.Net.Time.Milli(0) };
  const connection = new Publish.Net.Connection({ url: relayUrl(target), enabled: true, delay });
  const broadcast = new Publish.Broadcast({
    origin: connection.origin,
    enabled: true,
    name: Publish.Net.Path.from(target.broadcast)
  });
  const closers: (() => void)[] = [];
  const [video] = media.getVideoTracks();
  if (video !== undefined) {
    // SAFETY: a video track from getUserMedia or getDisplayMedia, which is what the publisher's `StreamTrack` describes.
    const capture = new Publish.Video.Capture({ source: video as Video.StreamTrack });
    const bandwidth = connection.bandwidth;
    const large = new Publish.Video.Encoder('video/source', { broadcast, capture, bandwidth, enabled: true });
    const small = new Publish.Video.Encoder('video/small', {
      broadcast,
      capture,
      bandwidth,
      enabled: true,
      config: { maxPixels: SMALL_RUNG_PIXELS }
    });
    closers.push(
      () => small.close(),
      () => large.close(),
      () => capture.close()
    );
  }
  const [audio] = media.getAudioTracks();
  if (audio !== undefined) {
    // SAFETY: an audio track from getUserMedia or getDisplayMedia, as the publisher's audio `StreamTrack` describes.
    const capture = new Publish.Audio.Capture({ source: audio as Audio.StreamTrack, enabled: true });
    const encoder = new Publish.Audio.Encoder('audio/source', { broadcast, capture, enabled: true });
    closers.push(
      () => encoder.close(),
      () => capture.close()
    );
  }
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
      for (const close of closers) close();
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

/** How long to wait for ICE candidates before offering what has been gathered: MediaMTX takes no trickled ones here. */
const ICE_GATHERING_MS = 2_000;

/** How long a WebRTC peer may stay `disconnected` before the session is given up as lost. */
const DISCONNECTED_GRACE_MS = 5_000;

/** A WHIP endpoint's refusal, with its HTTP status: 404 while the gateway's agent has not yet served the path. */
export class WhipRefused extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      status === 404
        ? 'The gateway isn’t taking this stream yet.'
        : status === 401
          ? 'The gateway refused the credential.'
          : `The gateway answered HTTP ${status}.`
    );
    this.status = status;
  }
}

/**
 * Publish the capture over WebRTC to a WHIP endpoint, presenting the token as a bearer token: H.264 first where the
 * browser can choose, which is what the gateway republishes to conservation.tv. Throws `WhipRefused` if the endpoint
 * refuses. The session is live while the peer connection is connected; a connection that fails, closes, or stays
 * disconnected past a short grace is lost for good, and the caller asks again for another.
 */
export async function publishWhip(
  media: MediaStream,
  target: UrlTarget,
  events: SessionEvents
): Promise<PublishSession> {
  const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  for (const track of media.getTracks()) {
    const transceiver = peer.addTransceiver(track, { direction: 'sendonly', streams: [media] });
    if (track.kind === 'video') preferH264(transceiver);
  }
  events.onState('connecting');
  let resource: string | undefined = undefined;
  // `disconnected` is often a moment's loss that ICE recovers from by itself (a phone handing over between networks);
  // only one that lasts, or a peer that has failed or closed, ends the session.
  let grace: ReturnType<typeof setTimeout> | undefined = undefined;
  const endGrace = () => {
    clearTimeout(grace);
    grace = undefined;
  };
  peer.addEventListener('connectionstatechange', () => {
    // Any state but `disconnected` ends a grace; the first `disconnected` starts one, which ends the session only if
    // the peer is still disconnected when it runs out.
    const state = peer.connectionState;
    if (state !== 'disconnected') endGrace();
    if (state === 'connected') events.onState('live');
    else if (state === 'failed' || state === 'closed') events.onState('lost');
    else if (state === 'disconnected' && grace === undefined) {
      events.onState('connecting');
      grace = setTimeout(() => {
        grace = undefined;
        if (peer.connectionState === 'disconnected') events.onState('lost');
      }, DISCONNECTED_GRACE_MS);
    }
  });
  try {
    // Offer what has been gathered, with the token where there is one; anything but `201 Created` is a refusal. The
    // session's own URL, for ending it, is its `Location`, if the gateway gives one.
    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer);
    const headers = new Headers({ 'Content-Type': 'application/sdp' });
    if (target.token !== undefined) headers.set('Authorization', `Bearer ${target.token}`);
    const response = await fetch(target.url, { method: 'POST', headers, body: peer.localDescription?.sdp });
    if (response.status !== 201) throw new WhipRefused(response.status);
    const location = response.headers.get('Location');
    resource = location === null ? undefined : new URL(location, target.url).href;
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) {
    endGrace();
    peer.close();
    throw error;
  }
  return {
    // A WebRTC session is admitted once, when it starts: a renewed token is for the next one.
    renew: () => undefined,
    close: () => {
      endGrace();
      peer.close();
      // Ending the session at the gateway frees its path at once, rather than when the peer times out.
      if (resource !== undefined) void fetch(resource, { method: 'DELETE' }).catch(() => undefined);
    }
  };
}

/** Put H.264 first among the video codecs the transceiver offers, where the browser lets it be chosen. */
function preferH264(transceiver: RTCRtpTransceiver) {
  const capabilities = RTCRtpSender.getCapabilities?.('video');
  if (capabilities === null || capabilities === undefined || !('setCodecPreferences' in transceiver)) return;
  const h264 = capabilities.codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264');
  const others = capabilities.codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h264');
  if (h264.length > 0) transceiver.setCodecPreferences([...h264, ...others]);
}

/** Once the peer has gathered its ICE candidates, or `ICE_GATHERING_MS` has passed. */
function gathered(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (peer.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHERING_MS);
    peer.addEventListener('icegatheringstatechange', check);
  });
}
