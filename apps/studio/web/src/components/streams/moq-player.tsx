import { useEffect, useRef, useState, type FC } from 'react';
import type { Net, Player, Signals, Video } from '@moq/watch';

export interface MoqPlayerProps {
  /** The relay URL to dial, carrying its credential as `?jwt=`. */
  url: string;
  /** The broadcast to watch under it. */
  broadcast: string;
  className?: string;
  /** The canvas it draws into, for whatever else shows its picture (a show's delay line). */
  ref?: (canvas: HTMLCanvasElement | null) => void;
  /** Whether to fetch and draw its picture. Without, it is heard only: nothing is drawn and no video is fetched. */
  video?: boolean;
  /**
   * Takes its sound, as a stream of the decoded audio, for something else to play (a show's mixer): the player itself
   * stays silent. Called with undefined while there is none. Without it, no audio is fetched at all.
   */
  onAudio?: (audio: MediaStream | undefined) => void;
}

/**
 * Plays a MoQ broadcast into a canvas, whether or not it's on screen, and never out loud. A renewed credential is a new
 * `url`, which is set on the open connection's signal: the player stays, and the connection redials. A different
 * broadcast starts a new player.
 *
 * The canvas is marked `data-picture` while it shows a picture: the broadcast is announced, a frame has been drawn and
 * frames are still arriving. Otherwise the player paints it black, so a caller that wants whatever is beneath to show
 * through hides it without the mark (`opacity-0 data-picture:opacity-100`). It asks for the picture in the broadcast's
 * catalog closest to the size it is drawn at, in device pixels, as that changes.
 */
export const MoqPlayer: FC<MoqPlayerProps> = ({ url, broadcast, className, ref, video = true, onAudio }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connectionRef = useRef<Net.Connection | null>(null);
  const [picture, setPicture] = useState(false);
  // The URL, and who takes the sound, that a player loaded later starts from; then signals the running player follows.
  const urlRef = useRef(url);
  const onAudioRef = useRef(onAudio);
  const takerRef = useRef<Signals.Signal<AudioTaker | undefined> | null>(null);
  useEffect(() => {
    urlRef.current = url;
    connectionRef.current?.url.set(new URL(url));
  }, [url]);
  // Who takes the sound changes without a new player: one taken from it, or handed to it, keeps its picture playing.
  useEffect(() => {
    onAudioRef.current = onAudio;
    takerRef.current?.set(onAudio);
  }, [onAudio]);
  useEffect(() => {
    const canvas = video ? (canvasRef.current ?? undefined) : undefined;
    // The player is loaded only once one mounts, so the page doesn't carry it until something plays.
    let release: (() => void) | undefined = undefined;
    let unmounted = false;
    void import('@moq/watch').then(Watch => {
      if (unmounted) return;
      const connection = new Watch.Net.Connection({ url: new URL(urlRef.current), enabled: true });
      const target = new Watch.Signals.Signal<Video.Target | undefined>(undefined);
      const taker = new Watch.Signals.Signal<AudioTaker | undefined>(onAudioRef.current);
      // Sound is fetched and decoded only while someone takes it.
      const muted = new Watch.Signals.Derived([taker], take => take === undefined);
      const player = new Watch.Player({
        origin: connection.origin,
        probe: connection.probe,
        name: Watch.Net.Path.from(broadcast),
        canvas,
        target,
        enabled: true,
        // The player's own output is turned all the way down, so whoever takes its sound decides whether it is heard.
        muted,
        volume: 0,
        // Keep downloading and drawing video off screen and in a background tab, rather than pausing until it's seen.
        visible: canvas ? 'always' : 'never'
      });
      const watching = new Watch.Signals.Effect();
      watching.run(effect => setPicture(canvas !== undefined && showsPicture(effect, player)));
      watching.run(effect => {
        const take = effect.get(taker);
        if (take !== undefined) handOverAudio(effect, player, take);
      });
      const stopSizing = canvas ? followDrawnSize(canvas, target) : undefined;
      connectionRef.current = connection;
      takerRef.current = taker;
      release = () => {
        connectionRef.current = null;
        takerRef.current = null;
        stopSizing?.();
        watching.close();
        player.close();
        connection.close();
      };
    });
    return () => {
      unmounted = true;
      release?.();
      setPicture(false);
    };
  }, [broadcast, video]);
  if (!video) return null;
  const attach = (canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    ref?.(canvas);
  };
  return <canvas ref={attach} className={className} data-picture={picture ? '' : undefined} />;
};

/** Whether the player shows a picture: the broadcast is announced, a frame is drawn, and frames are still arriving. */
function showsPicture(effect: Signals.Effect, player: Player): boolean {
  const live = effect.get(player.broadcast.out.status) === 'live';
  const drawn = effect.get(player.renderer.out.frame) !== undefined;
  const stalled = effect.get(player.video.out.stalled);
  return live && drawn && !stalled;
}

/** Who takes a player's sound: handed a stream of it, and undefined once there is none for them. */
type AudioTaker = (audio: MediaStream | undefined) => void;

/**
 * Hands the player's decoded sound over as a `MediaStream`, bridged out of the player's own `AudioContext` (where
 * `audio.out.root` lives) by a destination node in that context; undefined while there is none. Whoever it was handed
 * to is the one told it is gone, even once someone else, or nobody, takes the sound.
 */
function handOverAudio(effect: Signals.Effect, player: Player, take: AudioTaker) {
  const context = effect.get(player.audio.out.context);
  const root = effect.get(player.audio.out.root);
  if (!context || !root) {
    take(undefined);
    return;
  }
  const destination = new MediaStreamAudioDestinationNode(context);
  root.connect(destination);
  take(destination.stream);
  effect.cleanup(() => {
    root.disconnect(destination);
    take(undefined);
  });
}

/** How often to look at the drawn size again regardless, for a scale an ancestor's transform changed. */
const RESIZE_BACKSTOP_MS = 2000;

/**
 * Keeps `target` at the size the canvas is drawn at, in device pixels: on a resize of the canvas or of the vignette
 * stage around it, on a window resize (which also catches a change of pixel ratio), and every couple of seconds for a
 * scale applied by a transform, which no resize reports (a stage scales its scene; a show's slot scales its source).
 */
function followDrawnSize(canvas: HTMLCanvasElement, target: Signals.Signal<Video.Target | undefined>): () => void {
  // Set only when the size changed: any new target, even an equal one, has the player choose its picture again.
  const measure = () => {
    const next = drawnSize(canvas);
    const current = target.peek();
    if (next?.width === current?.width && next?.height === current?.height) return;
    target.set(next);
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(canvas);
  const stage = canvas.closest('[data-vignette-stage]');
  if (stage) observer.observe(stage);
  window.addEventListener('resize', measure);
  const backstop = window.setInterval(measure, RESIZE_BACKSTOP_MS);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', measure);
    window.clearInterval(backstop);
  };
}

/** The canvas's drawn size in device pixels, transforms included; undefined while it is not drawn at all. */
function drawnSize(canvas: HTMLCanvasElement): Video.Target | undefined {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return undefined;
  const ratio = window.devicePixelRatio || 1;
  return { width: Math.round(rect.width * ratio), height: Math.round(rect.height * ratio) };
}
