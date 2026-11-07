import { useEffect, useState, type FC } from 'react';
import { frame } from '@strangecyan/vignette/frame';
import { z } from 'zod';

// A clock, as a frame: a page vignette places as a source (a browser source in OBS, an iframe in the studio) that
// keeps its own time. Frames run in the page, so unlike shows they may hold state and run timers: the show only says
// which time zone. The page is built by `vignette bundle` beside the font it is set in (`assets/fonts/Nunito.woff2`),
// which it loads from where the page is served.

/** How the time reads: hours, minutes and seconds, then the zone's short name (`2:05:09 PM CST`). */
function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });
}

const FONT_FACE = `@font-face { font-family: "Nunito"; src: url("assets/fonts/Nunito.woff2") format("woff2"); font-weight: 200 1000; font-display: block; }`;

const ClockParamsSchema = z.object({
  /** An IANA time zone, such as `America/Chicago`. */
  timeZone: z.string().min(1)
});
export type ClockParams = z.output<typeof ClockParamsSchema>;

/** The time in `timeZone`, right-aligned in white Nunito, ticking each second. */
const ClockView: FC<ClockParams> = ({ timeZone }) => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const text = formatter(timeZone).format(now);
  return (
    <>
      <style>{FONT_FACE}</style>
      <div
        style={{
          boxSizing: 'border-box',
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '0 24px',
          fontFamily: 'Nunito, sans-serif',
          fontWeight: 700,
          fontSize: '48px',
          fontVariantNumeric: 'tabular-nums',
          color: '#ffffff',
          textShadow: '0 2px 8px rgba(0, 0, 0, 0.6)',
          whiteSpace: 'nowrap'
        }}
      >
        {text}
      </div>
    </>
  );
};

export const Clock = frame({ name: 'Clock', params: ClockParamsSchema, view: ClockView });
