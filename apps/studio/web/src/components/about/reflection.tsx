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

/** Whether the dark theme is showing: ThemeProvider keeps a `dark` class on the root element while it is. */
const subscribeToTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};
const isDarkTheme = () => document.documentElement.classList.contains('dark');
const isDarkThemeOnServer = () => false;

interface ReflectionVideoProps {
  sources: ReflectionSources;
}

/**
 * Safari only plays transparency in HEVC, and the other browsers only in VP9 WebM, so the browser picks: only Safari
 * plays QuickTime, so it takes the HEVC and everyone else falls through to the WebM. The first frame stands in as a
 * still until the video can play.
 */
const ReflectionVideo: FC<ReflectionVideoProps> = ({ sources }) => {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && <img src={sources.image} alt="" className="absolute inset-0 h-full w-full object-cover" />}
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
          setLoaded(true);
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
 * theme. A video's sources can't be switched from a stylesheet, so the theme is read here instead; switching theme
 * swaps in the other version from its still, since a video only loads the sources it starts with.
 */
export const Reflection: FC<ReflectionProps> = ({ className }) => {
  const dark = useSyncExternalStore(subscribeToTheme, isDarkTheme, isDarkThemeOnServer);
  return (
    <div aria-hidden className={cn('relative aspect-2406/684 h-full w-full opacity-50', className)}>
      <ReflectionVideo key={dark ? 'night' : 'day'} sources={dark ? NIGHT : DAY} />
    </div>
  );
};
