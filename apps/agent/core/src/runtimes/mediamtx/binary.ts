import { defineBinary, reportsVersion } from '@conservationtv/converge/binaries';
import type { z } from 'zod';

/** MediaMTX's releases: a tarball per platform (a zip for Windows), and `mediamtx --version` reports `v<version>`. */
export const mediamtxBinary = defineBinary({ name: 'mediamtx', checks: [reportsVersion(['--version'])] });

const RELEASE = 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2';

/**
 * MediaMTX v1.21.2, the release @conservationtv/mediamtx's config types describe. The checksums are the release's
 * own, from its `checksums.sha256`.
 */
export const MEDIAMTX_MANIFEST: z.output<typeof mediamtxBinary.schema> = {
  name: 'mediamtx',
  version: '1.21.2',
  artifacts: {
    'darwin-arm64': {
      url: `${RELEASE}/mediamtx_v1.21.2_darwin_arm64.tar.gz`,
      checksum: 'sha256:7d0d0c5c11527cbd10bde1c3d728864eb0334a9b653566cd73c0259750cbf093',
      format: 'tar'
    },
    'darwin-x64': {
      url: `${RELEASE}/mediamtx_v1.21.2_darwin_amd64.tar.gz`,
      checksum: 'sha256:87a00062b6a588aa1158f875504a3b56c80d62e2611dc450b83d0534e1b49198',
      format: 'tar'
    },
    'linux-x64': {
      url: `${RELEASE}/mediamtx_v1.21.2_linux_amd64.tar.gz`,
      checksum: 'sha256:121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27',
      format: 'tar'
    },
    'linux-arm64': {
      url: `${RELEASE}/mediamtx_v1.21.2_linux_arm64.tar.gz`,
      checksum: 'sha256:180a235374a548d9133cdd5e20f5dbd8b01317be1c86e0d7e66df585dc42ed6f',
      format: 'tar'
    },
    'linux-arm': {
      url: `${RELEASE}/mediamtx_v1.21.2_linux_armv7.tar.gz`,
      checksum: 'sha256:bff8951f51dcb0426c306fc3fad793232f03947916370b166d10e6c73dcf9ce2',
      format: 'tar'
    },
    'win32-x64': {
      url: `${RELEASE}/mediamtx_v1.21.2_windows_amd64.zip`,
      checksum: 'sha256:a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467',
      format: 'zip'
    }
  }
};
