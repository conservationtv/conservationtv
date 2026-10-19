import { defineBinary, reportsVersion } from '@conservationtv/converge/binaries';
import type { z } from 'zod';

/**
 * MediaMTX's releases: a tarball per platform (a zip on Windows) with the executable at the top, beside a sample
 * config and the licence, and `--version` reports the release's tag.
 */
export const mediamtxBinary = defineBinary({ name: 'mediamtx', checks: [reportsVersion()] });
export type MediamtxManifest = z.output<typeof mediamtxBinary.schema>;

const RELEASE = 'v1.21.2';

function release(file: string): string {
  return `https://github.com/bluenviron/mediamtx/releases/download/${RELEASE}/mediamtx_${RELEASE}_${file}`;
}

/**
 * The MediaMTX every agent runs until the spec comes from elsewhere: the release packages/mediamtx's types describe.
 * The checksums are from the release's `checksums.sha256`, which GitHub's asset digests agree with.
 */
export const MEDIAMTX_MANIFEST: MediamtxManifest = {
  name: 'mediamtx',
  version: RELEASE,
  artifacts: {
    'darwin-arm64': {
      url: release('darwin_arm64.tar.gz'),
      checksum: 'sha256:7d0d0c5c11527cbd10bde1c3d728864eb0334a9b653566cd73c0259750cbf093',
      format: 'tar'
    },
    'darwin-x64': {
      url: release('darwin_amd64.tar.gz'),
      checksum: 'sha256:87a00062b6a588aa1158f875504a3b56c80d62e2611dc450b83d0534e1b49198',
      format: 'tar'
    },
    'linux-x64': {
      url: release('linux_amd64.tar.gz'),
      checksum: 'sha256:121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27',
      format: 'tar'
    },
    'linux-arm64': {
      url: release('linux_arm64.tar.gz'),
      checksum: 'sha256:180a235374a548d9133cdd5e20f5dbd8b01317be1c86e0d7e66df585dc42ed6f',
      format: 'tar'
    },
    'win32-x64': {
      url: release('windows_amd64.zip'),
      checksum: 'sha256:a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467',
      format: 'zip'
    }
  }
};
