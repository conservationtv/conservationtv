# @conservationtv/converge/process

A process that is the agent's own child, living and dying with it: started with its log on a file, watched through
its exit, restarted after a crash, and stopped when the agent stops.

```ts
import { AttachedProcess } from '@conservationtv/converge/process';

const caddy = new AttachedProcess(directory, {
  name: 'caddy', // what `ps` calls it, so a reused pid isn't mistaken for an orphan
  probe: signal => admin.alive(signal), // up and answering?
  stop: () => admin.stop() // a graceful ask; SIGTERM if left out, and a kill after the grace period either way
});

// Up, answering and configured: the one running if it was started for the same key, or a new one in its place.
const pid = await caddy.ensure(
  { key: installed.id, binary: installed.path, args: ['run'], configure: signal => admin.load(spec, signal) },
  signal
);
caddy.status$; // { state, pid, restarts, lastError }
caddy.dispose(); // the agent is stopping: the process goes with it
await caddy.stop(); // the key is removed: stop the process
```

**The key** says when the process has to be replaced. Use the install's id for a binary that reloads its config
itself, and that with the config's revision for one that doesn't; `configure` runs after every `ensure` and restart,
for config that is loaded over an API.

**Matched lifecycle.** The process is started with [execa](https://github.com/sindresorhus/execa), with `cleanup`
and `killDescendants`, so it goes when the agent exits, and the next agent starts afresh. Nothing runs when an agent
is killed outright (`SIGKILL`, out of memory), so its pid is recorded for that case alone: the next agent stops the
orphan before starting its own, and refuses to start while something else answers the probe in its place.

**Watching.** An unexpected exit is noticed at once, and the process is started again after a backoff that doubles
from a second to thirty. The status says so, with the exit code or signal.

**The directory** holds `<name>.pid` and `<name>.log`, and is the process's working directory unless the run names
another. The pieces are exported for runtimes that own their process another way: `findProcess`, `stopProcess`,
`ready`, `answering`, `alive`, `restartDelay`, `exclusive` and `describe`.

See [`examples/caddy`](../../examples/README.md): `attached.ts` on `AttachedProcess`, and `managed.ts` adding the
binary.
