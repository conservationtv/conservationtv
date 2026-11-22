import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getLogger } from '@logtape/logtape';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { CHANNELS } from '../shared/bridge.ts';
import { AgentHost } from './host.ts';
import { isLink, parseLink, SCHEME, type SetupLink } from './link.ts';
import { closeLogs, configureLogs, LogBuffer, logFile } from './logs.ts';
import { agentDirectory, forgetSettings, readSettings, writeSettings } from './settings.ts';

// The app: one window over one agent (host.ts), set up by a ctvagent:// link from the studio (link.ts). It runs the
// agent while it is open, and stops it gracefully on quit; it installs nothing to run at login or as a service.
//
// A link reaches the app by `open-url` on macOS, and on Windows and Linux on the command line: the first instance's
// own, or a second instance's, which hands it over and quits.

const logger = getLogger(['desktop']);

/** How long quitting waits for the agent to stop before quitting anyway: the runner's SHUTDOWN_DELAY_MS. */
const STOP_DEADLINE_MS = 10_000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  const host = new AgentHost();
  const logs = new LogBuffer();
  let window: BrowserWindow | undefined = undefined;
  /** Links that arrived before the app was ready to ask about them. */
  const early: string[] = process.argv.filter(isLink);
  let ready = false;

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (ready) void handleLink(url);
    else early.push(url);
  });
  app.on('second-instance', (_event, argv) => {
    showWindow();
    for (const url of argv.filter(isLink)) {
      if (ready) void handleLink(url);
      else early.push(url);
    }
  });

  // macOS keeps an app, and so its agent, running with no window, until it is quit; elsewhere closing it quits.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', showWindow);

  let quitting = false;
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    const deadline = new Promise(resolve => setTimeout(resolve, STOP_DEADLINE_MS));
    void Promise.race([host.stop(), deadline])
      .catch((error: Error) => logger.error('The agent did not stop cleanly: {error}', { error }))
      .then(() => closeLogs())
      .finally(() => app.exit(0));
  });
  // Development restarts the app with SIGTERM (scripts/dev.ts), and a terminal stops it with SIGINT.
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());

  void app.whenReady().then(async () => {
    await configureLogs(logs, host.logSink);
    registerScheme();
    handleIpc();
    host.subscribe(state => window?.webContents.send(CHANNELS.stateChanged, state));
    logs.subscribe(line => window?.webContents.send(CHANNELS.logged, line));
    showWindow();
    await host.use(await readSettings());
    ready = true;
    // A link the app was opened with sets it up afresh; otherwise, or when no such link is taken, it runs as it was set
    // up.
    let taken = false;
    for (const url of early.splice(0)) taken = (await handleLink(url)) || taken;
    if (!taken) await host.start();
  });

  function showWindow() {
    if (window !== undefined) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    if (!app.isReady()) return;
    const created = new BrowserWindow({
      width: 560,
      height: 720,
      minWidth: 420,
      minHeight: 480,
      title: 'Conservation.tv Agent',
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true
      }
    });
    created.once('ready-to-show', () => created.show());
    created.on('closed', () => {
      window = undefined;
    });
    // Links in the window open in the browser, not in the app.
    watchRenderer(created);
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    const devUrl = process.env.DESKTOP_RENDERER_URL;
    if (devUrl !== undefined) void created.loadURL(devUrl);
    else void created.loadFile(join(import.meta.dirname, '../renderer/index.html'));
    window = created;
  }

  /** Set the app up from a link, if it is one and the person agrees: whether it was. */
  async function handleLink(url: string): Promise<boolean> {
    showWindow();
    const link = parseLink(url);
    if (link instanceof Error) {
      dialog.showErrorBox('This link cannot set up the agent', link.message);
      return false;
    }
    if (!(await confirmSetup(link))) return false;
    const settings = { id: link.id, name: link.name, apiUrl: link.apiUrl, secretKey: link.secretKey };
    await writeSettings(settings);
    logger.info('Set up as {name} for {apiUrl}', { name: link.name, apiUrl: link.apiUrl });
    await host.use(settings);
    await host.start();
    return true;
  }

  /** Whether the person agrees to run as the link's agent. The same agent again needs no asking. */
  async function confirmSetup(link: SetupLink): Promise<boolean> {
    const current = host.configured;
    const same =
      current !== undefined &&
      current.id === link.id &&
      current.apiUrl === link.apiUrl &&
      Buffer.from(current.secretKey).equals(Buffer.from(link.secretKey));
    if (same) return true;
    const studio = new URL(link.apiUrl).host;
    const replacing = current === undefined ? '' : `\n\nThis replaces ${current.name}, which this computer runs now.`;
    const options = {
      type: 'question' as const,
      buttons: ['Run this agent', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Run ${link.name} on this computer?`,
      detail: `This computer will act as the agent ${link.name} for the studio at ${studio}. Only continue if you opened this link from the studio yourself.${replacing}`
    };
    const answer =
      window === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options);
    return answer.response === 0;
  }

  function handleIpc() {
    ipcMain.handle(CHANNELS.state, () => host.state);
    ipcMain.handle(CHANNELS.logs, () => logs.latest());
    ipcMain.handle(CHANNELS.start, () => host.start());
    ipcMain.handle(CHANNELS.stop, () => host.stop());
    ipcMain.handle(CHANNELS.forget, async () => {
      const current = host.configured;
      if (current === undefined) return;
      const options = {
        type: 'warning' as const,
        buttons: ['Forget it', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Forget ${current.name}?`,
        detail:
          'The agent stops, and this computer forgets its key and everything it downloaded. Set it up again from the studio to run it here again.'
      };
      const answer =
        window === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options);
      if (answer.response !== 0) return;
      await host.use(undefined);
      await forgetSettings(current.id);
      logger.info('Forgot {name}', { name: current.name });
    });
    ipcMain.handle(CHANNELS.openDataFolder, async () => {
      const current = host.configured;
      if (current === undefined) return;
      const directory = agentDirectory(current.id);
      await mkdir(directory, { recursive: true });
      await shell.openPath(directory);
    });
    ipcMain.handle(CHANNELS.openLogFolder, () => shell.showItemInFolder(logFile()));
  }
}

/**
 * Make this app the one ctvagent:// links open: the packaged app, and on macOS development's copy of Electron with its
 * own identity (scripts/dev-app.ts), each by its bundle. Electron's own app is never registered on macOS: it is
 * `com.github.electron`, which every Electron.app shares, so links would go to any of them. Elsewhere, development
 * registers Electron with this folder as its argument.
 */
function registerScheme() {
  if (!process.defaultApp) {
    app.setAsDefaultProtocolClient(SCHEME);
    return;
  }
  if (process.platform === 'darwin') {
    logger.warning('Not registering for {scheme} links: run the app with `pnpm dev`, which gives it its own identity', {
      scheme: SCHEME
    });
    return;
  }
  const appPath = process.argv[1];
  if (appPath !== undefined) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [resolve(appPath)]);
}

/**
 * What goes wrong in the window, in the app's log: its warnings and errors, a preload that fails, a page that doesn't
 * load, and a renderer that dies. Otherwise they are only in its developer tools, and a broken window is just blank.
 */
function watchRenderer(window: BrowserWindow) {
  const contents = window.webContents;
  contents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    if (level === 'warning')
      logger.warning('Window: {message} ({source}:{line})', { message, source: sourceId, line: lineNumber });
    if (level === 'error')
      logger.error('Window: {message} ({source}:{line})', { message, source: sourceId, line: lineNumber });
  });
  contents.on('preload-error', (_event, preloadPath, error) => {
    logger.error('The window could not load its preload {path}: {error}', { path: preloadPath, error });
  });
  contents.on('did-fail-load', (_event, code, description, url) => {
    logger.error('The window could not load {url}: {description} ({code})', { url, description, code });
  });
  contents.on('render-process-gone', (_event, details) => {
    logger.error('The window stopped: {reason}', { reason: details.reason });
  });
}
