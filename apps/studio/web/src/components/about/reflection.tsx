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

/** The first frame, standing in until a video plays: about-hero.css picks day or night from the theme class. */
const ReflectionStill: FC = () => <div className="about-hero-reflection-still absolute inset-0" />;

interface ReflectionVideoProps {
  sources: ReflectionSources;
}

/**
 * Safari only plays transparency in HEVC, and the other browsers only in VP9 WebM, so the browser picks: only Safari
 * plays QuickTime, so it takes the HEVC and everyone else falls through to the WebM. Each mount shows the still until
 * its own first frame has painted.
 */
const ReflectionVideo: FC<ReflectionVideoProps> = ({ sources }) => {
  const [playing, setPlaying] = useState(false);
  return (
    <>
      {!playing && <ReflectionStill />}
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
          setPlaying(true);
        }}
      >
        <source src={sources.hevc} type='video/quicktime; codecs="hvc1"' />
        <source src={sources.webm} type="video/webm" />
      </video>
    </>
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
  return (
    <div
      aria-hidden
      className={cn('relative aspect-2406/684 h-full w-full opacity-50', className)}
      style={{
        '--about-hero-reflection-day': `url(${DAY.image})`,
        '--about-hero-reflection-night': `url(${NIGHT.image})`
      }}
    >
      {time ? <ReflectionVideo key={time} sources={SOURCES[time]} /> : <ReflectionStill />}
    </div>
  );
};
