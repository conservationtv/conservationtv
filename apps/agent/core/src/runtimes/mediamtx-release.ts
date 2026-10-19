import type { MediamtxSpec } from './mediamtx.ts';

/** v1.21.2, matching packages/mediamtx's generated config. Checksums pinned from the upstream release assets. */
export const mediamtxRelease = {
  name: 'mediamtx',
  version: 'v1.21.2',
  artifacts: {
    'darwin-arm64': {
      url: 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_darwin_arm64.tar.gz',
      checksum: 'sha256:7d0d0c5c11527cbd10bde1c3d728864eb0334a9b653566cd73c0259750cbf093',
      format: 'tar'
    },
    'darwin-x64': {
      url: 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_darwin_amd64.tar.gz',
      checksum: 'sha256:87a00062b6a588aa1158f875504a3b56c80d62e2611dc450b83d0534e1b49198',
      format: 'tar'
    },
    'linux-arm64': {
      url: 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_linux_arm64.tar.gz',
      checksum: 'sha256:180a235374a548d9133cdd5e20f5dbd8b01317be1c86e0d7e66df585dc42ed6f',
      format: 'tar'
    },
    'linux-x64': {
      url: 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_linux_amd64.tar.gz',
      checksum: 'sha256:121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27',
      format: 'tar'
    },
    'linux-arm': {
      url: 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_linux_armv6.tar.gz',
      checksum: 'sha256:70d0680d73841e85ed8ed908a323e4e2365cec84452427e78dc339d4ef90e1bd',
      format: 'tar'
    },
    'win32-x64': {
      url: 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_windows_amd64.zip',
      checksum: 'sha256:a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467',
      format: 'zip'
    }
  }
} satisfies MediamtxSpec['mediamtx'];
