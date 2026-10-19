# @conservationtv/converge/binaries

Vendored binaries for runtimes that run a process. It has three parts, kept apart so each can change on its own:

- **A manifest** is data: which version of a binary, and where to download it for each platform, with a checksum
  and a declared format. It belongs in a spec.
- **A binary definition** is code: how that binary is packaged and how to tell a good download from a bad one. It's
  written once, beside the runtime that runs the binary.
- **A store** is storage: it installs any binary from its definition and a manifest, with every version side by side,
  verified before anything runs it.

```ts
import { BinaryStore, defineBinary, reportsVersion } from '@conservationtv/converge/binaries';

const caddy = defineBinary({ name: 'caddy', checks: [reportsVersion(['version'])] });
const SpecSchema = z.object({ caddy: caddy.schema }); // a manifest Caddy can't install fails here, when parsed

const binaries = new BinaryStore({ directory: '/var/lib/agent/binaries' });
const installed = await binaries.install(caddy, spec.caddy, signal); // { name, version, id, path, directory, installedAt }
// … run installed.path …
await binaries.prune(installed, { spare: 1 });
```

For recipes (reading a release, choosing formats, getting checksums, custom unpackers and checks, private downloads,
upgrades and rollbacks), see the [guide](GUIDE.md).

## The manifest

```jsonc
{
  "name": "caddy",
  "version": "2.11.7",
  // Keyed by `${process.platform}-${process.arch}`.
  "artifacts": {
    "darwin-arm64": {
      "url": "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_mac_arm64.tar.gz",
      "checksum": "sha512:68f5…668e",
      "format": "tar"
    },
    "win32-x64": {
      "url": "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_windows_amd64.zip",
      "checksum": "sha512:…",
      "format": "zip"
    },
    "linux-x64": {
      "url": "https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz",
      "checksum": "sha256:…",
      "format": "tar",
      // Optional: the executable's path in the archive. `<name>` (`<name>.exe` on Windows) at the top if not given.
      "path": "node-v24.22.0-linux-x64/bin/node"
    }
  }
}
```

- **The checksum is required.** The download is hashed as it streams, and rejected before it's unpacked if it doesn't
  match. Ideally manifests are written by tooling that reads a release's published checksums, not by hand.
- **The format is required,** and never guessed from the URL. A guess goes wrong quietly: a `.bz2` or `.pkg` taken
  for the binary itself installs, then fails cryptically when run.
- **The version is the one the binary reports,** which isn't always the release's tag: rust-analyzer's releases are
  tagged by date (`2026-10-19`), but it reports `0.3.3089`. The tag belongs in the URL.
- **Names and versions are single path segments** (letters, digits, `.`, `_`, `+`, `-`), and `path` must stay inside
  the archive, so a manifest can't write outside the store.

`ManifestSchema` validates any manifest. A binary's `schema` narrows it to that binary's name, and to the formats it
has unpackers for.

## A binary definition

```ts
defineBinary({
  name: 'restic',
  unpackers: { dmg: mountAndCopy }, // added to the defaults; a manifest may then say `"format": "dmg"`
  checks: [reportsVersion(['version']), mySignatureCheck]
});
```

- **Unpackers,** by format. An unpacker is `({ download, into, path, signal }) => Promise<void>`. The defaults:

  | Format  | For                                    | Using                                                     |
  | ------- | -------------------------------------- | --------------------------------------------------------- |
  | `file`  | the binary itself (jq, yt-dlp)         | a rename                                                  |
  | `gzip`  | the binary, gzipped (rust-analyzer)    | Node's zlib                                               |
  | `bzip2` | the binary, bzip2'd (restic)           | the system's `bzip2`, which Windows doesn't have          |
  | `tar`   | a tarball, any compression (most)      | the system's `tar`, on macOS, Linux and Windows 10+       |
  | `zip`   | a zip (ffmpeg, deno, Windows releases) | the system's `tar` on macOS and Windows, `unzip` on Linux |

- **Checks,** run in order against the unpacked binary before it's installed. A check is
  `({ manifest, path, signal }) => Promise<void>`, and throws to turn the binary away. Signature checks (cosign,
  minisign, codesign) fit here.

`reportsVersion(args, { timeout })` runs the binary with `args` and requires the output to mention the manifest's
version, which catches a URL pointing at the wrong release. Binaries disagree on how to ask (`--version`, `-version`
for ffmpeg, `version` for Go and Caddy), which is why checks belong to the binary and not the store. It finds the
version with a letter in front (`go1.27.2`, `v1.21.2`, `jq-1.8.2`), but not inside a longer one (`1.21.20`). It gives
the binary 30 seconds by default: yt-dlp's single-file build takes about 7 seconds to start on every run.

## The store

Each install happens in a staging folder: download and verify, unpack, make executable, run the binary's checks. Only
then is its record written and the folder renamed into place:

```
<directory>/<name>/<version>-<checksum>/install.json
                                        files/…        the whole archive, so files beside the binary come too
```

- **All or nothing.** An install interrupted at any point (an abort, a dropped connection, the process killed, even
  mid-extraction) leaves nothing that looks installed. The next install starts again, and the next prune clears the
  leftovers.
- **Cached.** Installing what's already installed is a lookup, with no request.
- **Keyed by version and checksum,** so a download re-published under the same version is a different install.
- **Safe to race in one process.** Two installs of the same download both resolve to the one that lands first, and a
  prune leaves alone any install still staging. Two processes sharing a directory aren't guarded against.
- **Fetching** is `globalThis.fetch` unless the store is given a `fetch`, to add credentials or go through a mirror.

Its methods:

- `install(binary, manifest, signal)`: the install, downloading it if need be. Its `path` is the executable, and its
  `directory` everything that came with it. Some binaries need that: mediamtx reads the `mediamtx.yml` beside it only
  when run from there, and Node's `npm` needs Node's `bin/` on its `PATH`.
- `find(manifest)`: the install, if it's installed.
- `list(name)`: every install of a binary, most recently installed first.
- `prune(keep, { spare })`: removes every other install of `keep`'s binary, except the `spare` most recent, so going
  back to one of those is instant.
- `remove(name)` and `clear()`: everything of one binary, or of all of them.

Which install a running process came from is the runtime's to record, not the store's. See
[`examples/caddy/managed.ts`](../../examples/caddy/managed.ts), which records it beside Caddy's pidfile.

## Tried against

On macOS arm64, from their real releases: Caddy, mediamtx, ffmpeg, Node, Go, restic, yt-dlp, jq, ripgrep, deno,
cloudflared, rust-analyzer and nats-server. Not yet on Windows or Linux.
