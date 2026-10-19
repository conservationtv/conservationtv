# Guide: vendoring binaries

Recipes for getting a binary from a release page into a runtime. The [README](README.md) describes the library; this
covers how to use it for the binaries you'll actually meet, which are packaged in more ways than you'd hope.

- [The shape of it](#the-shape-of-it)
- [Reading a release](#reading-a-release)
- [Choosing the format](#choosing-the-format)
- [Pointing at the executable](#pointing-at-the-executable)
- [Getting checksums](#getting-checksums)
- [Checking the version](#checking-the-version)
- [Binaries that need what came with them](#binaries-that-need-what-came-with-them)
- [Your own unpacker](#your-own-unpacker)
- [Your own checks](#your-own-checks)
- [Private, mirrored and proxied downloads](#private-mirrored-and-proxied-downloads)
- [Keeping records elsewhere](#keeping-records-elsewhere)
- [Upgrades, rollbacks and pruning](#upgrades-rollbacks-and-pruning)
- [Inside a converge controller](#inside-a-converge-controller)
- [Platforms](#platforms)
- [When it goes wrong](#when-it-goes-wrong)

## The shape of it

Three things, each written by someone different:

```ts
// 1. Code, written once beside the runtime: how this binary is packaged and checked.
export const tool = defineBinary({ name: 'tool', checks: [reportsVersion()] });

// 2. Data, in the spec: which version, and where to get it.
export const ToolSpecSchema = z.object({ tool: tool.schema });

// 3. Storage, one per agent: where installs live.
const binaries = new BinaryStore({ directory: '/var/lib/agent/binaries' });

const installed = await binaries.install(tool, spec.tool, signal);
```

Keep them apart. The definition changes when the binary's packaging changes, which is rare. The manifest changes
on every upgrade, and should be produced by tooling. The store doesn't change.

## Reading a release

Before writing anything, download one platform's release by hand and answer five questions:

1. **What is the file?** The binary itself, a compressed binary, or an archive? Check with `file <download>`, not the
   extension.
2. **Where in it is the executable?** `tar -tf` or `unzip -l` shows the layout.
3. **What's beside it?** Config files, libraries, helper scripts, other executables.
4. **How does it report its version, and what does it print?** Try `--version`, `-version`, `version` and `-V`.
5. **How are checksums published?** One file for the release, one per download, in the release notes, or not at
   all.

Each answer maps to a section below.

## Choosing the format

The format is always declared, per platform, because releases often package each platform differently: a tarball
for Linux and macOS, and a zip for Windows.

| The download is…                                                                         | `format` | Notes                                                                 |
| ---------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| the executable itself                                                                    | `file`   | Common for single-file Go, Rust and PyInstaller builds                |
| the executable, gzipped (`.gz`, not `.tar.gz`)                                           | `gzip`   |                                                                       |
| the executable, bzip2'd (`.bz2`, not `.tar.bz2`)                                         | `bzip2`  | Uses the system's `bzip2`; not on Windows                             |
| a tarball, compressed any way (`.tar.gz`, `.tgz`, `.tar.xz`, `.tar.bz2`, `.tar.zst`)     | `tar`    | The system's `tar` works out the compression                          |
| a zip                                                                                    | `zip`    | `tar` on macOS and Windows, `unzip` on Linux                          |
| an installer (`.pkg`, `.msi`, `.dmg`), a package (`.deb`, `.rpm`), a lone `.xz`, a `.7z` | yours    | See [your own unpacker](#your-own-unpacker), or find another download |

Prefer a portable archive over an installer if the project publishes both: an installer usually wants
administrator rights and writes outside the store.

## Pointing at the executable

`path` is where the executable is inside what the download unpacks to. Leave it out when the executable is named
after the binary and sits at the top: `<name>`, or `<name>.exe` on Windows. For `file`, `gzip` and `bzip2`, `path`
is simply what the executable is saved as, so leave it out.

Archives often nest everything in a folder named after the release, so `path` changes with every version and
platform:

```jsonc
"darwin-arm64": { "format": "tar", "path": "tool-1.4.0-aarch64-apple-darwin/tool", … },
"linux-x64":    { "format": "tar", "path": "tool-1.4.0-x86_64-unknown-linux-musl/tool", … },
"win32-x64":    { "format": "zip", "path": "tool-1.4.0-x86_64-pc-windows-msvc/tool.exe", … }
```

That's normal. Generate these along with the checksums rather than writing them by hand.

When the executable isn't named after the binary (a binary called `ripgrep` whose executable is `rg`), either name
the binary after the executable, or give `path` everywhere. Remember `.exe` on Windows when you give `path`.

## Getting checksums

The checksum is required, and it's the only thing standing between a compromised or mistaken URL and running
whatever it serves. Where it comes from matters more than its format.

**A checksums file for the whole release** (`SHA256SUMS`, `checksums.txt`, `sha256sum.txt`) is the most common.
Lines are `<hex>  <file name>`, sometimes with a `*` or `./` before the name:

```ts
/** The `sha256:<hex>` for `file` in a `<hex>  <name>` checksums file. */
async function fromChecksumsFile(url: string, file: string): Promise<string> {
  const text = await (await fetch(url)).text();
  for (const line of text.split('\n')) {
    const [hex, name] = line.trim().split(/\s+/);
    if (hex !== undefined && name?.replace(/^\*|^\.\//, '') === file) return `sha256:${hex.toLowerCase()}`;
  }
  throw new Error(`${file} isn't in ${url}`);
}
```

**A checksum file per download** (`<download>.sha256`) holds one line, sometimes with the name after the hash:
take the first word.

**SHA-512 instead** (`SHA2-512SUMS`): use `sha512:<hex>`. Either works; use whichever the project publishes.

**No checksums at all**: download it once, inspect it, hash it yourself (`shasum -a 256 <download>`), and commit
the result. You're then pinning what you saw rather than what the project vouched for, so do it from a trusted
network, and prefer a project that publishes signatures if there's a choice.

Do this in the tooling that writes the spec, not in the agent at install time. Fetching the checksum from the same
place as the download, at the moment of installing, proves only that the two agree, not that either is right.

## Checking the version

`reportsVersion` runs the binary and requires its output to mention the manifest's version. It catches a URL
pointing at the wrong release, which the checksum can't catch if the checksum came from the same wrong place.

**Find the right arguments.** There's no standard: `--version`, `-version`, `version`, `-V`. Some print to stderr
(both are read). Some print several lines (all are read).

**Use the version the binary reports, not the release's tag.** They usually agree apart from a leading `v`, which is
ignored. When they don't (releases tagged by date, or by a build number, while the binary reports a semver), the
manifest's `version` is what the binary says, and the tag only appears in the URL. A letter right before the version
is fine (`go1.27.2`, `tool-1.4.0`); a longer version isn't (`1.4.0` doesn't match `1.4.01`).

**Allow for slow starts.** The check gives the binary 30 seconds. Single-file bundles that unpack themselves on
every run (PyInstaller and similar) can take several seconds just to print a version, and macOS scans a new
executable the first time it runs. Raise it if needed:

```ts
defineBinary({ name: 'tool', checks: [reportsVersion(['--version'], { timeout: 60_000 })] });
```

**When there's no version to check**, leave `reportsVersion` out, and consider a smoke test instead (see
[your own checks](#your-own-checks)). Some binaries refuse to run at all without a config, a licence or a network;
don't make installing depend on those.

## Binaries that need what came with them

The store keeps the whole archive, and `installed.directory` is where it is. `installed.path` alone isn't always
enough:

- **Config beside the binary.** Some servers look for their default config in the working directory, not beside
  the executable. Run them from `installed.directory`, or pass the config's path explicitly. Explicit is better: it
  doesn't break when the archive's layout does.
- **Other executables in the same archive** (a CLI with companion tools, a runtime with its package manager). Join
  their paths onto `installed.directory`. If they find each other through `PATH`, as scripts with a
  `#!/usr/bin/env <runtime>` line do, put the install's `bin` folder first on the child's `PATH`.
- **Shared libraries.** Builds that link to libraries shipped beside them usually find them through a relative
  `rpath`, which works because the layout is kept. If not, set `LD_LIBRARY_PATH` (Linux) or `DYLD_LIBRARY_PATH`
  (macOS) for the child only.
- **Symlinks** inside archives are kept as symlinks.

```ts
const bin = dirname(installed.path);
spawn(installed.path, args, {
  cwd: installed.directory,
  env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
});
```

Don't write into `installed.directory`. It's shared by every runtime using that version, and is deleted when the
version is pruned. Keep config, data and logs in the runtime's own directory.

## Your own unpacker

An unpacker gets a verified download and an empty folder. It must leave the executable at `path` inside that
folder, write nothing outside it, and stop when `signal` aborts. Add it to the binary's definition; manifests can
then name its format.

A lone `.xz` file, with `xz` (on most Linux distributions, but not part of macOS or Windows):

```ts
const xz: Unpack = async ({ download, into, path, signal }) => {
  const compressed = `${join(into, path)}.xz`;
  await mkdir(dirname(compressed), { recursive: true });
  await rename(download, compressed);
  await promisify(execFile)('xz', ['-d', compressed], { signal });
};

defineBinary({ name: 'tool', unpackers: { xz } });
```

**Replacing a default** for one binary works the same way. For example, if your Linux hosts have no `unzip`, give
`zip` an implementation using a JavaScript zip library. Name a default to replace it; any other name adds a format.

**Wrapping one** is how to add a step for every download in a format, such as verifying a signature over the
archive itself before unpacking it (checks only see the unpacked executable):

```ts
function signed(unpack: Unpack, verify: (download: string, signal: AbortSignal) => Promise<void>): Unpack {
  return async unpacking => {
    await verify(unpacking.download, unpacking.signal);
    await unpack(unpacking);
  };
}

defineBinary({ name: 'tool', unpackers: { tar: signed(tar, verifyMinisign), zip: signed(zip, verifyMinisign) } });
```

Unpacking runs on the agent's machine, so prefer tools that ship with the OS. Every extra tool is something every
host needs installed.

## Your own checks

A check gets the unpacked executable before it's installed, and throws to turn it away. Checks run in order, so put
cheap ones first.

**A smoke test**, for binaries without a usable version:

```ts
const runs: Check = async ({ path, signal }) => {
  await promisify(execFile)(path, ['--help'], { signal, timeout: 30_000 });
};
```

**Code signing on macOS**, rejecting binaries that aren't validly signed:

```ts
const signedForMac: Check = async ({ path, signal }) => {
  if (process.platform !== 'darwin') return;
  await promisify(execFile)('codesign', ['--verify', '--strict', path], { signal });
};
```

**Architecture**, catching a manifest that points `darwin-arm64` at an Intel build, which would otherwise run
slowly under Rosetta or not at all: run `file` on `path`, or read the executable's header.

Keep checks free of side effects. They run on every install, including installs that are then turned away.

## Private, mirrored and proxied downloads

Give the store a `fetch`. It's called with each artifact's URL, so it can rewrite the URL, add headers, or both.

**Credentials for one host**, and only that host:

```ts
const binaries = new BinaryStore({
  directory,
  fetch: (url, init) => {
    const headers = new Headers(init.headers);
    if (new URL(url).hostname === 'artifacts.internal') headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  }
});
```

Check the hostname rather than adding credentials to everything: the `fetch` sees every URL any manifest names, and
redirects can take a download elsewhere.

**Private GitHub releases** can't be downloaded from their public `releases/download/…` URL. Use the API's asset URL
(`https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`) in the manifest, and have the `fetch` send the
token along with `Accept: application/octet-stream`.

**A mirror or cache**: rewrite the URL in `fetch`, and keep the original in the manifest. The checksum still has to
match, so a mirror can't serve anything else.

Don't retry in `fetch`. A failed download fails the install, and under converge that's retried with backoff.

## Keeping records elsewhere

The store's files have to be on the machine that runs them, but its records (what's installed, from which manifest,
and when) go wherever its `persistence` puts them. The default is a JSON file in the store's directory, which suits
most agents. Reasons to change it:

**Keep them with the rest of the agent's state.** If the agent already saves its converge spec to a database, keep
the records there too, so backups and inspection cover both:

```ts
const binaries = new BinaryStore({
  directory,
  persistence: {
    restore: async () => (await state.read('binaries')) ?? [],
    sink: records => state.write('binaries', records)
  }
});
```

**Throwaway stores**, for a scratch directory, a test, or a CI job: `inMemory()`. Nothing is written beside the
files, and every install is forgotten when the process exits. A later store on the same directory treats the files
as leftovers and prunes them.

**Records in a shared database.** Records describe files on one machine, so key them by machine (a host id in the
key or the row). A store restoring another machine's records would drop them all, since their files aren't there,
and its first save would overwrite them.

Whatever it saves to, a `persistence` must:

- **Save the whole list it's given, and replace what was there.** `sink` gets every record each time, not a change.
- **Save atomically.** A save cut short must leave the previous list, not half of the new one. Write and rename for
  files; one write or a transaction for databases.
- **Throw if the save didn't happen.** The store only believes an install is installed once `sink` resolves. A
  `sink` that swallows errors leaves the store believing in records that weren't saved, and on the next start those
  installs are downloaded again.
- **Return exactly what was saved from `restore`.** It's parsed with `InstallRecordSchema`; anything that doesn't
  parse stops the store from working until it's fixed.

`restore` is only called once, the first time the store is used, so records changed elsewhere while the store is
running aren't seen. Give each store its own records, as with its own directory.

## Upgrades, rollbacks and pruning

Installs are keyed by version and checksum, so changing either in the spec installs alongside, not over, what's
there. What the store doesn't know is which install is in use. That's for the runtime to decide.

**Prune after switching, not before.** Install the new version, move the process over, and only then prune. If the
switch fails, the old install is still there.

**Keep a spare for quick rollbacks.** `prune(current, { spare: 1 })` keeps the most recent other install too, so
going back a version needs no download. Spares are chosen by when they were installed, not when they were last used.

**One owner per binary.** `prune` removes every other install of that binary's name. If two runtimes in one agent
run different versions of the same binary from the same store, either one's prune deletes the other's install. Give
them separate stores (separate directories), or prune from one place that knows about both.

**Record what's running** if the process outlives the agent. An agent that restarts after the spec has changed
needs to know whether the running process came from the version the spec now asks for. Write `installed.id` beside
the process's pidfile before starting it, and compare it on the next start.

**Removing everything**: `remove(name)` for one binary, `clear()` for the store. Stop processes first; deleting a
running executable's file works on macOS and Linux, but not on Windows.

## Inside a converge controller

`execute` installs, then switches over, then prunes. A failed install fails the apply and is retried, and nothing
already running is touched until a good install exists.

```ts
const tool = defineBinary({ name: 'tool', checks: [reportsVersion()] });
const binaries = new BinaryStore({ directory: join(home, 'binaries') });
const status$ = new BehaviorSubject<ToolStatus>({ version: null, installing: false });

controller({
  spec: z.object({ tool: tool.schema }),
  status: status$,
  async execute(spec, signal) {
    status$.next({ ...status$.getValue(), installing: true });
    const installed = await binaries
      .install(tool, spec.tool, signal)
      .finally(() => status$.next({ ...status$.getValue(), installing: false }));
    await switchTo(installed, signal); // restart, reload or swap: specific to the runtime
    status$.next({ version: installed.version, installing: false });
    await binaries.prune(installed, { spare: 1 });
  },
  async finalize() {
    await stopProcess();
    await binaries.remove(tool.name);
  }
});
```

- **Pass the signal through.** A newer spec aborts the install in progress, and the staging folder is cleaned up.
- **Put the manifest in the spec**, using the binary's `schema`, so a bad manifest is rejected when the spec changes,
  not discovered on install.
- **Report installing separately** from running. A large download can take a while, and it's useful to see that the
  old version is still serving while the new one installs.
- See [`examples/caddy/managed.ts`](../../examples/caddy/managed.ts) for a complete runtime that adopts a process
  left running and records which install it came from.

## Platforms

Artifacts are keyed by `${process.platform}-${process.arch}`: `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64`, `win32-x64`, `win32-arm64`. Use `platform()` to get this machine's key.

- **List every platform the agent runs on.** A missing one fails the install with a clear error rather than falling
  back to something else.
- **The same download for several platforms** (a macOS universal binary, or a script) is fine: repeat it under each
  key.
- **Linux builds come in two kinds of C library**: glibc and musl. Prefer static or musl builds for an agent, since
  they run on any distribution.
- **Windows**: the default `path` adds `.exe`; one you give doesn't. There's no `bzip2`, and the Windows `tar` is
  only on Windows 10 and later.

## When it goes wrong

| Error                                    | Usually                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `… doesn't match its checksum`           | The checksum is for another platform or version. The URL redirected to an HTML error page. The project re-published the file. |
| `… has no <path> in it`                  | The archive nests the executable in a folder; give `path`. Or the format is wrong.                                            |
| `Running … failed: spawn ENOEXEC`        | The download isn't an executable: declared `file` but it's compressed, or it's another platform's build.                      |
| `Asked for … but … reports …`            | The manifest's version is the release's tag, not what the binary reports; or the URL is for another release.                  |
| `Running … failed: no answer within 30s` | A slow-starting binary: raise `reportsVersion`'s timeout.                                                                     |
| `No … download for <platform>`           | The manifest has no artifact for this machine.                                                                                |
| `… has no unpacker for the format …`     | A format the binary's definition doesn't have. Add an unpacker, or fix the manifest.                                          |
| The spec fails to parse at `format`      | Same, caught earlier: the binary's `schema` only accepts formats it can unpack.                                               |

To see what the store has, look at its records: `.installs.json` in its directory by default, holding each install's
manifest. Folders in the directory with no record, and `.staging-*` folders, are installs that didn't finish, which
the next prune removes.
