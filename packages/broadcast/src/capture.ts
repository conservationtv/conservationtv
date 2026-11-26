import type { AudioProfile, BroadcastProfile, VideoProfile } from './profile.ts';

// Capturing for a profile. The cheapest pixels are the ones never made: the camera (or the browser's screen
// capturer) is asked for the size and rate the profile sends, so scaling happens in the capture stack, often on the
// camera's own ISP, rather than on the CPU afterwards. Sound is asked for with the processing its content wants, and
// each track is told what it carries, which steers how the browser's encoders and the capture itself trade quality.

/** The devices to capture from: undefined for whichever the browser chooses. */
export interface CaptureDevices {
  cameraId?: string;
  microphoneId?: string;
}

/** What to ask a camera for: the profile's picture, as an ideal the camera comes as close to as it can. */
export function cameraConstraints(video: VideoProfile, cameraId?: string): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    width: { ideal: video.width },
    height: { ideal: video.height },
    frameRate: { ideal: video.frameRate }
  };
  if (cameraId !== undefined) constraints.deviceId = { exact: cameraId };
  return constraints;
}

/** What to ask a screen capture for: no larger than the profile's picture and no faster than its rate. */
export function screenConstraints(video: VideoProfile): MediaTrackConstraints {
  return {
    width: { max: video.width },
    height: { max: video.height },
    frameRate: { ideal: video.frameRate, max: video.frameRate }
  };
}

/**
 * What to ask a microphone for. Voice processing is for speech only: echo cancellation, noise suppression and gain
 * control pump and smear anything else, and force mono. Everything else is asked for untouched, in the profile's
 * channels, at 48 kHz, so nothing is resampled on the way to Opus.
 */
export function microphoneConstraints(audio: AudioProfile, microphoneId?: string): MediaTrackConstraints {
  const processed = audio.content === 'speech';
  const constraints: MediaTrackConstraints = {
    echoCancellation: processed,
    noiseSuppression: processed,
    autoGainControl: processed,
    channelCount: { ideal: audio.channels },
    sampleRate: { ideal: audio.sampleRate }
  };
  if (microphoneId !== undefined) constraints.deviceId = { exact: microphoneId };
  return constraints;
}

/** Tell each track what it carries, as the profile says: encoders and the capture itself steer by it. */
export function hintTracks(media: MediaStream, profile: BroadcastProfile): void {
  for (const track of media.getVideoTracks()) track.contentHint = profile.video.content;
  const audio = profile.audio;
  if (audio === undefined) return;
  for (const track of media.getAudioTracks()) track.contentHint = audio.content === 'speech' ? 'speech' : 'music';
}

/** Capture from a camera and its microphone for a profile. Asks for permission. */
export async function captureCamera(profile: BroadcastProfile, devices: CaptureDevices = {}): Promise<MediaStream> {
  const audio = profile.audio === undefined ? false : microphoneConstraints(profile.audio, devices.microphoneId);
  const media = await navigator.mediaDevices.getUserMedia({
    video: cameraConstraints(profile.video, devices.cameraId),
    audio
  });
  hintTracks(media, profile);
  return media;
}

/** Capture a screen, window or tab for a profile, with any sound it shares. Asks for permission. */
export async function captureScreen(profile: BroadcastProfile): Promise<MediaStream> {
  // Shared sound is the page's or the system's own, never a voice to clean up, so it is asked for untouched.
  const audio: MediaTrackConstraints | false =
    profile.audio === undefined ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const media = await navigator.mediaDevices.getDisplayMedia({ video: screenConstraints(profile.video), audio });
  hintTracks(media, profile);
  return media;
}
