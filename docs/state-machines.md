# State machines

Every piece of state in camera control and chat commands that changes over time is an explicit `@xstate/store` store, or, in the stateless studio API, a pure decision function over pre-read facts. Each source file keeps an ASCII diagram in its header comment; this page gathers them into one reference and shows how they fit together across the browser, the agent and the studio API.

## Conventions

All the stores follow the same shape:

- **Discriminated unions on `status`.** Every sub-machine's state is a discriminated union on `status` (with inner two-step phases on `phase` for `LinkRetry` and `CameraClaim`, and a flat `used` map in the single-use grant ledger).
- **Named events only.** Nothing mutates a store outside its event handlers. Stale or out-of-order callbacks are dropped by monotonic sequence numbers (`seq`, `stream`, `sends`) and time guards (`deadline > at`, `until > at`).
- **Pure transitions and explicit time.** Transitions compute the next context and enqueue effects; they never open sockets, call drivers or make HTTP requests. On the agent, every event carries `at` (epoch milliseconds) so transitions never read the clock. In the browser, stores schedule relative delays on an injectable `CameraClock`, and the drive store reads its injectable `now` clock. In the studio API, `decideUse` and `resolveCameraPreset` take `now` and facts read beforehand.
- **Effects and thin shells for timers and I/O.**
  - **Agent** ([apps/agent/core/src/time.ts](../apps/agent/core/src/time.ts)): stores never own timers. Each store exposes `alarmsOf(context)` returning the named deadlines its state wants; `Alarms` reconciles real or fake timers on every snapshot change and rings the corresponding event when due. Async I/O uses `within(time, ms, also, work)` to bound calls against both a timeout and an `AbortSignal`. Thin shells (`CameraControl`, `TwitchChat`, `ChatRuntime`) translate method calls into events and wire effects.
  - **Browser** ([apps/studio/web/src/components/cameras/control/store/camera-tasks.ts](../apps/studio/web/src/components/cameras/control/store/camera-tasks.ts)): stores own timers, SSE streams and window listeners through `namedTasks()` inside `enq.effect`. Starting a task under a name cancels whatever ran under that name before, and `stopAll()` cancels everything.
- **Injectable dependencies.** Every store accepts fakes for its clock, drivers, sockets, agent transport, studio client, gamepad and focus.
- **Derived views and status.** Nothing duplicates store state. Agent `status$` subjects, SSE watch streams and React selectors (`useCamera`, `useSteering`, `useZoomDrag`, etc.) are all derived from store snapshots.

## Map

| Machine                                   | Runs in    | File                                                                                                                                                            | Purpose                                                                                                          |
| ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Camera store (`cameraStore`)              | Agent      | [apps/agent/core/src/cameras/camera-machine.ts](../apps/agent/core/src/cameras/camera-machine.ts)                                                               | Per-camera control lifecycle, operator hold, drive stop-deadline, watcher polling and capability caching         |
| Grant ledger (`ledgerStore`)              | Agent      | [apps/agent/core/src/cameras/camera-machine.ts](../apps/agent/core/src/cameras/camera-machine.ts)                                                               | Tracks spent single-command grants across camera re-registrations until they expire                              |
| Twitch chat connection (`twitchStore`)    | Agent      | [apps/agent/core/src/output/chat/twitch.ts](../apps/agent/core/src/output/chat/twitch.ts)                                                                       | Anonymous IRC-over-WebSocket connection, channel join/part diffing, `PING`/`RECONNECT` handling and backoff      |
| Chat command uses (`usesStore`)           | Agent      | [apps/agent/core/src/output/chat/uses.ts](../apps/agent/core/src/output/chat/uses.ts)                                                                           | Per-command spacing, in-flight serialisation (`telling` → `carrying` → `settling`), waiting coalescing and rests |
| Control session (`createCameraStore`)     | Browser    | [apps/studio/web/src/components/cameras/control/store/camera-store.ts](../apps/studio/web/src/components/cameras/control/store/camera-store.ts)                 | SSE stream following with silence and retry timers, cooperative operator lock and optimistic claims              |
| Hand driving (`createDriveStore`)         | Browser    | [apps/studio/web/src/components/cameras/control/drive/camera-drive-context.ts](../apps/studio/web/src/components/cameras/control/drive/camera-drive-context.ts) | Continuous steering loop across six prioritised inputs (with gamepad and blur) and throttled zoom-slider drags   |
| Gamepad shoulders (`createShoulderStore`) | Browser    | [apps/studio/web/src/components/cameras/control/drive/camera-shoulders.ts](../apps/studio/web/src/components/cameras/control/drive/camera-shoulders.ts)         | Edge-detected L1/R1 polling above any camera session so holding a button steps once across camera swaps          |
| Chat command decision (`decideUse`)       | Studio API | [apps/studio/api/src/chat/decide.ts](../apps/studio/api/src/chat/decide.ts)                                                                                     | Pure decision over pre-read facts, paired with atomic cooldown claim/give-back and stateless HS256 receipts      |

---

## Agent machines

### Camera store (`cameraStore`)

Files: [apps/agent/core/src/cameras/camera-machine.ts](../apps/agent/core/src/cameras/camera-machine.ts) (store and `Alarms`), [apps/agent/core/src/cameras/control.ts](../apps/agent/core/src/cameras/control.ts) (`CameraControl` shell), [apps/agent/core/src/cameras/events.ts](../apps/agent/core/src/cameras/events.ts) (SSE framing).

`CameraControl` keeps one `cameraStore` per `enabled` camera. Its context (`CameraContext`) carries `id`, `seq` (monotonic command/ask counter) and five orthogonal sub-machines: `life`, `hold`, `drive`, `watch` and `capabilities`.

```
life          controlled ── released (drive idle) ────────────────────────────────────▶ released(moving: false)
                   │                                                                         ▲
                   ├── released (drive driving/stopping) ──▶ releasing(seq) ── haltSucceeded ┘
                   │                                               │
                   │                                               └── haltFailed ────▶ released(moving: true)
                   └── disposed (from any state) ─────────────────────────────────────▶ released(moving)

hold          free ── commanded(operator) ──▶ held(peer, until) ── holdLapsed / standing(at) ──▶ free
                                                │  ▲
                                                └──┘ commanded(operator): new peer, until = at + HOLD_MS

drive         idle ── commanded(drive) / adopted ──▶ driving(since, deadline) ── deadlinePassed ──▶ stopping(seq)
               ▲                                      │  ▲      ▲                                     │     │
               │                                      │  │      └──────────── haltFailed ─────────────┘     │
               │                                      │  └─ commanded(drive) or latest drive answered/failed│
               ├──────────────────────────────────────┴──────── haltSucceeded ◀─────────────────────────────┘
               └── commandSucceeded (move or stop, seq > since / seq > stopping.seq) ───────────────────────┘

watch         unwatched ── watcherJoined ──▶ asking(seq, stale) ── answered / unanswered (not stale) ──▶ resting(since)
                  ▲                            ▲  │                                                          │
                  │                            │  └── answered / unanswered (stale: true)                    │
                  │                            └─────────── restEnded, or non-drive commandSucceeded ────────┘
                  └─────────────────────── last watcherLeft (from asking or resting) ─────────────────────────

capabilities  unknown ── capabilitiesWanted ──▶ asking ── capabilitiesAnswered ──▶ known(capabilities)
                 ▲                                │
                 └── capabilitiesUnanswered / released / disposed ────────────────┘
```

#### Events

All events carry `at` (epoch ms). The store emits `settled` (`{ id, outcome }` where `outcome.status` is `'done' | 'failed' | 'held' | 'gone'`) and `ended` (`{ at }`).

| Event                    | Effect on state                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commanded`              | If `life !== 'controlled'` emits `gone`; if `heldAgainst` (automation while another peer holds an active hold) emits `held`. Otherwise increments `seq`, takes/renews `hold` for `'operator'` (or clears a lapsed hold for `'automation'`), arms `drive` to `at + CAMERA_TIMEOUT_MS + DRIVE_TIMEOUT_MS` for `kind === 'drive'` (even from `stopping`), updates `watch.told` if holder changed, and enqueues the driver call.                    |
| `commandSucceeded`       | Emits `done`. If `life === 'controlled'`: for `drive`, shortens `drive.deadline` to `at + DRIVE_TIMEOUT_MS` if `seq === drive.since`; for `moveTo`, `moveBy`, `moveToPoint`, `moveToRegion` and `stop`, clears `drive` to `idle` if `seq` is newer than the active drive/stop; for every kind except `drive`, refreshes `watch` (asks at once if `resting`, or marks `stale: true` if `asking`). `configure` and `run` leave `drive` untouched. |
| `commandFailed`          | Emits `{ status: 'failed', error }`. If `life === 'controlled'` and `kind === 'drive'`, still shortens `drive.deadline` to `at + DRIVE_TIMEOUT_MS` (a timed-out drive may have reached the camera).                                                                                                                                                                                                                                             |
| `deadlinePassed`         | When `controlled`, `driving` and `drive.deadline <= at`: increments `seq`, enters `stopping(seq)` and enqueues `driver.stop`.                                                                                                                                                                                                                                                                                                                   |
| `haltSucceeded`          | If `releasing` and `life.seq === seq`, transitions `life` to `released(moving: false)`. Else if `stopping` and `drive.seq === seq`, transitions `drive` to `idle`.                                                                                                                                                                                                                                                                              |
| `haltFailed`             | If `seq` matches `releasing` or `stopping`, logs an error. In `releasing`, transitions `life` to `released(moving: true)`; in `stopping`, returns `drive` to `driving(since: seq, deadline: at + DRIVE_TIMEOUT_MS)` to retry.                                                                                                                                                                                                                   |
| `holdLapsed`             | Clears `hold` to `free` if `hold.until <= at` and updates `watch.told` if holder changed.                                                                                                                                                                                                                                                                                                                                                       |
| `watcherJoined`          | When `controlled`: if `unwatched`, starts `asking` (`watchers: 1`, `asks: 1`, reading options on the first ask); otherwise increments `watchers`.                                                                                                                                                                                                                                                                                               |
| `watcherLeft`            | Decrements `watchers`, or returns to `unwatched` when the last watcher leaves.                                                                                                                                                                                                                                                                                                                                                                  |
| `restEnded`              | When `resting` and `watch.since + restOf(drive) <= at`, starts a new `asking` poll.                                                                                                                                                                                                                                                                                                                                                             |
| `answered`               | Matching `watch.seq`: clears a lapsed hold via `standing(hold, at)`, merges `options` if read, updates `told` only when `[position, options, holder?.peer]` changed (ignoring timestamps), and transitions to `asking` (with `refresh: true`) if `stale`, else `resting(since: at)`.                                                                                                                                                            |
| `unanswered`             | Matching `watch.seq`: keeps previous `told`, and either re-asks at once (if `stale`) or enters `resting(since: at)`.                                                                                                                                                                                                                                                                                                                            |
| `capabilitiesWanted`     | When `controlled` and `capabilities === 'unknown'`, enters `asking` and enqueues `driver.capabilities`.                                                                                                                                                                                                                                                                                                                                         |
| `capabilitiesAnswered`   | When `asking`, moves `capabilities` to `known(capabilities)`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `capabilitiesUnanswered` | When `asking`, logs a warning and returns `capabilities` to `unknown`.                                                                                                                                                                                                                                                                                                                                                                          |
| `released`               | When `controlled`: emits `ended`, resets `hold`, `drive`, `watch` (and `asking` capabilities to `unknown`). If `drive` was `idle`, enters `released(moving: false)`; if `stopping`, adopts that in-flight stop as `releasing(drive.seq)`; if `driving`, sends a new stop as `releasing(seq)`.                                                                                                                                                   |
| `adopted`                | When `controlled` and `drive === 'idle'`: enters `driving(since: seq, deadline: at)` so `Alarms` fires `deadlinePassed` immediately. Used by `CameraControl.apply` when a camera is re-registered after an old registration was `released(moving: true)`.                                                                                                                                                                                       |
| `disposed`               | Emits `ended` if `controlled`, resets `hold`, `drive`, `watch` and `asking` capabilities, and sets `life` to `released(moving: context.drive.status !== 'idle')`.                                                                                                                                                                                                                                                                               |

#### Timers, constants and I/O

- **Alarms (`alarmsOf`)**: `hold` → `holdLapsed` at `hold.until`; `drive` → `deadlinePassed` at `drive.deadline`; `watch` → `restEnded` at `watch.since + (drive.status === 'idle' ? WATCH_INTERVAL_MS : DRIVEN_INTERVAL_MS)`.
- **Constants**:
  - `CAMERA_TIMEOUT_MS = 5_000` (5 s per driver call: command, stop, position/options ask, capabilities)
  - `HOLD_MS = 15_000` (15 s operator hold)
  - `DRIVE_TIMEOUT_MS = 1_500` (1.5 s before an unrepeated drive is stopped, or a failed stop is retried)
  - `WATCH_INTERVAL_MS = 1_000` (1 s watch rest while `drive` is `idle`)
  - `DRIVEN_INTERVAL_MS = 250` (250 ms watch rest while `drive` is `driving` or `stopping`)
  - `OPTIONS_EVERY = 5` (options are read on ask 0, 5, 10, … and on every post-command refresh)
  - SSE wrapper ([events.ts](../apps/agent/core/src/cameras/events.ts)): `HEARTBEAT_MS = 15_000` (15 s `ping`), `LIFETIME_MS = 10 * 60_000` (10 min max stream length)
- **I/O and abort signals**: `reads` aborts in-flight watch asks and capability reads when `release()` runs; `ends` aborts commands and halts too on `dispose()`. `CameraControl` derives `status$` (`{ cameras, held }`) on every store change and replays `toldOf` to new `watch()` subscribers.

#### Invariants

- Any `drive` that is sent (even one that times out or fails) arms a stop deadline; only a later `move*` or `stop` that succeeds (`seq > drive.since`), a successful `halt`, or `released`/`disposed` clears it.
- An operator command always overrides any current holder; an automation command neither takes nor renews a hold and is refused while another peer holds an unexpired hold.
- Before sending a command, `CameraControl.run` checks camera existence, grant camera/command match, capabilities, then synchronously checks `life`, `heldAgainst`, spends a single-command grant if applicable, and dispatches `commanded` with no `await` in between.
- Once `life` leaves `controlled`, `hold`, `drive` and `watch` are all cleared immediately, so `alarmsOf` returns `{}` even while `releasing` waits on its final stop (which is bounded by `CAMERA_TIMEOUT_MS` via `within`).

---

### Grant ledger (`ledgerStore`)

File: [apps/agent/core/src/cameras/camera-machine.ts](../apps/agent/core/src/cameras/camera-machine.ts) (used by [apps/agent/core/src/cameras/control.ts](../apps/agent/core/src/cameras/control.ts)).

One store shared across all cameras on an agent, so re-registering a camera does not let a spent single-command grant be replayed.

```
unseen ── spent(id, expiresAt, at) ──▶ used(until: expiresAt) ── expiresAt <= at (pruned on next spent, or cleared) ──▶ forgotten
```

| Event     | Effect on state                                                         |
| --------- | ----------------------------------------------------------------------- |
| `spent`   | Prunes entries where `until <= at`, then stores `used[id] = expiresAt`. |
| `cleared` | Empties `used` (`{}`), called by `CameraControl.teardown`.              |

- **Timers and I/O**: none. Expired grants are already rejected by `verifyGrant` ([apps/agent/core/src/cameras/grants.ts](../apps/agent/core/src/cameras/grants.ts)), so lazy pruning on `spent` is sufficient.
- **Invariant**: `spentAlready(ledger, id, at)` returns `true` whenever `used[id] > at`, so a `scope.kind === 'command'` grant can be admitted at most once before it expires.

---

### Twitch chat connection (`twitchStore`)

File: [apps/agent/core/src/output/chat/twitch.ts](../apps/agent/core/src/output/chat/twitch.ts) (`twitchStore` and `TwitchChat` shell).

Maintains one anonymous IRC-over-WebSocket connection (`justinfan<digits>`) to `TWITCH_CHAT_URL` (`wss://irc-ws.chat.twitch.tv:443`) with `twitch.tv/tags` and `twitch.tv/commands` capabilities.

```
         listened                dialled                        opened
  idle ───────────▶ dialling(seq) ───────▶ connecting(seq, sock) ───────▶ open(seq, sock, joined, partial)
                       ▲    ▲   │                  │                           │    │
                       │    │   │ dropped          │ dropped / failed          │    │ RECONNECT line:
                       │    │   │ (couldn't dial)  │                           │    │ close sock, dial(0)
                       │    │   ▼                  ▼        dropped / failed   │    │
                       │    │ waiting(retries, until) ◀────────────────────────┘    │
                       │    │   │                                                   │
                       │    └───┘ retryDue (retries + 1)                            │
                       └────────────────────────────────────────────────────────────┘

  stopped (from any except closed) ──▶ idle (closes live socket, clears wanted)
  closed  (from any)               ──▶ closed (closes live socket, clears wanted, terminal)
```

#### Events

All events carry `at`. Emits `heard` (`{ message, at }`) for each parsed `PRIVMSG` with `id` and `user-id` tags.

| Event      | Effect on state                                                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listened` | Ignored if `closed`. Normalises `channels` to lower-case deduplicated `wanted`. From `idle`, dials (`retries: 0`). While `open`, diffs `wanted` against `joined`, sends `PART`/`JOIN` lines and sets `joined = wanted`. While `dialling`, `connecting` or `waiting`, updates `wanted` only (never cuts a backoff wait short).       |
| `stopped`  | Ignored if `closed`. Closes any live socket (`connecting`/`open`), clears `wanted`, enters `idle`.                                                                                                                                                                                                                                  |
| `closed`   | Closes any live socket, clears `wanted`, enters terminal `closed`.                                                                                                                                                                                                                                                                  |
| `dialled`  | If `dialling` with matching `seq`, enters `connecting(seq, retries, socket)`. Otherwise closes the late socket immediately.                                                                                                                                                                                                         |
| `opened`   | If `connecting` with matching `seq`, sends `CAP REQ :twitch.tv/tags twitch.tv/commands`, `NICK justinfan<10000..89999>`, and `JOIN` for `wanted`; enters `open`.                                                                                                                                                                    |
| `received` | If `open` with matching `seq`, prepends `partial`, splits on `\r\n`, keeps trailing fragment (dropped if `> MAX_PARTIAL_LENGTH`). Answers `PING` with `PONG`; on `:<prefix> RECONNECT` sends queued pongs, closes socket and dials immediately (`retries: 0`); otherwise parses `PRIVMSG` via `parseChatMessage` and emits `heard`. |
| `dropped`  | If `seq` matches the current `dialling`/`connecting`/`open` socket, enters `waiting(retries, at + backoffOf(retries))` (`retries` resets to `0` if it was `open`).                                                                                                                                                                  |
| `failed`   | If `seq` matches the current socket, logs a warning, closes the live socket and enters `waiting` as in `dropped`.                                                                                                                                                                                                                   |
| `retryDue` | If `waiting` and `until <= at`, dials with `retries + 1`.                                                                                                                                                                                                                                                                           |

#### Timers, constants and I/O

- **Alarms (`alarmsOf`)**: single alarm `'retry'` at `connection.until` while `waiting` → rings `retryDue`.
- **Constants**: `TWITCH_CHAT_URL = 'wss://irc-ws.chat.twitch.tv:443'`, `RECONNECT_MIN_MS = 1_000` (1 s), `RECONNECT_MAX_MS = 60_000` (60 s), `MAX_PARTIAL_LENGTH = 16_384`.
- **Backoff**: `backoffOf(retries) = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** retries)`.
- **I/O**: `connect(url)` creates the `ChatSocket` in an effect and binds `open`, `message`, `close` and `error` listeners back to `opened`, `received`, `dropped` and `failed`.

#### Invariants

- At most one socket is ever live; any socket that arrives from a stale `dialled` or encounters `failed`/`stopped`/`closed`/`RECONNECT` is closed immediately.
- Whenever `connection.status === 'open'`, `connection.joined` matches `context.wanted`.
- `closed` is terminal: no further dials, joins or timers occur.

---

### Chat command uses (`usesStore`)

Files: [apps/agent/core/src/output/chat/uses.ts](../apps/agent/core/src/output/chat/uses.ts) (store), [apps/agent/core/src/output/chat/runtime.ts](../apps/agent/core/src/output/chat/runtime.ts) (`ChatRuntime` shell), [apps/agent/core/src/cameras/courier.ts](../apps/agent/core/src/cameras/courier.ts) (`CameraCourier`).

Tracks whether the runtime is listening (`life`) and what each command ID is doing (`commands[commandId]`). A command that is ready and past its quiet period is omitted from `commands`.

```
life          stopped ── applied ──▶ listening(spec) ── stopped ──▶ stopped      disposed (from any) ──▶ disposed
                                          │  ▲
                                          └──┘ applied (new spec)

per command   (absent / ready with quiet over) ── heard ───────────────────────────────────────────┐
                                                                                                   ▼
              ready(quietUntil) ── heard (quiet active) ──▶ spaced(until, use) ── gapEnded ──▶ telling ── answered(planned) ──▶ carrying
                ▲                                              ▲    │  ▲                        │  ▲                              │
                │                                              │    └──┘ heard (replaces use)   │  │                              │ carried
                │                                              │                                │  │                              ▼
                │                                              │             answered(ran /     │  │ waiting use,              settling
                │                                              │             notRun) /          │  │ quiet over                   │
                │                                              │             unanswered         ▼  │                              │ settled /
                │                                              └── waiting use, quiet active ─ [through] ◀────────────────────────┘ unsettled
                │                                                                                │   │
                ├──────────────────────────── nothing waited (or stopped) ───────────────────────┘   │ restsUntil > at
                │                                                                                    ▼
                └─────────────────────────────── restEnded (or heard past until) ──────────── resting(until, quietUntil)
```

`[through]` is a pure decision helper, not a state: if `disposed` it forgets the command; if `stopped` it drops any waiting use and keeps only `ready(quietUntil)`; else if `restsUntil > at` it enters `resting`; else if a `waiting` use is still in the current spec it admits it (`telling` or `spaced`); else it keeps `ready(quietUntil)` (or omits it if quiet is over).

#### Events

All events carry `at`. Emits nothing.

| Event        | Effect on state                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applied`    | Ignored if `disposed`. Sets `life = listening(spec)`. Keeps in-flight tells, rests and quiets (even for removed commands in case they return), dropping only `waiting`/`spaced` uses whose command or channel left the spec.                                                                                                                            |
| `stopped`    | When `listening`, sets `life = stopped`. Keeps in-flight tells (with `waiting: null`) so planned uses finish carrying and settling; drops `spaced` uses and `resting` states (keeping only `ready(quietUntil)` if still active, which needs no timer).                                                                                                  |
| `disposed`   | Sets `life = disposed` and clears `commands` to `{}`. (`ChatRuntime.dispose` then aborts `ends`.)                                                                                                                                                                                                                                                       |
| `heard`      | When `listening`, parses `!word` via `useOf` (matching command name, channel login and `inAudience`, capping to `MAX_WORDS` of `MAX_WORD_LENGTH`). If absent/ready: tells now or enters `spaced`. If `spaced`: replaces `use`. If `telling`/`carrying`/`settling`: replaces `waiting`. If `resting`: drops while `until > at`, else admits immediately. |
| `gapEnded`   | When `spaced` and `until <= at`: tells `use` if its command and channel are still in the spec, else deletes the entry.                                                                                                                                                                                                                                  |
| `restEnded`  | When `resting` and `until <= at`: replaces with `ready(quietUntil)` if `quietUntil > at`, else deletes the entry.                                                                                                                                                                                                                                       |
| `answered`   | Matching `telling` and `seq`: if `answer.status !== 'planned'`, logs debug and runs `through(restsUntil)`. If `'planned'`, enters `carrying` and enqueues `carryAll` (sequential `courier.carry`, stopping at the first non-`'carried'` result).                                                                                                        |
| `unanswered` | Matching `telling` and `seq`: logs error and runs `through(null)` (spaced by `MIN_GAP_MS` alone).                                                                                                                                                                                                                                                       |
| `carried`    | Matching `carrying` and `seq`: logs warning if `result !== 'carried'`, enters `settling` and enqueues `studio.settle`.                                                                                                                                                                                                                                  |
| `settled`    | Matching `settling` and `seq`: runs `through(epochOf(answer.restsUntil))`.                                                                                                                                                                                                                                                                              |
| `unsettled`  | Matching `settling` and `seq`: logs error and runs `through(current.restsUntil)` (falls back to the plan's rest since the turn was not confirmed given back).                                                                                                                                                                                           |

#### Timers, constants and I/O

- **Alarms (`alarmsOf`)**: `gap:<commandId>` at `use.until` while `spaced` → `gapEnded`; `rest:<commandId>` at `use.until` while `resting` → `restEnded`.
- **Constants**:
  - `MIN_GAP_MS = 1_500` (1.5 s minimum gap between tells of the same command, measured from `tell.sentAt`)
  - `TELL_TIMEOUT_MS = 15_000` (15 s for `studio.trigger`)
  - `CARRY_TIMEOUT_MS = 30_000` (30 s for all `cameraCommands` of a planned use)
  - `SETTLE_TIMEOUT_MS = 10_000` (10 s for `studio.settle`)
  - `MAX_WORDS = 8`, `MAX_WORD_LENGTH = 60`
- **Shell (`ChatRuntime`)**: wires `twitch.store.on('heard')` → `uses.trigger.heard`, syncs `Alarms`, and derives `status$` (`{ connected, channels, commands, triggered, lastTriggeredAt }`) from both stores.

#### Invariants

- At most one tell (`telling`, `carrying` or `settling`) is in flight per command ID, and consecutive tells for a command are never closer than `MIN_GAP_MS`.
- While a tell is in flight or spaced, at most one newer use waits — each newer use replaces the previous one, so a burst costs one tell plus the burst's final use.
- `stopped` (teardown) leaves no alarms armed while still seeing already-planned camera commands through to `settle`.

---

## Browser machines

### Control session (`createCameraStore`)

Files: [apps/studio/web/src/components/cameras/control/store/camera-store.ts](../apps/studio/web/src/components/cameras/control/store/camera-store.ts) (store), [camera-stream.ts](../apps/studio/web/src/components/cameras/control/following/camera-stream.ts) (SSE reader), [camera-control.tsx](../apps/studio/web/src/components/cameras/control/camera-control.tsx) (session provider), [camera-live.tsx](../apps/studio/web/src/components/cameras/control/following/camera-live.tsx) (`started`/`stopped` lifecycle).

One store per `<CameraSession>`. Holds `self` (this browser device's public ID), `session` (the current grant, updated via `renewed`), `reported` (last `State` from the agent, kept across reconnects), counters `streams` and `commands`, and three sub-machines: `link`, `lock` and `claims`.

```
link     idle ── started ──▶ connecting(stream) ─┐
                                                 │ reported / pinged
                                                 ▼
         ┌── reported / pinged ──────────────▶ live(stream) ◀──── reported / pinged ─────────┐
         │                                       │                                           │
         │                                       ├── ended  ──▶ reconnecting·waiting ── waited (1 s) ──▶ reconnecting·asking(stream)
         │                                       ├── failed ──▶ lost·waiting ────────── waited (5 s) ──▶ lost·asking(stream)
         │                                       └── silent (45 s) ──▶ stale(stream) (opens new stream at once)
         │                                                                                   │
         └── connecting, live, stale, ·asking all share ended / failed / silent / heard ─────┘

         renewed (different agent, stream open) ──▶ connecting(new stream)     stopped (from any) ──▶ idle

lock     free ── reported(holder = other) ──▶ locked(peer) ── tookOver(peer) ──▶ overridden(peer)
          ▲  ▲                                   │    ▲                             │    │
          │  └── reported(holder = null | self) ─┘    └── reported(holder = third) ─┘    │
          └──────────────────────────── reported(holder = null) ─────────────────────────┘

claim    commanded (not locked, link != idle, configure or moveTo.zoom)
           ──▶ sending(id) ── taken (not yet agreed) ──▶ awaiting(id) ── reported (agrees) / settled (8 s) ──▶ gone
                 │   └── taken (already agrees) ─────────────────────────────────────────────────────────────▶ gone
                 └── refused ────────────────────────────────────────────────────────────────────────────────▶ gone

         From sending or awaiting: newer claim on same subject, drive/stop (for zoom), or stopped ──▶ gone
```

#### Events

| Event       | Effect on state                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `started`   | From `idle`, opens the first stream (`connecting`) and arms `silence`.                                                                                                                                                                                                                                                     |
| `stopped`   | When not `idle`, calls `tasks.stopAll()`, sets `link` to `idle` and drops all `claims` (keeping `reported` and `lock`).                                                                                                                                                                                                    |
| `renewed`   | Replaces `session`. If the serving agent's `publicId` changed and a stream is currently open, opens a new stream (`connecting`) against the new agent.                                                                                                                                                                     |
| `reported`  | For the open stream: marks `link` `live`, re-arms `silence`, drops any `awaiting` claims the report agrees with, updates `reported`, and advances `lock` via `lockAfter`.                                                                                                                                                  |
| `pinged`    | For the open stream: marks `link` `live` and re-arms `silence`.                                                                                                                                                                                                                                                            |
| `ended`     | For the open stream: disarms `stream` and `silence`, enters `reconnecting·waiting`, arms `pause` for `RECONNECT_MS`.                                                                                                                                                                                                       |
| `failed`    | For the open stream: disarms `stream` and `silence`, enters `lost·waiting` with `failure`, arms `pause` for `RETRY_MS`.                                                                                                                                                                                                    |
| `silent`    | For the open stream: aborts it and immediately opens a replacement stream in `stale`.                                                                                                                                                                                                                                      |
| `waited`    | From `reconnecting·waiting` or `lost·waiting`, opens a new stream in the corresponding `asking` phase.                                                                                                                                                                                                                     |
| `tookOver`  | From `locked(peer)` matching `event.peer`, transitions `lock` to `overridden(peer)`.                                                                                                                                                                                                                                       |
| `commanded` | If `lock === 'locked'`, rejects `reply` with `CameraLocked` and changes nothing. Otherwise drops any `zoom` claim on `drive`/`stop`, creates a `sending` claim for `configure` or `moveTo` with `zoom` (replacing any claim on the same subject, skipped if `link === 'idle'`), and delivers the command via `agent.send`. |
| `taken`     | For a matching `sending` claim: drops it if `reported` already agrees, else moves it to `awaiting` and arms `settle:<id>` for `SETTLE_MS`.                                                                                                                                                                                 |
| `refused`   | Drops the matching claim.                                                                                                                                                                                                                                                                                                  |
| `settled`   | Drops the matching claim after `SETTLE_MS` without agreement, falling back to `reported`.                                                                                                                                                                                                                                  |

#### Timers, constants and I/O

- **Named tasks (`namedTasks`)**: `stream` (SSE `AbortController` via `cameraListenerOf`), `silence` (`SILENCE_MS`), `pause` (`RECONNECT_MS` or `RETRY_MS`), and `settle:<id>` (`SETTLE_MS` per awaiting claim).
- **Constants**:
  - `RECONNECT_MS = 1_000` (1 s after a clean stream end, e.g. the agent's 10 min cap)
  - `RETRY_MS = 5_000` (5 s after a stream error)
  - `SILENCE_MS = 45_000` (45 s = three 15 s heartbeats)
  - `SETTLE_MS = 8_000` (8 s optimistic hold for an accepted claim)
  - `ZOOM_NEAR = 0.02` (zoom agreement tolerance)
- **Selectors**: `optionOf` and `zoomOf` overlay active claims onto `reported`; `lockedBy` returns `lock.peer` only while `lock.status === 'locked'`.

#### Invariants

- Events from any stream other than `openStreamOf(link)` are ignored, and `aborted` streams emit neither `failed` nor `ended`.
- At most one claim exists per subject (`'zoom'` or `'option:<key>'`), and `stopped` leaves no active tasks or claims.
- `lock` is cooperative browser manners (the agent itself allows any operator to take over): while `locked`, `commanded` never reaches the network; once `overridden`, it stays overridden while either `self` or the overridden peer holds the camera, re-locks if a third device takes hold, and returns to `free` when nobody holds.

---

### Hand driving (`createDriveStore`)

Files: [apps/studio/web/src/components/cameras/control/drive/camera-drive-context.ts](../apps/studio/web/src/components/cameras/control/drive/camera-drive-context.ts) (store and hooks), [camera-drive.tsx](../apps/studio/web/src/components/cameras/control/drive/camera-drive.tsx) (lifecycle and sight adapter), [camera-steering.ts](../apps/studio/web/src/components/cameras/control/drive/camera-steering.ts) (pure steering maths and `driveStep`).

One store per control session, beneath `<CameraSession>`. Holds six input slots (`inputs`), `gamepadEnabled`, `sends`, `failure` and two sub-machines: `run` (wrapping `DriveLoop`) and `zoom`.

```
run      off ── started (drivable) ──▶ on·resting ◀─────────────────────────────┐
          ▲                              │    ▲                                 │
          │            ticked: drive     │    │ ticked: no drive (sends `stop`) │
          │            (sends drive)     ▼    │                                 │
          │                            on·driving ── ticked: sight.locked ──────┘ (sends nothing)
          │                              │   ▲
          │                              └───┘ ticked: changed drive, or REPEAT_MS elapsed (sends drive)
          │
          └── stopped, or started (not drivable): cancels tasks; sends `stop` if driving and not locked

zoom     idle(sentAt) ── zoomDragged ──▶ dragging(to, sentAt) ── zoomReleased / rested (sends moveTo) ──▶ idle(now)
              ▲          (sends if >=        │   ▲    │
              │          ZOOM_SEND_MS)       └───┘    │
              │                          zoomDragged  │
              └─────────────────── zoomDropped ───────┘ (sends nothing, keeps sentAt)
```

#### Events

| Event             | Effect on state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `started`         | If `capabilities` does not include `'continuous'`, halts `run` (same as `stopped`). If already `on`, updates `capabilities` in place. Otherwise enters `on·resting`, arms `tick` (`TICK_MS`) and attaches the window `blur` listener.                                                                                                                                                                                                                                                                           |
| `stopped`         | If `on`, cancels `tick` and `blur` via `tasks.stopAll()`, sends `{ kind: 'stop' }` if `loop === 'driving'` and `!options.camera().locked`, and sets `run = off`.                                                                                                                                                                                                                                                                                                                                                |
| `ticked`          | When `on`: re-arms `tick`, reads `sight.gamepad` into `inputs.gamepad` (only if `gamepadEnabled && sight.focused`, else `STILL`), and runs `stepAt`: if `sight.locked`, returns `resting` sending nothing; else picks the highest-priority moving input via `steeringOf`, scales pan/tilt by `slowdownAt(sight.zoom)`, builds a `drive` via `driveOf`, and runs `driveStep` (sends a changed velocity at once, repeats an unchanged one after `REPEAT_MS`, or sends `stop` once when steering returns to zero). |
| `steered`         | Updates `inputs[source]` when it differs from the previous value.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `rested`          | Fired on window blur: releases any active zoom drag (sending its position) and resets all `inputs` to `STILL` (the next tick stops the camera).                                                                                                                                                                                                                                                                                                                                                                 |
| `gamepadSwitched` | Toggles `gamepadEnabled`; turning it off resets `inputs.gamepad` to `STILL` at once.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `zoomDragged`     | Moves `zoom` to `dragging(to: event.zoom)`; sends `{ kind: 'moveTo', zoom }` immediately unless `now() - sentAt < ZOOM_SEND_MS`.                                                                                                                                                                                                                                                                                                                                                                                |
| `zoomReleased`    | From `dragging`, sends `{ kind: 'moveTo', zoom: to }` unconditionally (ignoring the throttle) and moves to `idle(sentAt: now())`.                                                                                                                                                                                                                                                                                                                                                                               |
| `zoomDropped`     | From `dragging` (slider unmounted mid-drag), moves to `idle` without sending.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `took`            | If `event.send === state.sends`, clears `failure`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `missed`          | If `event.send === state.sends`, records `failure`.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

#### Timers, constants and I/O

- **Named tasks (`namedTasks`)**: `tick` (`TICK_MS` timer calling `look()` and triggering `ticked`) and `blur` (`window` blur listener triggering `rested`, active while `run === 'on'`).
- **Constants**:
  - `TICK_MS = 100` (100 ms loop period)
  - `REPEAT_MS = 500` (500 ms keepalive resend — well inside the agent's 1,500 ms `DRIVE_TIMEOUT_MS`)
  - `ZOOM_SEND_MS = 150` (150 ms zoom-slider drag throttle)
  - `STEERING_SOURCES = ['surface', 'pad', 'lever', 'hold', 'keys', 'gamepad']` (strict priority order; never summed)
  - `NUDGE_SPEED = 0.35`, `KEY_SPEED_FAST = 1`, `STICK_DEADZONE = 0.15`, `ZOOM_SLOWDOWN = 0.8` (at full zoom, pan/tilt speed is 20%)
- **Hooks**: `useSteer(source)` automatically resets its source to `STILL` on unmount; `useZoomDrag()` fires `zoomDropped` on unmount.

#### Invariants

- Inputs are never summed: the most deliberate moving source in `STEERING_SOURCES` wins.
- While another device locks the camera (`sight.locked`), the loop sends nothing — not even `stop` — so it cannot steal the hold.
- Unmounting a steering control or losing window focus cannot leave a camera turning indefinitely; even if the browser disappears altogether, the agent's `DRIVE_TIMEOUT_MS` stops it.
- Only the response to the latest `send` updates `failure`.

---

### Gamepad shoulders (`createShoulderStore`)

File: [apps/studio/web/src/components/cameras/control/drive/camera-shoulders.ts](../apps/studio/web/src/components/cameras/control/drive/camera-shoulders.ts) (reads `gamepadShoulder` from [camera-steering.ts](../apps/studio/web/src/components/cameras/control/drive/camera-steering.ts)).

Lives above any camera control session so `held` persists across the camera swap that a shoulder press triggers.

```
idle ── started ──▶ polling(held: 0) ── polled (focused, L1 or R1; emits stepped) ──▶ polling(held: ±1)
                        ▲                                                                  │   │  ▲
                        └── polled (neither, both, or !focused) ───────────────────────────┘   └──┘
                                                         polled (focused, opposite shoulder; emits stepped)

From polling: stopped ──▶ idle (cancels poll task)
```

| Event     | Effect on state                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `started` | From `idle`, enters `polling(held: 0)` and arms `poll`.                                                                                                                                     |
| `stopped` | From `polling`, cancels all tasks and returns to `idle`.                                                                                                                                    |
| `polled`  | When `polling`: re-arms `poll`, computes `held = event.focused ? event.shoulder : 0` (`-1` L1, `1` R1, `0` neither/both). If `held` changed and is non-zero, emits `stepped({ by: held })`. |

- **Constants and I/O**: `SHOULDER_POLL_MS = 50` (50 ms) under named task `'poll'`. Reads `gamepadShoulder()` (`buttons[5]` minus `buttons[4]`) and `document.hasFocus()`.
- **Invariant**: holding a shoulder button across a camera change emits `stepped` once per press, and never fires when the document lacks focus.

---

## Studio API decision (`decideUse` and chat command routes)

Files: [apps/studio/api/src/chat/decide.ts](../apps/studio/api/src/chat/decide.ts), [resolve.ts](../apps/studio/api/src/chat/resolve.ts), [shows.ts](../apps/studio/api/src/chat/shows.ts), [receipts.ts](../apps/studio/api/src/chat/receipts.ts), [routes/chat-commands.ts](../apps/studio/api/src/routes/chat-commands.ts), [services/chat-commands.ts](../apps/studio/api/src/services/chat-commands.ts), [cameras/grants.ts](../apps/studio/api/src/cameras/grants.ts), [packages/chat/src/uses.ts](../packages/chat/src/uses.ts), [packages/chat/src/audiences.ts](../packages/chat/src/audiences.ts).

The Cloudflare Worker keeps no in-memory state between requests. Instead, `decideUse(facts)` is a pure function over facts read inside `trustedTransaction`, paired with two single-statement conditional `UPDATE`s (`claimChatCommand` and `giveBackChatCommand`) and a stateless signed receipt.

```
UseFacts ──▶ command missing/disabled? ── yes ──▶ notRun('disabled', reply: null)
               │ no
               ▼
             inAudience? ──────────────── no  ──▶ notRun('audience', reply: null)
               │ yes
               ▼
             action.kind === 'reply'? ─── yes ──▶ [check rest] ──▶ Reply(text)
               │
             showSwap / showTakeover? ─── yes ──▶ output follows a show? ── no ──▶ notRun('unavailable', reply)
               │ cameraPreset                      │ yes
               │                                   ▼
               │                                 planShowSwap / planShowTakeover ── fail ─▶ notRun('unresolved', reply)
               │                                   │ ok (ranks to swap, or takeover to set)
               │                                   ▼
               │                                 [check rest] ──▶ ShowCommand(show, change, text)
               ▼
             resolveCameraPreset ──────── fail ─▶ notRun('unresolved', reply)
               │ ok (enabled camera + preset)
               ▼
             servingAgents has camera? ── no  ──▶ notRun('unavailable', reply)
               │ yes
               ▼
             restsUntil > now? ────────── yes ──▶ notRun('resting', reply: null)
               │ no
               ▼
             Move(camera, preset, agent, { kind: 'moveTo', ...position })
```

#### Key operations and constants

- **Audience order** (`CHAT_AUDIENCES`): `'everyone' < 'subscriber' < 'vip' < 'moderator' < 'broadcaster'`. Shared in `@conservationtv/chat` with the agent so both agree.
- **Word resolution (`resolveCameraPreset`)**: matches camera name or aliases (normalised by `chatName`) and requires `camera.state === 'enabled'`, then matches the preset name. Ambiguous, missing or switched-off cameras produce `unresolved` with a human-readable `reply`.
- **Show words (`planShowSwap`, `planShowTakeover`)**: a word of digits is a lineup position (from 1); any other word a name, matched by the same `calledIn` / `onlyOne` as cameras against a stream's `code`, `name`, and its source camera's name and aliases, the lineup's streams first. `showSwap` needs two lineup streams, `showTakeover` one stream whose camera is not locked or disabled, or `off` while one is armed. Decided against the show's facts read with its row held (`FOR UPDATE`), the lineup normalised in memory.
- **Show change**: after `claimChatCommand`, in the same transaction, the normalised ranks then the swapped ranks are written (`normaliseLineup`, `writeRanks`), or the takeover (`updateShowControls`: armed and live, or disarmed and not live). The outcome is `ran` with the reply; the show's object is poked (`pokeShow`) once the transaction commits.
- **Atomic turn claim (`claimChatCommand`)**: `UPDATE chat_command SET triggered_at = now WHERE id = $1 AND (triggered_at IS NULL OR triggered_at <= now - make_interval(secs => cooldown_seconds)) RETURNING old.triggered_at AS previous, cooldown_seconds`. Two concurrent triggers cannot both win; the loser falls back to `notRun('resting')`.
- **Turn give-back (`giveBackChatCommand`)**: `UPDATE chat_command SET triggered_at = previous WHERE id = $1 AND triggered_at = claimedAt`. Restores `triggered_at` only if no newer use has taken the command since.
- **Grants** ([cameras/grants.ts](../apps/studio/api/src/cameras/grants.ts), [packages/cameras/src/grants.ts](../packages/cameras/src/grants.ts)): EdDSA JWT signed with the serving agent's own Ed25519 private key (`CAMERA_GRANT_ALGORITHM = 'EdDSA'`, header `Camera-Grant`, claim `camera_grant`). `CONTROL_LIFETIME_SECONDS = 300` (5 min, `scope: { kind: 'control' }`, `priority: 'operator'`); `COMMAND_LIFETIME_SECONDS = 30` (30 s, `scope: { kind: 'command', command }`, `priority: 'automation'`).
- **Receipts** ([chat/receipts.ts](../apps/studio/api/src/chat/receipts.ts)): HS256 JWT (`typ: 'chat-command-receipt+jwt'`, claim `chat_command_use`) signed with an API-only subkey of `FIELD_KEY` (`RECEIPT_KEY_PURPOSE = 'chat-command-receipt'`), bound to `sub: device.id`, lasting `RECEIPT_LIFETIME_SECONDS = 60` (60 s). Carries `commandId`, `channelId`, `messageId`, `camera`, `preset`, `claimedAt` and `previous`. Not single-use: settling twice within the minute posts to chat twice, though `giveBackChatCommand` only restores the turn once.

#### Invariants

- Nothing before `claimChatCommand` writes to the database, so `disabled`, `audience`, `unresolved`, `unavailable` and `resting` spend nothing of the cooldown. A show command's show row lock is held from its read to the commit, so its change is written against what it was decided from.
- Because `rest` is checked _after_ `resolveCameraPreset` and `servingAgents` (or the show words), a typo or unavailable camera explains itself even while the command rests.
- Twitch chat calls (`say`) always happen outside database transactions and catch all errors so a Twitch failure never fails `trigger` or `settle`.

---

## Cross-process lifecycle of a chat command

One use of a chat command passes through four processes: Twitch chat, the listening agent (the output's agent), the studio API, and the serving agent (the active agent on the camera's network, which may be the listening agent itself).

```
Twitch chat       Listening agent                  Studio API                       Serving agent
                  (twitchStore / usesStore /       (routes/chat-commands.ts /       (verifyGrant / CameraControl /
                   CameraCourier)                   decide.ts / services)            ledgerStore / cameraStore)
    │                     │                                │                                │
    │── PRIVMSG (!cmd) ──▶│ twitchStore: received          │                                │
    │                     │   emits heard                  │                                │
    │                     │ usesStore: heard               │                                │
    │                     │   useOf: !word, channel,       │                                │
    │                     │   inAudience; drop if resting; │                                │
    │                     │   queue if in flight; space    │                                │
    │                     │   by MIN_GAP_MS (1.5 s)        │                                │
    │                     │                                │                                │
    │                     │── POST .../triggers ──────────▶│ requireDevice (RFC 9421)       │
    │                     │   (TELL_TIMEOUT_MS = 15 s)     │ requireOutputAgent             │
    │                     │                                │ decideUse (enabled, audience,  │
    │                     │                                │   resolve, servingAgent, rest) │
    │                     │                                │ [if runnable] claimChatCommand │
    │                     │                                │                                │
    │                     │        ┌── notRun ─────────────┤ (say reply if unresolved /     │
    │◀────────────────────┼────────┼── [Twitch reply] ─────┤  unavailable; no cooldown used)│
    │                     │        ├── ran ────────────────┤ (reply action, or a show       │
    │◀────────────────────┼────────┼── [Twitch reply] ─────┤  command changed and its show  │
    │                     │        │                       │  poked after commit: say       │
    │                     │        │                       │  reply, cooldown spent)        │
    │                     │        └── planned ────────────┤ (sign 30 s commandGrant +      │
    │                     │◀──── { cameraCommands,         │  60 s HS256 receipt;           │
    │                     │        receipt, restsUntil } ──┘  no chat reply yet)            │
    │                     │                                                                 │
    │                     │ usesStore: carrying (CARRY_TIMEOUT_MS = 30 s)                   │
    │                     │ CameraCourier.carry (local runHere, or over iroh):              │
    │                     │── POST /cameras/{id}/commands (Camera-Grant) ──────────────────▶│
    │                     │                                                                 │ verifyGrant (EdDSA, aud, sub, exp)
    │                     │                                                                 │ admits(grant, command) & capable?
    │                     │                                                                 │ life === 'controlled'?
    │                     │                                                                 │ heldAgainst (operator hold)?
    │                     │                                                                 │ ledgerStore: spend single-use jti
    │                     │                                                                 │ cameraStore: commanded (5 s timeout)
    │                     │◀── 204 / 409 camera_held / 401|403 / 404|422|502 ───────────────│
    │                     │ resultOf → carried | held | unreachable | refused | failed      │
    │                     │                                                                 │
    │                     │ usesStore: settling (SETTLE_TIMEOUT_MS = 10 s)                  │
    │                     │── POST .../settlements ───────▶│ verifyReceipt (HS256, sub, 60s)│
    │                     │   { receipt, result }          │ requireOutputAgent             │
    │                     │                                │ if result !== 'carried':       │
    │                     │                                │   giveBackChatCommand          │
    │                     │                                │ settledReply(result)           │
    │◀────────────────────┼────── [Twitch reply] ──────────┤ (outside transaction)          │
    │                     │◀── { restsUntil, replied } ────│                                │
    │                     │ usesStore: settled → through() │                                │
    │                     │ (rest, tell waiting, or ready) │                                │
```

### What each failure comes to

| Stage                         | Condition                                                                                                  | Outcome                                                           | Cooldown                        | Chat reply                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| Listening agent (`usesStore`) | Outside audience, unknown command/channel, or `resting`                                                    | Dropped locally; API not called                                   | Unchanged                       | None                                                                        |
| Listening agent (`usesStore`) | Burst while `spaced` or in flight                                                                          | Replaces waiting use; latest wins                                 | Unchanged                       | None for superseded uses                                                    |
| `trigger` auth                | Bad signature (401) or not output agent for channel (403)                                                  | `unanswered` on agent; spaced by `MIN_GAP_MS`                     | Unchanged                       | None                                                                        |
| `trigger` decision            | `notRun`: `disabled`, `audience`, `resting`                                                                | Agent rests until `restsUntil` (if any)                           | Not spent                       | None                                                                        |
| `trigger` decision            | `notRun`: `unresolved` (bad name, switched-off camera, bad preset) or `unavailable` (no active agent)      | Agent rests if `restsUntil` set, else `MIN_GAP_MS`                | Not spent                       | Explains why (e.g. `<camera> can't be moved right now.`)                    |
| `trigger` show command        | `notRun`: `unresolved` (bad position or name, not in the lineup) or `unavailable` (output follows no show) | As above                                                          | Not spent                       | Explains why, to moderators (e.g. `There is no show here to change.`)       |
| `trigger` show command        | `ran`: swapped, taken over, or takeover ended                                                              | Finished; the show is poked after commit                          | Spent                           | `Swapped <a> and <b>.`, `<stream> has taken over.`, `The takeover is over.` |
| `trigger` race                | `claimChatCommand` loses concurrent `UPDATE`                                                               | `notRun: resting` with winner's `restsUntil`                      | Not spent by loser              | None                                                                        |
| `trigger` deleted agent       | Serving agent deleted mid-transaction in `planMove`                                                        | Transaction rolls back (`camera_unavailable`), `unanswered`       | Rolled back                     | None                                                                        |
| `trigger` transport           | Timeout (`TELL_TIMEOUT_MS`) or network error                                                               | `unanswered`; spaced by `MIN_GAP_MS`                              | Unknown                         | None                                                                        |
| Carry (`CameraCourier`)       | `carried` (204 / local done)                                                                               | Settled as `carried`                                              | Kept                            | `Moving <camera> to <preset>.`                                              |
| Carry (`CameraCourier`)       | `held` (409 `camera_held` / local `CameraHeld`)                                                            | Settled as `held`                                                 | Given back                      | `Someone is controlling <camera> right now.`                                |
| Carry (`CameraCourier`)       | `unreachable` (iroh error or `CARRY_TIMEOUT_MS` abort)                                                     | Settled as `unreachable`                                          | Given back                      | `<camera> can't be moved right now.`                                        |
| Carry (`CameraCourier`)       | `refused` (401/403 / local `GrantRefused`)                                                                 | Settled as `refused`                                              | Given back                      | `<camera> can't be moved right now.`                                        |
| Carry (`CameraCourier`)       | `failed` (404, 422, 502, or local driver error)                                                            | Settled as `failed`                                               | Given back                      | `<camera> can't be moved right now.`                                        |
| `settle`                      | `SETTLE_TIMEOUT_MS`, network error or `400 invalid_receipt`                                                | `unsettled`; agent logs error and rests until plan's `restsUntil` | Not given back (receipt lapses) | None                                                                        |
| Twitch reply (`say`)          | Missing scope, non-Twitch channel or Twitch error                                                          | Logged; `replied: false` returned; request still succeeds         | Unaffected                      | None                                                                        |

---

## Camera control during hand driving

Driving a camera by hand couples the browser's drive and session stores to the serving agent's camera store and SSE watch stream in a closed loop:

```
  Browser                                                          Serving agent
  ─────────────────────────────────────────────────────────────    ─────────────────────────────────────────────
  Inputs (surface > pad > lever > hold > keys > gamepad)
    │ steered / zoomDragged
    ▼
  createDriveStore (camera-drive-context.ts)
    │ tick every TICK_MS (100 ms): reads cameraSightOf (locked, zoom)
    │   + gamepad + focus; driveStep sends changed velocity at once,
    │   repeats every REPEAT_MS (500 ms), or sends `stop` at rest
    │ zoom slider: moveTo(zoom) throttled to ZOOM_SEND_MS (150 ms),
    │   plus final send on release / blur
    ▼
  createCameraStore (camera-store.ts)
    │ commanded:
    │   - lock === 'locked' ──▶ rejects CameraLocked (nothing sent)
    │   - drive / stop ───────▶ drops any zoom claim
    │   - configure / moveTo.zoom ─▶ creates sending claim
    │   - sends via current 300 s operator grant over iroh ──────▶ POST /cameras/{id}/commands
    │                                                                │ verifyGrant (EdDSA, operator control grant)
    │                                                                │ CameraControl.run → cameraStore.commanded
    │                                                                │   - hold: held(browserPeer, at + HOLD_MS 15 s)
    │                                                                │   - drive: deadline = at + 5 s + 1.5 s,
    │                                                                │     then at + DRIVE_TIMEOUT_MS (1.5 s) on answer
    │                                                                │   - driver executes (CAMERA_TIMEOUT_MS = 5 s)
    │                                                                │   - if silent > 1.5 s: deadlinePassed → halt
    │                                                                ▼
    │                                                              cameraStore.watch
    │                                                                │ polls every DRIVEN_INTERVAL_MS (250 ms) while
    │                                                                │ driven, WATCH_INTERVAL_MS (1 s) when idle;
    │                                                                │ options every OPTIONS_EVERY (5) asks & after
    │                                                                │ non-drive commands; holder changes pushed at once
    │                                                                ▼
    │                                                              eventStream (SSE: state, 15 s ping, 10 min end)
    │◀────────── GET /cameras/{id}/events (camera-stream.ts) ────────┘
    │ reported / pinged:
    │   - link → live, resets SILENCE_MS (45 s)
    │   - lock updates via lockAfter (self keeps free / overridden)
    │   - awaiting claims that agree are dropped (else settle in 8 s)
    │   - reported.position.zoom & lockedBy feed next drive tick
```

Above `<CameraSession>`, `createShoulderStore` polls L1/R1 every `SHOULDER_POLL_MS` (50 ms) and emits `stepped({ by: ±1 })` on press edges; swapping cameras unmounts the old `<CameraSession>` (sending `stopped` to both the drive store — which sends `stop` if driving and unlocked — and the session store) and mounts a fresh one while preserving the shoulder button's `held` state.

---

## Changing a machine

- **Add an event, not a field.** If something new can happen, model it as a named event and a state (or union variant) rather than mutating a side-channel flag or checking refs outside the store.
- **Keep I/O in effects.** Put drivers, sockets, `fetch`, `AbortController`, window listeners and timers inside `enq.effect` or the thin shell (`Alarms` on the agent, `namedTasks` in the browser). Never read real wall-clock time or perform network calls directly inside a transition handler.
- **Guard stale completions.** Every async effect carries a monotonic sequence number (`seq`, `stream`, `sends`), and every timer event checks its deadline against `at`, so late callbacks from superseded work are safely ignored.
- **Keep diagrams and this page in step.** When you add or rename a state, event, timeout or invariant, update the file's header comment diagram and the matching section on this page in the same change.
- **Preserve injectability.** Keep time (`Time` / `CameraClock` + `now`) and external boundaries (`CameraDriver`, `Connect`, `ChatStudio`, `Courier`, `CameraAgent`, gamepad/focus/blur readers) injectable. Because of that separation, these machines were fuzzed with seeded random event sequences against fake clocks, drivers, sockets and studio clients to check their invariants across arbitrary interleavings.
