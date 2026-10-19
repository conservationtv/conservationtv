# @conservationtv/converge/process

A process that outlives the agent, for runtimes in the adopt-existing style: started detached with its log on a
file, found again through a pidfile, adopted when it is what the spec asks for and replaced when it isn't.

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

**The key** is what adoption is judged by. It is recorded in the process's directory before the process starts, so an
agent killed in between still leaves the next one doing the right thing. Use the install's id for a binary that
reloads its config itself, and that with the config's revision for one that doesn't; `configure` runs after every
start, adoption and restart, for config that is loaded over an API.

**Watching.** A process the agent didn't start can't be waited on, so its pid is checked every second. If it has
died, it is started again after a backoff that doubles from a second to thirty, and the status says so.

**The directory** holds `<name>.pid`, `<name>.key` and `<name>.log`, and is the process's working directory unless the
run names another. The pieces are exported for runtimes that own their process another way: `findProcess`,
`stopProcess`, `ready`, `answering`, `alive`, `restartDelay`, `exclusive` and `describe`.

See [`examples/caddy`](../../examples/README.md): `adopted.ts` on `AdoptedProcess`, `managed.ts` adding the binary,
and `attached.ts` owning its child through execa but sharing the pieces.
