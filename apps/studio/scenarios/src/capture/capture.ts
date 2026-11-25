import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser, Page as BrowserPage, ConsoleMessage, Request } from 'playwright';
import { matchOperation } from '../api/contract.ts';

import { ledger, SCENARIO_HEADER, type LedgerEntry } from '../api/server.ts';
import { SCENARIO_COOKIE } from '../serve.ts';
import { WORLD_NOW } from '../world/generate.ts';
import type { Scenario } from '../world/scenarios.ts';
import type { Page } from './pages.ts';
import type { Thumbnailer } from './thumbnails.ts';

// One screenshot: a page of a scenario's world, in a theme, at a viewport size. Each gets a browser context of its own
// (nothing cached or stored carries over from the last), its clock fixed at the world's now, motion reduced and
// animations stopped, and is left to settle before it is captured. What went wrong on the way is recorded beside it:
// errors in the console and the page, API calls that failed, what the mock couldn't answer, an error boundary shown,
// the page wider than the window.

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }
} as const;
export type Viewport = keyof typeof VIEWPORTS;
export type Theme = 'light' | 'dark';

/** The tallest a capture grows to fit its page. */
const MAX_HEIGHT = 8000;

export interface Shot {
  /** Stable across runs: what a baseline's shot is matched by. */
  key: string;
  scenario: string;
  page: string;
  pageTitle: string;
  path: string;
  theme: Theme;
  viewport: Viewport;
  /** Relative to the report's directory. */
  file: string;
  /** Its first screen, small (src/capture/thumbnails.ts), for the report's card. */
  thumb: string;
  /** The page's accessibility snapshot (Playwright's, as YAML), relative to the report; null when it couldn't be taken. */
  aria: string | null;
  /** Where the app ended up, when it isn't where it was sent. */
  redirectedTo: string | null;
  /** Whether the network went quiet before the capture; a page waiting on a hung call never does. */
  settled: boolean;
  /**
   * The web app's own files the page loaded, by path (the API's calls aside): with the mock and worlds the same, a page
   * whose every one of these is the same in another build draws the same there (report.ts reuses its shot).
   */
  loaded: string[];
  durationMs: number;
  consoleErrors: string[];
  pageErrors: string[];
  /** Calls to the mock API that failed, other than faults the scenario injects. */
  apiFailures: string[];
  /** What the mock noted for this page's requests. */
  ledger: LedgerEntry[];
  /** An error boundary's "Something went wrong" was on screen. */
  errorBoundary: boolean;
  /** The page is wider than the window, so it scrolls sideways. */
  overflow: boolean;
}

export interface CaptureTask {
  scenario: Scenario;
  page: Page;
  theme: Theme;
  viewport: Viewport;
}

/** A page of a scenario at a viewport, taken in each of its themes from one load of it. */
export interface CaptureGroup {
  scenario: Scenario;
  page: Page;
  viewport: Viewport;
  themes: Theme[];
}

/** What names a shot: its scenario's and page's IDs, and how it was taken. */
export interface ShotKeyParts extends Pick<CaptureTask, 'theme' | 'viewport'> {
  scenario: string;
  page: string;
}

export function shotKey(task: ShotKeyParts): string {
  return `${task.scenario}/${task.page}/${task.theme}-${task.viewport}`;
}

/** Freezes what moves, so the same page renders the same pixels every time. */
const STILL = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition: none !important;
  caret-color: transparent !important;
}`;

let tags = 0;

/** What went wrong on a page as it loaded, as it happened. */
interface Problems {
  consoleErrors: string[];
  pageErrors: string[];
  apiFailures: string[];
}

/**
 * Console errors that are the harness, not the app: the browser's own line for each failed fetch (apiFailures records
 * those), live connections the mock refuses (a show's WebSocket), and the app reporting a fault the scenario injected.
 */
const EXPECTED_CONSOLE = [
  /^Failed to load resource/u,
  /^WebSocket connection to '[^']*\/w\//u,
  /Injected by the [a-z0-9-]+ scenario/u
];

/** Errors in the console and the page, and API calls that failed other than as the scenario means them to. */
function watchProblems(page: BrowserPage): Problems {
  const problems: Problems = { consoleErrors: [], pageErrors: [], apiFailures: [] };
  page.on('console', (message: ConsoleMessage) => {
    const text = message.text();
    if (message.type() === 'error' && !EXPECTED_CONSOLE.some(pattern => pattern.test(text)))
      problems.consoleErrors.push(text.slice(0, 500));
  });
  page.on('pageerror', error => problems.pageErrors.push(`${error.name}: ${error.message}`.slice(0, 500)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/w/') || response.status() < 400) return;
    // Faults the scenario injects and live connections it refuses are the scenario working as meant: the mock marks them.
    if (response.headers()[SCENARIO_HEADER]) return;
    problems.apiFailures.push(
      `${response.status()} ${response.request().method()} ${url.pathname.replace(/^\/w\/[^/]+/u, '')}`
    );
  });
  return problems;
}

/** A page's network activity, as settling reads it. */
interface Activity {
  /** Requests not yet finished, but for those the scenario hangs on purpose. */
  inFlight: Set<Request>;
  lastActivity: number;
  /** A server error answered since the clock last moved on: the app may have a retry waiting on a timer. */
  sawServerError: boolean;
}

/** Whether a request is to an operation the scenario never answers. */
function isHung(request: Request, hung: Set<string>): boolean {
  const url = new URL(request.url());
  if (!url.pathname.startsWith('/w/')) return false;
  const operation = matchOperation(request.method(), url.pathname.replace(/^\/w\/[^/]+/u, ''))?.operation.id;
  return operation !== undefined && hung.has(operation);
}

function watchActivity(page: BrowserPage, scenario: Scenario): Activity {
  const hung = new Set(
    Object.entries(scenario.spec.faults)
      .filter(([, fault]) => fault.hang)
      .map(([operation]) => operation)
  );
  const activity: Activity = { inFlight: new Set(), lastActivity: Date.now(), sawServerError: false };
  page.on('request', request => {
    activity.lastActivity = Date.now();
    if (!isHung(request, hung)) activity.inFlight.add(request);
  });
  const finished = (request: Request) => {
    activity.lastActivity = Date.now();
    activity.inFlight.delete(request);
  };
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  page.on('response', response => {
    if (response.status() >= 500) activity.sawServerError = true;
  });
  return activity;
}

/** How long nothing may start before a page counts as quiet. */
const QUIET_MS = 400;
/** A beat for anything that renders after the last response: suspense boundaries resolving, charts laying out. */
const BEAT_MS = 100;

/**
 * How far the page's clock is moved on after a server error: past the longest wait before one of the app's retries
 * (TanStack Query's, 1 s then 2 s), so a retry goes now rather than in real time.
 */
const RETRY_WAIT_MS = 2000;

/**
 * Load the page and wait for it to settle, by its own requests: quiet once nothing is in flight but calls the scenario
 * hangs on purpose, and nothing has started for a moment. A server error may leave a retry waiting on a timer, so the
 * page's clock (fake since openPage fixed the time, so moving it doesn't change the time the page shows) is run past
 * it, firing it at once, until the page stays quiet without one: the error state is what is captured rather than a
 * retry's loading state. False when it never settled in time.
 */
async function settle(page: BrowserPage, url: string, activity: Activity, settleMs: number): Promise<boolean> {
  const deadline = Date.now() + settleMs;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: settleMs });
    // Poll until quiet, giving up at the deadline.
    while (true) {
      // Quiet first, so a page that settles right at the deadline still counts as settled.
      const quiet = activity.inFlight.size === 0 && Date.now() - activity.lastActivity >= QUIET_MS;
      if (quiet && !activity.sawServerError) return true;
      if (Date.now() > deadline) return false;
      if (quiet) {
        activity.sawServerError = false;
        await page.clock.runFor(RETRY_WAIT_MS);
        // A retry's request is reported a moment after its timer fires: quiet is counted again from the jump.
        activity.lastActivity = Date.now();
        continue;
      }
      await page.waitForTimeout(100);
    }
  } catch {
    return false;
  }
}

/**
 * The app scrolls inside its own pane rather than the document, so a full-page screenshot would stop at the window.
 * Grow the window by what the tallest scrolling pane hides, until nothing is hidden (or it is very tall).
 */
async function fitToContent(page: BrowserPage, viewport: Viewport) {
  const size = VIEWPORTS[viewport];
  let height: number = size.height;
  for (let round = 0; round < 3; round++) {
    const hidden = await page
      .evaluate(() => {
        let most = 0;
        for (const element of document.querySelectorAll('*')) {
          if (!/auto|scroll/u.test(getComputedStyle(element).overflowY)) continue;
          if (element.clientHeight < window.innerHeight * 0.4) continue;
          most = Math.max(most, element.scrollHeight - element.clientHeight);
        }
        return most;
      })
      .catch(() => 0);
    if (hidden <= 1 || height >= MAX_HEIGHT) break;
    height = Math.min(MAX_HEIGHT, height + hidden);
    await page.setViewportSize({ width: size.width, height });
    await page.waitForTimeout(100);
  }
}

/** What the page shows that a screenshot alone wouldn't flag. */
interface PageChecks {
  errorBoundary: boolean;
  overflow: boolean;
}

function checksOf(page: BrowserPage): Promise<PageChecks> {
  return page
    .evaluate(() => ({
      errorBoundary: document.body.innerText.includes('Something went wrong'),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1
    }))
    .catch(() => ({ errorBoundary: false, overflow: false }));
}

/** A browser context of the group's own, its viewport, first theme and clock set, pointed at its scenario by the cookie. */
async function openPage(browser: Browser, origin: string, group: CaptureGroup, tag: string) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[group.viewport],
    deviceScaleFactor: 1,
    colorScheme: group.themes[0] ?? 'light',
    reducedMotion: 'reduce',
    locale: 'en-GB',
    timezoneId: 'Europe/London'
  });
  await context.addCookies([{ name: SCENARIO_COOKIE, value: tag, url: origin }]);
  const page = await context.newPage();
  await page.clock.setFixedTime(WORLD_NOW);
  await loadFontsFirst(page);
  return { context, page };
}

declare global {
  /** Set by loadFontsFirst's script: settles once every font face the page's CSS declares has loaded. */
  var scenarioFontsLoaded: Promise<unknown> | undefined;
}

/**
 * Fonts loaded before anything is drawn. A font is fetched only when text first uses it, which in the app is the same
 * moment its charts measure their labels; Recharts keeps what it measured, so a label measured in the fallback font
 * stays that width (wrapping onto two lines, say) whatever loads after. So every face the CSS declares is loaded as
 * soon as the CSS is parsed, and the session, which every page waits on before drawing any text, is held until they
 * have.
 */
async function loadFontsFirst(page: BrowserPage) {
  await page.addInitScript(() => {
    globalThis.scenarioFontsLoaded = new Promise(resolve => {
      document.addEventListener('DOMContentLoaded', () => {
        void Promise.all([...document.fonts].map(face => face.load().catch(() => undefined))).then(resolve);
      });
    });
  });
  await page.route(/\/auth\/get-session$/u, async route => {
    await page.evaluate(() => globalThis.scenarioFontsLoaded).catch(() => undefined);
    await route.continue();
  });
}

/** The page's accessibility snapshot, written beside the shots: what a comparison reads to say what changed in words. */
async function ariaSnapshotOf(page: BrowserPage, outDir: string, file: string): Promise<string | null> {
  const snapshot = await page
    .locator('body')
    .ariaSnapshot()
    .catch(() => null);
  if (snapshot === null) return null;
  const aria = join('aria', file.replace(/^shots\//u, '').replace(/\.png$/u, '.txt'));
  mkdirSync(dirname(join(outDir, aria)), { recursive: true });
  writeFileSync(join(outDir, aria), snapshot);
  return aria;
}

/** The web app's files a page asks for, by path: everything from its origin but the API's calls and the session's. */
function watchLoaded(page: BrowserPage, origin: string): Set<string> {
  const loaded = new Set<string>();
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin && !url.pathname.startsWith('/w/') && !url.pathname.startsWith('/auth/'))
      loaded.add(url.pathname);
  });
  return loaded;
}

/** Where a shot of the group in a theme is written, relative to the report. */
function fileOf(group: CaptureGroup, theme: Theme): string {
  return join('shots', group.scenario.id, `${group.page.id.replaceAll('/', '__')}--${theme}-${group.viewport}.png`);
}

/**
 * The page in one theme, as it stands: switched to the theme when it isn't the one it loaded in (the app follows the
 * colour scheme as it changes), grown to fit, checked, shot, and its accessibility snapshot kept.
 */
async function shoot(page: BrowserPage, outDir: string, group: CaptureGroup, theme: Theme, first: boolean) {
  if (!first) {
    await page.setViewportSize(VIEWPORTS[group.viewport]);
    await page.emulateMedia({ colorScheme: theme });
  }
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.waitForTimeout(BEAT_MS);
  await fitToContent(page, group.viewport);
  const file = fileOf(group, theme);
  mkdirSync(dirname(join(outDir, file)), { recursive: true });
  const checks = await checksOf(page);
  await page.screenshot({ path: join(outDir, file), fullPage: true, animations: 'disabled', caret: 'hide' });
  const aria = await ariaSnapshotOf(page, outDir, file);
  return { file, aria, checks };
}

/** Every theme's shot of a page from one load of it; what went wrong loading it is noted on each. */
export async function capture(
  browser: Browser,
  origin: string,
  outDir: string,
  group: CaptureGroup,
  settleMs: number,
  thumbnailer: Thumbnailer
): Promise<Shot[]> {
  let started = Date.now();
  const tag = `${group.scenario.id}~${++tags}`;
  const { context, page } = await openPage(browser, origin, group, tag);
  const problems = watchProblems(page);
  const activity = watchActivity(page, group.scenario);
  const loaded = watchLoaded(page, origin);
  const settled = await settle(page, `${origin}${group.page.path}`, activity, settleMs);
  await page.addStyleTag({ content: STILL }).catch(() => undefined);
  const finalPath = new URL(page.url()).pathname;
  const taken: Shot[] = [];
  for (const [index, theme] of group.themes.entries()) {
    const { file, aria, checks } = await shoot(page, outDir, group, theme, index === 0);
    taken.push({
      key: shotKey({ scenario: group.scenario.id, page: group.page.id, theme, viewport: group.viewport }),
      scenario: group.scenario.id,
      page: group.page.id,
      pageTitle: group.page.title,
      path: group.page.path,
      theme,
      viewport: group.viewport,
      file,
      thumb: '',
      aria,
      redirectedTo: finalPath === group.page.path ? null : finalPath,
      settled,
      loaded: [],
      durationMs: Date.now() - started,
      ...problems,
      ledger: [],
      ...checks
    });
    started = Date.now();
  }
  await context.close();
  const noted = (ledger.get(tag) ?? []).filter(entry => entry.kind !== 'fault');
  const files = [...loaded].sort();
  for (const shot of taken)
    Object.assign(shot, { thumb: await thumbnailer.make(outDir, shot.file), ledger: noted, loaded: files });
  return taken;
}
