// Sending a capture at its best for what the device can afford (README in the package description):
//
//   profile   what is asked for: size, rate, content, codecs, the ladder of renditions, sound (src/profile.ts)
//   capture   asking the camera or screen for exactly that, so the capture stack scales (src/capture.ts)
//   resolve   the codec this device encodes best, and each rendition's size and bitrate (src/resolve.ts)
//   pipeline  each rung a Mediabunny encoder, run while wanted, adapted to the network and CPU (src/pipeline.ts)
//   sinks     where the frames go: MoQ (./moq)
export {
  cameraProfile,
  screenProfile,
  type Acceleration,
  type AudioCodecName,
  type AudioContent,
  type AudioProfile,
  type BroadcastProfile,
  type QualityLevel,
  type RenditionSpec,
  type RungQuality,
  type VideoCodecName,
  type VideoContent,
  type VideoProfile
} from './profile.ts';
export {
  cameraConstraints,
  captureCamera,
  captureScreen,
  hintTracks,
  microphoneConstraints,
  screenConstraints,
  type CaptureDevices
} from './capture.ts';
export {
  BroadcastUnsupported,
  resolveBroadcast,
  type ResolvedAudio,
  type ResolvedBroadcast,
  type ResolvedVideo
} from './resolve.ts';
export { BroadcastPipeline, type PipelineOptions } from './pipeline.ts';
export { watchPressure, type PressureState } from './governor.ts';
export type {
  BroadcastSink,
  EncodedFrame,
  EncodedSink,
  EncodedTrack,
  Encoding,
  RenditionControl,
  Target
} from './sink.ts';
