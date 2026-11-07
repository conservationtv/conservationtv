import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Check, defineBinary, reportsVersion, type Unpack } from '@conservationtv/converge/binaries';
import type { z } from 'zod';

const run = promisify(execFile);

// OBS Studio's own releases (https://github.com/obsproject/obs-studio/releases), for the platforms an OBS agent runs
// on: Windows, as a zip of the whole program, run from `bin/64bit` in portable mode; and macOS, as a disk image holding
// `OBS.app`, signed and notarised by the OBS Project. There is no portable Linux build, so OBS agents don't run there.

/** The app bundle each macOS disk image holds. */
const MAC_APP = 'OBS.app';

/**
 * A macOS disk image: attached read-only out of sight, its app copied out with `ditto` (which keeps the bundle's
 * signature intact), then detached. macOS's own `hdiutil`, so this unpacks only there.
 */
const dmg: Unpack = async ({ download, into, signal }) => {
  const mountpoint = await mkdtemp(join(tmpdir(), 'obs-dmg-'));
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountpoint, download], {
    signal
  });
  try {
    await run('ditto', [join(mountpoint, MAC_APP), join(into, MAC_APP)], { signal });
  } finally {
    await run('hdiutil', ['detach', mountpoint, '-quiet']).catch(() => undefined);
    await rm(mountpoint, { recursive: true, force: true });
  }
};

/**
 * `--version` answers with the version and exits (`OBS Studio - 33.0.1`). Only checked on macOS: Windows' OBS is a GUI
 * program, which may not write to a pipe, and its download is already held to its checksum.
 */
const versionCheck = reportsVersion();
const reportsVersionOnMac: Check = candidate =>
  process.platform === 'darwin' ? versionCheck(candidate) : Promise.resolve();

export const obsBinary = defineBinary({ name: 'obs', unpackers: { dmg }, checks: [reportsVersionOnMac] });
export type ObsManifest = z.output<typeof obsBinary.schema>;

const VERSION = '33.0.1';

function release(asset: string) {
  return `https://github.com/obsproject/obs-studio/releases/download/${VERSION}/OBS-Studio-${VERSION}-${asset}`;
}

/** The OBS an OBS agent runs. The checksums are GitHub's asset digests. */
export const OBS_MANIFEST: ObsManifest = {
  name: 'obs',
  version: VERSION,
  artifacts: {
    'darwin-arm64': {
      url: release('macOS-Apple.dmg'),
      checksum: 'sha256:3d6b2eedeb56416602af635adaba32327fdf11ff9d2806a4ce7d5b608de73238',
      format: 'dmg',
      path: `${MAC_APP}/Contents/MacOS/OBS`
    },
    'darwin-x64': {
      url: release('macOS-Intel.dmg'),
      checksum: 'sha256:745257d65e06eb0f784af229659223a863ad50d036464bb2b52f8a2d9278c2b1',
      format: 'dmg',
      path: `${MAC_APP}/Contents/MacOS/OBS`
    },
    'win32-x64': {
      url: release('Windows-x64.zip'),
      checksum: 'sha256:0d9436451c2d772b33428e3fdae9776f071895c335de17283176306fb72651d3',
      format: 'zip',
      path: 'bin/64bit/obs64.exe'
    },
    'win32-arm64': {
      url: release('Windows-arm64.zip'),
      checksum: 'sha256:5bee731f6a9ce843ac670b4ccf048a54cdccb8b06acb3fd1c7928b9705f11100',
      format: 'zip',
      path: 'bin/64bit/obs64.exe'
    }
  }
};
