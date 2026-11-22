import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

// On macOS, development runs a copy of Electron.app of its own, with this app's identity, so ctvagent:// links reach
// it. Electron.app as installed is `com.github.electron`, the identifier every Electron.app on the machine shares:
// registered for the scheme, LaunchServices sends links to whichever copy it has indexed, which may be another
// project's. The copy has its own identifier and declares the scheme in its Info.plist, as the packaged app does
// (electron-builder.yml), and runs this folder as its app, so a link opens it even when development isn't running.
// It is made again when Electron's version changes.

const run = promisify(execFile);

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const DEV_BUNDLE_ID = 'tv.conservation.agent.dev';
const DEV_NAME = 'Conservation.tv Agent (Dev)';

const projectDir = resolve(import.meta.dirname, '..');
const cacheDir = join(projectDir, 'node_modules', '.cache', 'dev-app');

/** Electron.app as installed, and its version: its package says where, in path.txt, and the download its version. */
async function installedElectron() {
  const electronDir = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
  // path.txt is the executable inside the bundle, relative to dist/: Electron.app/Contents/MacOS/Electron.
  const executable = (await readFile(join(electronDir, 'path.txt'), 'utf8')).trim();
  const bundle = resolve(electronDir, 'dist', executable, '..', '..', '..');
  const version = (await readFile(join(electronDir, 'dist', 'version'), 'utf8')).trim();
  return { bundle, version };
}

/**
 * The development app bundle, made if it isn't there for this Electron, registered with LaunchServices: the path of
 * its executable.
 */
export async function devApp(): Promise<string> {
  const electron = await installedElectron();
  const app = join(cacheDir, `${DEV_NAME}.app`);
  const executable = join(app, 'Contents', 'MacOS', 'Electron');
  const stamp = join(cacheDir, 'electron-version');
  const made = existsSync(stamp) && (await readFile(stamp, 'utf8')) === electron.version && existsSync(executable);
  if (!made) {
    console.log(`Making ${DEV_NAME}.app from Electron ${electron.version}…`);
    await rm(cacheDir, { recursive: true, force: true });
    // ditto keeps the frameworks' symlinks, which a plain copy would turn into duplicates.
    await run('ditto', [electron.bundle, app]);
    const plist = join(app, 'Contents', 'Info.plist');
    await run('plutil', ['-replace', 'CFBundleIdentifier', '-string', DEV_BUNDLE_ID, plist]);
    await run('plutil', ['-replace', 'CFBundleName', '-string', DEV_NAME, plist]);
    await run('plutil', ['-replace', 'CFBundleDisplayName', '-string', DEV_NAME, plist]);
    const urlTypes = [{ CFBundleURLName: DEV_NAME, CFBundleURLSchemes: ['ctvagent'] }];
    await run('plutil', ['-replace', 'CFBundleURLTypes', '-json', JSON.stringify(urlTypes), plist]);
    // Electron runs Contents/Resources/app, when there is one, in place of its default app: this folder, whose
    // package.json names the main process scripts/dev.ts builds.
    await symlink(projectDir, join(app, 'Contents', 'Resources', 'app'));
    // The edited Info.plist breaks the bundle's signature; signing it again, ad hoc, lets macOS launch it.
    await run('codesign', ['--force', '--deep', '--sign', '-', app]);
    await writeFile(stamp, electron.version);
  }
  await run(LSREGISTER, ['-f', app]);
  // The app says so itself when it starts (src/main/index.ts); saying so here too sends links to it before it has.
  const claim = `ObjC.import('CoreServices'); $.LSSetDefaultHandlerForURLScheme($('ctvagent'), $('${DEV_BUNDLE_ID}'));`;
  await run('osascript', ['-l', 'JavaScript', '-e', claim]);
  return executable;
}
