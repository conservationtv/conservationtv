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
  nothing if the config hasn't changed. So `execute` can run again safely, and adopting a running Caddy doesn't
  disturb it.
- **A graceful stop on every platform**: `POST /stop` works on Windows too, where there's no `SIGTERM` to send.
- **A pidfile**: `caddy run --pidfile <path>`.

They share `caddy.ts`: the spec, the status, the admin API client, and finding and stopping a Caddy by pid. The first
two differ only in how Caddy's life relates to the agent's. The third adopts like the second, and also downloads and
manages the Caddy binary itself.

### Matched lifecycle: `AttachedCaddyRuntime`

Caddy is the agent's child, and lives and dies with it.

- Started with [execa](https://github.com/sindresorhus/execa), with `cleanup` (killed if the agent exits) and
  `killDescendants`.
- Watched through its process: an unexpected exit is noticed at once and Caddy is started again after a backoff.
- `dispose()` stops Caddy. On the next start, converge hands the spec back and Caddy starts afresh.

### Adopt existing: `AdoptedCaddyRuntime`

Caddy is a process of its own, and outlives the agent.

- Started detached and unreferenced, with `node:child_process`, writing its pid to a pidfile.
- `dispose()` only stops watching. Caddy carries on serving while the agent is away.
- On the next start, `execute` finds Caddy through the pidfile and adopts it, after checking that the pid is alive,
  that it really is Caddy (with [ps-list](https://github.com/sindresorhus/ps-list), since a pid can be reused), and
  that it answers on its admin API. Reloading the same spec is a no-op, so adopting doesn't disturb it.
- A process the agent didn't start can't be waited on, so Caddy is watched by checking its pid every second.
- `finalize()` stops Caddy, including one left behind by an earlier agent when its key was removed while the agent
  was down. It uses [tree-kill](https://github.com/pkrulec/node-tree-kill) as a last resort, because there's no
  execa handle to kill through.

### Managing the binary too: `ManagedCaddyRuntime`

The adopting runtime, also deciding which Caddy it runs. The spec names a version, with a download and checksum for
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
install, and adopts the running Caddy with no download.

`ManagedCaddyRuntime` composes the adopting runtime rather than copying it, with one `AdoptedCaddyRuntime` per
install:

- **Changing what Caddy serves** is still a reload in place.
- **Changing the version replaces the process.** The old Caddy is stopped and the new binary started, with a
  moment's downtime while the port changes hands. Afterwards, every install but the current one and the one before
  it is pruned, so going back a version needs no download.
- **Across agent restarts**, which install the running Caddy came from is recorded beside its pidfile (`binary.json`).
  An agent that finds the version changed while it was away replaces Caddy rather than adopting the old one. The
  record is written before the new Caddy starts, so a kill in between still leaves the next agent doing the right
  thing.
- **A download that fails, or doesn't match its checksum,** fails the apply and is retried with converge's backoff,
  while the Caddy already running carries on serving untouched.
- **Removing the key** stops Caddy, and removes the vendored binaries and the record too.

What it costs: a version change means a moment's downtime. A zero-downtime upgrade would need two Caddys side by side
on different ports with something switching traffic between them, which is beyond this example. The agent also needs
outbound network access to wherever the downloads live, and a mistyped checksum in the spec blocks that key until it's
fixed. That's the point of having a checksum, but it means the spec has to be produced carefully: ideally by tooling
that reads the release's published checksums, rather than by hand.

### The trade-off

|                                        | Matched lifecycle                               | Adopt existing                                                                              |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Agent restart (deploy, crash)          | Downtime: Caddy stops and starts again          | No downtime: Caddy keeps serving                                                            |
| Matches converge's "stop isn't remove" | No: stopping the agent removes the process      | Yes                                                                                         |
| Noticing a crash                       | Immediate, from the exit event                  | Up to a second, by checking the pid                                                         |
| Exit code and reason for a crash       | Known                                           | Unknown: only that the pid is gone                                                          |
| Logs                                   | Can be piped through the agent                  | Must go to a file (or Caddy's own logging), never through the agent                         |
| What can go wrong                      | Only a hard-killed agent leaves anything behind | Stale pidfiles, reused pids, a process from an older version                                |
| Upgrading the binary                   | Picked up on the next agent start               | Not picked up until the process is replaced: compare versions when adopting if that matters |
| Code                                   | Smaller: execa does most of the work            | Larger: it has to find, verify and watch a process it doesn't own                           |

Choose **matched lifecycle** when downtime across agent restarts is acceptable, and you want the simplest, most
predictable thing. Most processes an agent runs are like this.

Choose **adopt existing** when the process serves traffic that shouldn't drop on every deploy of the agent, or is
expensive to start. You pay for it in the complexity of re-identifying a process you didn't start.

### Lessons from running these against a real Caddy

- **Don't talk to Caddy's admin API with Node's built-in `fetch`.** It sends the `Sec-Fetch-*` headers a browser
  would, and Caddy refuses those (`403`) to keep websites away from its local admin API. `caddy.ts` uses `node:http`.
- **A detached process must not write through the agent.** execa's `{ file }` output pipes the child's output through
  the parent, which keeps the agent from exiting, and breaks the child's output once the agent is gone. That's why
  the adopted runtime uses plain `spawn` with the log file's descriptor as its stdout and stderr. execa is built
  around owning its child, which is exactly what detaching gives up.
- **"Matched" isn't guaranteed.** `cleanup` can't run when the agent is killed outright (`SIGKILL`, out of memory),
  so its Caddy is orphaned. The next agent's Caddy then fails to bind the admin address, and readiness checks get
  answered by the orphan instead. The attached runtime writes a pidfile for that case alone: it stops a leftover
  Caddy before starting its own, and refuses to start if something else answers on its admin address.
- **Listen for `spawn` before awaiting anything else.** It fires on the next tick, and a missed event is a hang.

### Using one

```ts
import { controller, converge } from '@conservationtv/converge';
import { AdoptedCaddyRuntime } from './caddy/adopted.ts';
import { CaddySpecSchema } from './caddy/caddy.ts';

const caddy = new AdoptedCaddyRuntime({ binary: 'caddy', admin: 'localhost:2999', directory: '/var/lib/agent/caddy' });

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

Each runtime needs an admin address and a directory of its own. These have been run against Caddy 2.11 on macOS.
They avoid signals where it matters, but haven't yet been run on Windows or Linux.
