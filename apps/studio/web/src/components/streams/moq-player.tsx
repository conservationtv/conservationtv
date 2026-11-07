import { useEffect, useRef, type FC } from 'react';
import type { Net } from '@moq/watch';

export interface MoqPlayerProps {
  /** The relay URL to dial, carrying its credential as `?jwt=`. */
  url: string;
  /** The broadcast to watch under it. */
  broadcast: string;
  className?: string;
}

/**
 * Plays a MoQ broadcast into a canvas, muted, whether or not it's on screen. A renewed credential is a new `url`, which
 * is set on the open connection's signal: the player stays, and the connection redials. A different broadcast starts
 * a new player.
 */
export const MoqPlayer: FC<MoqPlayerProps> = ({ url, broadcast, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connectionRef = useRef<Net.Connection | null>(null);
  // The URL a connection opened after the player loads starts from.
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
    connectionRef.current?.url.set(new URL(url));
  }, [url]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The player is loaded only once one mounts, so the page doesn't carry it until something plays.
    let release: (() => void) | undefined = undefined;
    let unmounted = false;
    void import('@moq/watch').then(Watch => {
      if (unmounted) return;
      const connection = new Watch.Net.Connection({ url: new URL(urlRef.current), enabled: true });
      const player = new Watch.Player({
        origin: connection.origin,
        probe: connection.probe,
        name: Watch.Net.Path.from(broadcast),
        canvas,
        enabled: true,
        muted: true,
        // Keep downloading and drawing video off screen and in a background tab, rather than pausing until it's seen.
        visible: 'always'
      });
      connectionRef.current = connection;
      release = () => {
        connectionRef.current = null;
        player.close();
        connection.close();
      };
    });
    return () => {
      unmounted = true;
      release?.();
    };
  }, [broadcast]);
  return <canvas ref={canvasRef} className={className} />;
};
