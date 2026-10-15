import type { FC } from 'react';

import type { Route } from './+types/about';
import backgroundImage from '@/assets/about/background.webp';
import backgroundNightImage from '@/assets/about/background-night.webp';
import cloudsImage from '@/assets/about/clouds.webp';
import { AnimatedButterfly } from '@/components/about/butterfly';
import { Fireflies } from '@/components/about/fireflies';
import { Frame } from '@/components/about/frame';
import { NightStars } from '@/components/about/night-stars';
import { Reflection } from '@/components/about/reflection';
import '@/components/about/about-hero.css';

declare module 'react' {
  interface CSSProperties {
    /** The cloud image, painted on the clouds' own layer so dark mode can filter it alone; see about-hero.css. */
    '--about-hero-clouds-image'?: string;
    /** The landscape by day, and by night for the dark theme; see about-hero.css. */
    '--about-hero-landscape-day'?: string;
    '--about-hero-landscape-night'?: string;
    /** How long a loop of the clouds' drift takes; see about-hero.css. */
    '--cloud-drift-duration'?: string;
  }
}

/** Seconds per loop of the clouds' drift, handed to about-hero.css as `--cloud-drift-duration`. */
const CLOUD_DRIFT_DURATION_SECONDS = 120;

export const meta: Route.MetaFunction = () => [
  { title: 'About · conservation.tv' },
  {
    name: 'description',
    content:
      "We're a collaborative network of organizations, communities, and individuals who believe 24/7 live cameras and streaming are powerful conservation tools."
  }
];

/**
 * The illustration's layers start loading with the page, so the scene comes in whole. The landscape and the reflection
 * aren't among them: each has a day and a night version, and which one shows depends on the theme.
 */
export const links: Route.LinksFunction = () => [{ rel: 'preload', as: 'image', href: cloudsImage }];

/** Starts the clouds where the wall clock puts them in their loop, so they drift on across reloads; see about-hero.css. */
const syncCloudDrift = (node: HTMLDivElement | null) => {
  // React hands the ref null as the element detaches; there is nothing to sync then.
  if (!node) return;
  const phase = (Date.now() % (CLOUD_DRIFT_DURATION_SECONDS * 1000)) / 1000;
  node.style.setProperty('--cloud-drift-phase', `${phase}s`);
};

/**
 * The about page: a dawn landscape watched through camera viewfinders, with clouds drifting over the sky, the sky
 * rippling in the lake and butterflies in one of the frames. In the dark theme it turns to night: a night sky with
 * stars and faint clouds, night versions of the landscape and reflection, and fireflies around the animals. The text
 * sits halfway between the theme's foreground and secondary text colours.
 */
const AboutRoute: FC = () => {
  return (
    <div className="mx-auto max-w-400 overflow-clip text-[color-mix(in_oklab,var(--foreground),var(--custom-text-secondary))] min-[100rem]:mt-8 min-[100rem]:rounded-t-3xl">
      <div className="about-hero-sky relative">
        {/* At night, stars come out in the sky, behind the clouds. */}
        <NightStars className="pointer-events-none absolute inset-0 z-0 hidden size-full dark:block" />

        <div
          ref={syncCloudDrift}
          style={{
            '--about-hero-clouds-image': `url(${cloudsImage})`,
            '--cloud-drift-duration': `${CLOUD_DRIFT_DURATION_SECONDS}s`
          }}
          className="about-hero-clouds z-0 flex w-full flex-col pt-20 pb-15"
        >
          <div className="relative z-10 mb-[min(10vw,160px)] flex flex-col items-center gap-4 px-6">
            {/* A haze behind the words, lifting them off the sky: light by day, and the night sky's colour at night. */}
            <div className="pointer-events-none absolute top-1/2 left-1/2 h-44 w-[min(92vw,700px)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/60 blur-3xl dark:bg-[#151412]/60" />
            <h1 className="relative z-10 w-full max-w-xl text-center text-3xl font-semibold text-balance sm:text-5xl">
              Next generation conservation
            </h1>
            <p className="relative z-10 max-w-2xl text-center leading-tight text-balance">
              We're a collaborative network of organizations, communities, and individuals who believe 24/7 live cameras
              and streaming are powerful conservation tools.
            </p>
          </div>
        </div>

        {/* The landscape rises over the bottom of the sky; the reflection shows through the lake, behind it. */}
        <div className="pointer-events-none relative z-10 -mt-[min(10vw,160px)] select-none">
          {/* A background rather than an img, so the browser only fetches the version for the theme that's showing. */}
          <div
            className="about-hero-landscape relative z-20 w-full"
            style={{
              '--about-hero-landscape-day': `url(${backgroundImage})`,
              '--about-hero-landscape-night': `url(${backgroundNightImage})`
            }}
          />
          <Reflection className="absolute top-[26%] left-1/2 z-10 h-[25%] w-[70%] -translate-x-1/2" />

          <div className="absolute inset-0 z-20">
            <Frame position={{ x: 0.07, y: 0.28 }} size={{ percentage: { width: 0.14, height: 0.3 } }} corner={0} />
            <Frame position={{ x: 0.77, y: 0.18 }} size={{ percentage: { width: 0.12, height: 0.25 } }} corner={0} />
            <Frame position={{ x: 0.43, y: 0.36 }} size={{ percentage: { width: 0.085, height: 0.18 } }} corner={0}>
              <div className="relative left-12">
                <AnimatedButterfly fill="#d24d34" duration={8} />
              </div>
              <AnimatedButterfly fill="orange" duration={15} reverse />
            </Frame>
          </div>

          {/* At night, fireflies around the animals; their light is baked into the night landscape at the same spots. */}
          <Fireflies className="absolute inset-0 z-30 hidden dark:block" />
        </div>
      </div>
    </div>
  );
};

export default AboutRoute;
