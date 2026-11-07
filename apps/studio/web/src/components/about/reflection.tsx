import { useState, useSyncExternalStore, type FC } from 'react';
import { cn } from '@conservationtv/ui/lib/utils';

import reflectionImage from '@/assets/about/reflection-first-frame-alpha.webp';
import reflectionHevc from '@/assets/about/reflection-hevc.mov';
import reflectionWebm from '@/assets/about/reflection.webm';
import reflectionNightImage from '@/assets/about/reflection-night-first-frame-alpha.webp';
import reflectionNightHevc from '@/assets/about/reflection-night-hevc.mov';
import reflectionNightWebm from '@/assets/about/reflection-night.webm';

/** One version of the reflection: its first frame as a still, and the video in both formats. */
interface ReflectionSources {
  image: string;
  hevc: string;
  webm: string;
}

const DAY: ReflectionSources = { image: reflectionImage, hevc: reflectionHevc, webm: reflectionWebm };
/** Graded to match the dark theme's night landscape; see about-hero.css. */
const NIGHT: ReflectionSources = { image: reflectionNightImage, hevc: reflectionNightHevc, webm: reflectionNightWebm };

declare module 'react' {
  interface CSSProperties {
    /** The reflection's first frame by day, and by night for the dark theme; see about-hero.css. */
    '--about-hero-reflection-day'?: string;
    '--about-hero-reflection-night'?: string;
  }
}

type Time = 'day' | 'night';
const SOURCES = { day: DAY, night: NIGHT } satisfies Record<Time, ReflectionSources>;

/** Whether the dark theme is showing: ThemeProvider keeps a `dark` class on the root element while it is. */
const subscribeToTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};
const readTime = (): Time => (document.documentElement.classList.contains('dark') ? 'night' : 'day');
/** The pre-rendered page can't know the theme, so it has no video, only the still that about-hero.css picks. */
const readTimeOnServer = () => null;

interface ReflectionVideoProps {
  sources: ReflectionSources;
  /** Called once the video's first frame has painted, so the still behind it can go. */
  onPlaying: () => void;
}

/**
 * Safari only plays transparency in HEVC, and the other browsers only in VP9 WebM, so the browser picks: only Safari
 * plays QuickTime, so it takes the HEVC and everyone else falls through to the WebM.
 */
const ReflectionVideo: FC<ReflectionVideoProps> = ({ sources, onPlaying }) => {
  return (
    <video
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      className="absolute inset-0 h-full w-full object-cover"
      onCanPlay={async () => {
        // A beat for the first frame to paint, so swapping out the still doesn't flash.
        await new Promise(resolve => setTimeout(resolve, 100));
        onPlaying();
      }}
    >
      <source src={sources.hevc} type='video/quicktime; codecs="hvc1"' />
      <source src={sources.webm} type="video/webm" />
    </video>
  );
};

export interface ReflectionProps {
  className?: string;
}

/**
 * The sky's reflection rippling in the water, as a looping video with transparency, by day or by night to match the
 * theme. Its first frame stands in as a still until the video plays, chosen by about-hero.css from the theme class the
 * pre-paint script sets, so the pre-rendered page shows the right one. A video's sources can't be switched from a
 * stylesheet, so it mounts once the app has read the theme; switching theme swaps in the other version from its still,
 * since a video only loads the sources it starts with.
 */
export const Reflection: FC<ReflectionProps> = ({ className }) => {
  const time = useSyncExternalStore(subscribeToTheme, readTime, readTimeOnServer);
  const [playing, setPlaying] = useState<Time | null>(null);
  return (
    <div
      aria-hidden
      className={cn('relative aspect-2406/684 h-full w-full opacity-50', className)}
      style={{
        '--about-hero-reflection-day': `url(${DAY.image})`,
        '--about-hero-reflection-night': `url(${NIGHT.image})`
      }}
    >
      {(time === null || playing !== time) && <div className="about-hero-reflection-still absolute inset-0" />}
      {time && <ReflectionVideo key={time} sources={SOURCES[time]} onPlaying={() => setPlaying(time)} />}
    </div>
  );
};
