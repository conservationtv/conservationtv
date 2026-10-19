# @conservationtv/converge/binaries

Vendored binaries for runtimes that run a process: a manifest names a version and a checksummed download for each
platform, and a store installs it, with every version side by side, verified before anything runs it.

```ts
import { BinaryStore, reportsVersion } from '@conservationtv/converge/binaries';

const binaries = new BinaryStore({ directory: '/var/lib/agent/binaries', checks: [reportsVersion(['version'])] });

const caddy = await binaries.install(manifest, signal); // { name, version, id, path, installedAt }
// … run caddy.path …
await binaries.prune(caddy, { spare: 1 });
```

## The manifest

```jsonc
{
  "name": "caddy",
  "version": "2.11.7",
  // Keyed by `${process.platform}-${process.arch}`.
  "artifacts": {
    "darwin-arm64": {
      "url": "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_mac_arm64.tar.gz",
      "checksum": "sha512:68f5…668e"
    },
    "win32-x64": {
      "url": "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_windows_amd64.zip",
      "checksum": "sha512:…"
    },
    "linux-x64": {
      "url": "https://example.com/tool-linux-x64.tar.xz",
      "checksum": "sha256:…",
      // Both optional:
      "format": "tar", // file | gzip | tar | zip. Inferred from the URL if not given.
      "path": "tool-2.11.7/bin/caddy" // The executable in the archive. `<name>` (`<name>.exe` on Windows) at the top if not given.
    }
  }
}
```

`ManifestSchema` validates it, and is a zod schema so it can sit inside a controller's spec. Narrow it to one binary
with `ManifestSchema.extend({ name: z.literal('caddy') })`.

- **The checksum is required.** The download is hashed as it streams, and rejected before it's unpacked if it doesn't
  match. Ideally manifests are written by tooling that reads a release's published checksums, not by hand.
- **Names and versions are single path segments** (letters, digits, `.`, `_`, `+`, `-`), and `path` must stay inside
  the archive, so a manifest can't write outside the store.

## Installing

Each install happens in a staging folder: download and verify, unpack, make executable, run the store's checks. Only
then is its record written and the folder renamed into place:

```
<directory>/<name>/<version>-<checksum>/install.json
                                        files/…        the whole archive, so files beside the binary come too
```

- **All or nothing.** An install interrupted at any point (an abort, a dropped connection, the process killed) leaves
  nothing that looks installed. The next install starts again, and the next prune clears the leftovers.
- **Cached.** Installing what's already installed is a lookup, with no request.
- **Keyed by version and checksum,** so a download re-published under the same version is a different install.
- **Safe to race in one process.** Two installs of the same download both resolve to the one that lands first, and a
  prune leaves alone any install still staging. Two processes sharing a directory aren't guarded against.

## Composing it

Each step can be swapped or added to:

| Step      | Default                                                                     | To change it                                                       |
| --------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Fetching  | `globalThis.fetch`                                                          | `fetch` option: add credentials, go through a mirror or cache      |
| Unpacking | `file`, `gzip` (Node's zlib), `tar` (the system's `tar`), `zip` (see below) | `unpackers` option, by format: `{ zip: myUnzip }`                  |
| Checking  | none                                                                        | `checks` option, run in order: `reportsVersion(args)`, or your own |

An unpacker is `({ download, into, path, signal }) => Promise<void>`. A check is `({ manifest, path, signal }) =>
Promise<void>`, and throws to turn the binary away. `reportsVersion(['version'])` runs `<binary> version` and requires
the output to mention the manifest's version, which catches a URL pointing at the wrong release. Signing checks
(cosign, minisign, codesign) would fit here too.

The system's `tar` ships with macOS, Linux and Windows 10+, and handles gzip, xz, bzip2 and zstd for itself. It reads
`.zip` on macOS and Windows; on Linux, `zip` uses `unzip`.

## Versions

- `find(manifest)`: the install, if it's installed.
- `list(name)`: every install of a binary, most recently installed first.
- `prune(keep, { spare })`: removes every other install of `keep`'s binary, except the `spare` most recent, so going
  back to one of those is instant.
- `remove(name)` and `clear()`: everything of one binary, or of all of them.

Which install a running process came from is the runtime's to record, not the store's. See
[`examples/caddy/managed.ts`](../../examples/caddy/managed.ts), which records it beside Caddy's pidfile.

These have been run on macOS. They haven't yet been run on Windows or Linux.
