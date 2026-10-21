import { defineBinary, reportsVersion } from '@conservationtv/converge/binaries';
import type { z } from 'zod';

/**
 * moq-cli's releases (https://doc.moq.dev/bin/cli.html): a tarball per platform (a zip on Windows), the executable
 * `moq` under `bin/` in a directory named for the release and platform, and `--version` reports the version.
 */
export const moqBinary = defineBinary({ name: 'moq', checks: [reportsVersion()] });
export type MoqManifest = z.output<typeof moqBinary.schema>;

const VERSION = '0.14.7';
const TAG = `moq-cli-v${VERSION}`;

function release(target: string, extension: string) {
  return {
    url: `https://github.com/moq-dev/moq/releases/download/${TAG}/${TAG}-${target}.${extension}`,
    path: `${TAG}-${target}/bin/moq`
  };
}

/** The moq CLI publishers run, from MediaMTX's `runOnInit`. The checksums are GitHub's asset digests. */
export const MOQ_MANIFEST: MoqManifest = {
  name: 'moq',
  version: VERSION,
  artifacts: {
    'darwin-arm64': {
      ...release('aarch64-apple-darwin', 'tar.gz'),
      checksum: 'sha256:8c64ebdaa7f8694f7ebb79cf2d17aa3ea93e48f7ae70d5673fde95e011b8e3b2',
      format: 'tar'
    },
    'linux-x64': {
      ...release('x86_64-unknown-linux-gnu', 'tar.gz'),
      checksum: 'sha256:19b174b98274f6f2e20403469a4472c9d91b91be0a1ae041ceecd5beeb0444ec',
      format: 'tar'
    },
    'linux-arm64': {
      ...release('aarch64-unknown-linux-gnu', 'tar.gz'),
      checksum: 'sha256:92016745d27b8b0960ec70b0ced127daccbb7ccb246ba0b86bfa3464c312ad12',
      format: 'tar'
    },
    // The Windows zip has the executable at its top level.
    'win32-x64': {
      url: `https://github.com/moq-dev/moq/releases/download/${TAG}/${TAG}-x86_64-pc-windows-msvc.zip`,
      checksum: 'sha256:a41704bf440fd137382ba45fb388c1fd214198ba8ade0e8843807bc1beadcad6',
      format: 'zip'
    }
  }
};
