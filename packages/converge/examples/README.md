# Examples

## Managing a process: `caddy/`

Runtimes that run [Caddy](https://caddyserver.com) as a process and converge it to a spec: one site on a port,
answering every request with a body.

```ts
const CaddySpecSchema = z.object({ port: z.number().int(), body: z.string() });
```

Caddy makes a good exercise because it covers the whole controller contract in one small, cross-platform binary:

- **Readiness**: its admin API answers once it's up.
- **Changing the spec without a restart**: `POST /load` swaps the config without dropping connections, and does
  nothing if the config hasn't changed. So `execute` can run again safely.
- **A graceful stop on every platform**: `POST /stop` works on Windows too, where there's no `SIGTERM` to send.

They share `caddy.ts`: the spec, the status, the admin API client, and Caddy as a process definition for
[`@conservationtv/converge/process`](../src/process/README.md). The second runs Caddy as the first does, and also
downloads and manages the Caddy binary itself.

### Matched lifecycle: `AttachedCaddyRuntime`

Caddy is the agent's child, and lives and dies with it. Built on `AttachedProcess`, which does the work:

- Started with [execa](https://github.com/sindresorhus/execa), with `cleanup` (killed if the agent exits) and
  `killDescendants`, its output appended to a log file.
- Watched through its process: an unexpected exit is noticed at once and Caddy is started again after a backoff.
- The site is loaded through `configure`, which runs on every `execute` and restart; reloading the same spec is a
  no-op.
- `dispose()` stops Caddy. On the next start, converge hands the spec back and Caddy starts afresh.
- `finalize()` stops Caddy too, gracefully through its admin API, killing it after a grace period if it won't go.

### Managing the binary too: `ManagedCaddyRuntime`

The attached runtime, also deciding which Caddy it runs. The spec names a version, with a download and checksum for
each platform it runs on:

```ts
{
  port: 8080,
  body: 'Hello',
  caddy: {
    name: 'caddy',
    version: '2.11.7',
    artifacts: {
      'darwin-arm64': { url: 'https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_mac_arm64.tar.gz', checksum: 'sha512:68f5…668e', format: 'tar' },
      'linux-x64': { url: '…/caddy_2.11.7_linux_amd64.tar.gz', checksum: 'sha512:…', format: 'tar' },
      'win32-x64': { url: '…/caddy_2.11.7_windows_amd64.zip', checksum: 'sha512:…', format: 'zip' }
    }
  }
}
```

The spec's `caddy` is a manifest from [`@conservationtv/converge/binaries`](../src/binaries/README.md), validated by
`caddyBinary.schema`. The runtime's store installs it into the runtime's own directory: verified against its checksum
as it streams, unpacked and checked in a staging folder, and only then moved into place, so an install interrupted at
any point leaves nothing that looks installed. `caddyBinary` also checks that `caddy version` reports the version the
spec asked for, which catches a URL pointing at the wrong release. An agent restarting on the same spec reuses the
install, with no download.

`ManagedCaddyRuntime` composes the attached runtime rather than copying it, with one `AttachedCaddyRuntime` per
install:

- **Changing what Caddy serves** is still a reload in place.
- **Changing the version replaces the process.** The old Caddy is stopped and the new binary started, with a
  moment's downtime while the port changes hands. Afterwards, every install but the current one and the one before
  it is pruned, so going back a version needs no download.
- **A download that fails, or doesn't match its checksum,** fails the apply and is retried with converge's backoff,
  while the Caddy already running carries on serving untouched.
- **Removing the key** stops Caddy, and removes the vendored binaries too.

What it costs: a version change means a moment's downtime. A zero-downtime upgrade would need two Caddys side by side
on different ports with something switching traffic between them, which is beyond this example. The agent also needs
outbound network access to wherever the downloads live, and a mistyped checksum in the spec blocks that key until it's
fixed. That's the point of having a checksum, but it means the spec has to be produced carefully: ideally by tooling
that reads the release's published checksums, rather than by hand.

### Why the process doesn't outlive the agent

A process left running across agent restarts keeps serving through a deploy, but the next agent then has to find it
again and be sure it's the right one: stale pidfiles, reused pids, a process left by another agent on the same ports,
one from an older version, and a different way to inspect processes on every platform. It also outlives only half
the work when the agent does part of it itself, as the agent's MediaMTX runtime does by joining its broadcasts.
Matched lifecycle accepts the downtime of an agent restart to avoid all of that.

### Lessons from running these against a real Caddy

- **Don't talk to Caddy's admin API with Node's built-in `fetch`.** It sends the `Sec-Fetch-*` headers a browser
  would, and Caddy refuses those (`403`) to keep websites away from its local admin API. `caddy.ts` uses `node:http`.
- **"Matched" isn't guaranteed.** `cleanup` can't run when the agent is killed outright (`SIGKILL`, out of memory),
  so its Caddy is orphaned. The next agent's Caddy then fails to bind the admin address, and readiness checks get
  answered by the orphan instead. `AttachedProcess` writes a pidfile for that case alone: it stops a leftover Caddy
  before starting its own, and refuses to start if something else answers on its admin address.

### Using one

```ts
import { controller, converge } from '@conservationtv/converge';
import { AttachedCaddyRuntime } from './caddy/attached.ts';
import { CaddySpecSchema } from './caddy/caddy.ts';

const caddy = new AttachedCaddyRuntime({ binary: 'caddy', admin: 'localhost:2999', directory: '/var/lib/agent/caddy' });

const system = await converge({
  controllers: {
    site: controller({
      spec: CaddySpecSchema,
      status: caddy.status$,
      execute: (spec, signal) => caddy.execute(spec, signal),
      finalize: () => caddy.finalize(),
      dispose: () => caddy.dispose()
    })
  },
  restore: async () => ({ site: { port: 8080, body: 'Hello' } })
});
```

Each runtime needs an admin address and a directory of its own. The attached runtime was run against Caddy 2.11 on
macOS before it moved onto `AttachedProcess`, and hasn't been run since, nor yet on Windows or Linux.
