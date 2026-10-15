import { Suspense, type FC } from 'react';
import { GearIcon, SignInIcon, UserCircleGearIcon } from '@phosphor-icons/react';
import { motion, type Transition } from 'motion/react';
import { NavLink } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import { Separator } from '@conservationtv/ui/components/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';
import { cn } from '@conservationtv/ui/lib/utils';

import type { Route } from './+types/about';
import backgroundImage from '@/assets/about/background.webp';
import backgroundNightImage from '@/assets/about/background-night.webp';
import cloudsImage from '@/assets/about/clouds.webp';
import { BrandMark } from '@/components/brand/brand-mark';
import { AnimatedButterfly } from '@/components/about/butterfly';
import { Fireflies } from '@/components/about/fireflies';
import { Frame } from '@/components/about/frame';
import { NightStars } from '@/components/about/night-stars';
import { Reflection } from '@/components/about/reflection';
import { usePinsStandIn } from '@/hooks/use-pins-stand-in';
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

/** The app rail's icon links, here floating over the sky. */
const navLinkClassName =
  'flex size-9 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-interaction-hover focus-visible:outline-2 focus-visible:outline-ring';

/** Links styled as the sidebar's menu items, which need a SidebarProvider this page doesn't have. */
const sidebarItemClassName =
  'flex h-8 items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs text-sidebar-foreground ring-custom-focus-ring outline-hidden hover:bg-interaction-hover hover:text-sidebar-accent-foreground focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0';

/** The header's links: the sidebar item's look, scaled up to suit the page, in medium weight. */
const headerLinkClassName = cn(sidebarItemClassName, 'h-9 px-3 text-sm font-medium');

/** The account menu fades in from just off to the right once the pins have loaded, the same quick ease-out the sign-in screens use. */
const menuEntrance: Transition = { duration: 0.5, ease: [0.22, 1, 0.36, 1] };

/** Seconds between the heading rising in and the paragraph after it. */
const TEXT_STAGGER_SECONDS = 0.12;

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
 * Across the top right: the app rail's pinned links and the account link for someone signed in, or a way to sign in for
 * anyone else. Signed in, it suspends while the pins load (see usePinsStandIn), then fades in whole; signed out, the
 * answer is there from the start, so it is too.
 */
const AccountMenu: FC = () => {
  const pins = usePinsStandIn();
  return (
    <motion.div
      initial={pins ? { opacity: 0, x: 8 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={menuEntrance}
      className="flex items-center gap-2"
    >
      {pins ? (
        <>
          <nav aria-label="Pinned" className="flex gap-0.5">
            {pins.map(({ to, label }) => (
              <Tooltip key={label}>
                <TooltipTrigger>
                  <NavLink to={to} className={navLinkClassName}>
                    <GearIcon className="size-4" aria-hidden="true" />
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            ))}
          </nav>
          <Separator orientation="vertical" className="bg-sidebar-foreground/40 data-vertical:h-5 data-vertical:self-auto" />
          <nav aria-label="Account" className="flex gap-0.5">
            <NavLink to="/account" className={headerLinkClassName}>
              <UserCircleGearIcon aria-hidden="true" />
              <span>My account</span>
            </NavLink>
          </nav>
        </>
      ) : (
        <nav aria-label="Account" className="flex gap-0.5">
          <Button
            size="lg"
            nativeButton={false}
            render={<NavLink to="/sign-in" />}
            className="h-9 rounded-full px-4 text-sm"
          >
            <SignInIcon aria-hidden="true" />
            Sign in
          </Button>
        </nav>
      )}
    </motion.div>
  );
};

/**
 * The about page: a dawn landscape watched through camera viewfinders, with clouds drifting over the sky, the sky
 * rippling in the lake and butterflies in one of the frames. In the dark theme it turns to night: a night sky with
 * stars and faint clouds, night versions of the landscape and reflection, and fireflies around the animals. The text
 * is in the theme's foreground colour.
 */
const AboutRoute: FC = () => {
  return (
    <div className="relative mx-auto max-w-400 text-foreground">
      {/* The menus: over the clouds while the illustration fills the window, and a header above it once it's framed. */}
      <header className="absolute inset-x-0 top-0 z-30 flex items-center justify-between p-4 min-[100rem]:static min-[100rem]:py-5">
        {/* Over the clouds, a blurred wash behind the menus that fades out by the header's bottom edge, above the heading,
            lifting them off the sky as the haze does the main text. Not needed once the header sits above the framed
            illustration. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-linear-to-b from-white/60 to-transparent mask-b-from-50% backdrop-blur-md min-[100rem]:hidden dark:from-[#151412]/60"
        />
        {/* The logo and the site's sections, on the left: always there, so they don't animate. Case studies and tools are
            placeholders. */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <BrandMark className="h-6" />
            <span className="text-lg leading-none font-semibold tracking-tight">
              conservation.tv
            </span>
          </div>
          <nav aria-label="Sections" className="flex gap-0.5">
            <NavLink to="/about" className={headerLinkClassName}>
              <span>About</span>
            </NavLink>
            <a href="#" className={headerLinkClassName}>
              <span>Case studies</span>
            </a>
            <a href="#" className={headerLinkClassName}>
              <span>Tools</span>
            </a>
          </nav>
        </div>

        {/* Nothing shows there while any pins load; then the whole menu fades in. */}
        <Suspense fallback={null}>
          <AccountMenu />
        </Suspense>
      </header>

      <div className="overflow-clip min-[100rem]:rounded-t-3xl">
        <div className="about-hero-sky relative">
          {/* At night, stars come out in the sky, behind the clouds. */}
          <NightStars className="pointer-events-none absolute inset-0 z-0 hidden size-full dark:block" />

          <div
            ref={syncCloudDrift}
            style={{
              '--about-hero-clouds-image': `url(${cloudsImage})`,
              '--cloud-drift-duration': `${CLOUD_DRIFT_DURATION_SECONDS}s`
            }}
            className="about-hero-clouds z-0 flex w-full flex-col pt-24 pb-15 min-[100rem]:pt-16"
          >
            <div className="relative z-10 mb-[min(10vw,160px)] flex flex-col items-center gap-4 px-6">
              {/* A haze behind the words, lifting them off the sky: light by day, and the night sky's colour at night. */}
              <div className="pointer-events-none absolute top-1/2 left-1/2 h-44 w-[min(92vw,700px)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/60 blur-3xl dark:bg-[#151412]/60" />
              <motion.h1
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...menuEntrance, duration: 0.6 }}
                className="relative z-10 w-full max-w-xl text-center text-3xl font-semibold text-balance sm:text-5xl">
                Next generation conservation
              </motion.h1>
              <motion.p
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...menuEntrance, duration: 0.6, delay: TEXT_STAGGER_SECONDS }}
                className="relative z-10 max-w-2xl text-center leading-tight text-balance">
                We're a collaborative network of organizations, communities, and individuals who believe 24/7 live cameras
                and streaming are powerful conservation tools.
              </motion.p>
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
    </div>
  );
};

export default AboutRoute;
