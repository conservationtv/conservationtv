# @conservationtv/converge/process

A process that outlives the agent, for runtimes in the adopt-existing style: started detached with its log on a
file, found again through a record of which process it is, adopted when it is what the spec asks for and replaced when
it isn't.

```ts
import { AdoptedProcess } from '@conservationtv/converge/process';

const caddy = new AdoptedProcess(directory, {
  name: 'caddy', // what `ps` calls it, so a reused pid isn't mistaken for it
  probe: signal => admin.alive(signal), // up and answering?
  stop: () => admin.stop() // a graceful ask; SIGTERM if left out, and a kill after the grace period either way
});

// Up, answering and configured: the one being watched, one an earlier agent left that was started for the same key,
// or a new one, anything else found being stopped first.
const pid = await caddy.ensure(
  { key: installed.id, binary: installed.path, args: ['run'], configure: signal => admin.load(spec, signal) },
  signal
);
caddy.status$; // { state, pid, restarts, lastError }
caddy.dispose(); // the agent is stopping: stop watching, leave the process running
await caddy.stop(); // the key is removed: stop the process, even one left by an earlier agent
```

**The record**, `<name>.json` in the process's directory, says which process it is (its pid, and when it started, so
a reused pid isn't mistaken for it), what it was started for (its key) and as which instance. A process is adopted only
if it is the very process recorded, started for the same key, and, for a definition with `identify`, answers as that
instance: a name of its own each start is given, which `Run.prepare` puts where the process can be asked for it, such
as its config. So another process answering on the same address is never taken for it, and a start isn't counted
ready on another's answer.

**The key** is what adoption is judged by. It is recorded before the process starts, so an agent killed in between
still leaves the next one doing the right thing. Use the install's id for a binary that
reloads its config itself, and that with the config's revision for one that doesn't; `configure` runs after every
start, adoption and restart, for config that is loaded over an API.

**Ports.** A run naming its TCP `ports` has each freed before the process starts: a process of the same name holding
one, as one left by another agent or directory, is stopped; anything else holding one fails the start, naming it.

**Watching.** A process the agent didn't start can't be waited on, so its pid is checked every second. If it has
died, it is started again after a backoff that doubles from a second to thirty, and only starts again from a second
once a process has stayed up for thirty seconds. The status says so.

**The system** is asked through `/proc` on Linux, which needs no tools, and `ps` and `lsof` on macOS. Elsewhere
nothing is ever adopted, and ports aren't checked.

**The directory** holds `<name>.json` and `<name>.log`, and is the process's working directory unless the
run names another. The pieces are exported for runtimes that own their process another way: `findProcess`,
`freePorts`, `stopProcess`, `ready`, `answering`, `alive`, `restartDelay`, `exclusive` and `describe`, and the system's
`processInfo`, `portHolders` and `portOf`.

See [`examples/caddy`](../../examples/README.md): `adopted.ts` on `AdoptedProcess`, `managed.ts` adding the binary,
and `attached.ts` owning its child through execa but sharing the pieces.
