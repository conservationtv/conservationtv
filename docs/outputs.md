# Outputs and shows

OBS automation and monitoring don't depend on vignette. An **output** is one OBS on one agent, plus what goes out
from it. A **show** is what is on screen. A show drives an output's scenes only when the output follows it. Otherwise
something outside the studio drives them, and the studio still keeps OBS running, streaming, forwarded, previewed,
recorded and monitored.

```
 Show (optional)                          Output
┌───────────────────────┐   drives      ┌──────────────────────────────────────────────┐
│ composition, commands │──scenes──▶    │ agent + OBS: install, profile, launch        │
│ its own object, by ID │  (show_id,    │ program MediaMTX: forwards, previews, slate  │
│ places streams        │   nullable)   │ inputs: any stream OBS reads, on demand      │
└───────────────────────┘               │ encoding, recorder; program:/forward:/… reports │
                                        └──────────────────────────────────────────────┘
```

What each side promises the other:

- **The output** keeps OBS up and streaming whatever is on its programme into the program MediaMTX. That MediaMTX
  forwards the programme, previews it, falls back to the slate, and is reported on.
- **Whoever drives the output** owns only the scenes and inputs it makes.

## Who drives an output: `control`

| `control`  | Scenes driven by                                     | May read                          | OBS scene collection |
| ---------- | ---------------------------------------------------- | --------------------------------- | -------------------- |
| `show`     | the `show` key following `show_id` (none while null) | what that show places             | `vignette`           |
| `external` | something outside the studio, via obs-websocket      | any of the organisation's streams | `external`           |

- **External is an advanced mode.** It is an explicit choice, never what a missing show means. An output under `show`
  control that follows no show reads nothing, so leaving a show can never widen what an agent may read. A check
  constraint keeps `show_id` null under `external`, and setting `control` to `external` clears it.
- **The collections are separate.** Switching modes restarts OBS on the other collection, so neither mode's scenes
  are lost to the other's. The agent writes a collection only when it is missing or has no scenes.
- **The watchdog** (`output/obs/watchdog.ts`) always keeps OBS streaming and recording. It puts a scene back on
  programme only when the `show` key says which scene; under `external` it leaves scenes alone.

## Data

| Table             | Columns                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `show`            | `id`, `organisation_id`, `name`, `created_at`                                                                                |
| `output`          | `id`, `organisation_id`, `name`, `control`, `show_id` (nullable), encoding (`width` … `keyframe_seconds`), `created_at`      |
| `output_device`   | `output_id`, `device_id` (unique: an agent runs one OBS), `created_at`                                                       |
| `output_forward`  | as `show_forward` was, by `output_id`                                                                                        |
| `output_preview`  | as `show_preview` was, by `output_id`                                                                                        |
| `output_recorder` | as `show_recorder` was, by `output_id`                                                                                       |
| `output_control`  | `output_id`, `device_id`, `websocket_port`, `websocket_password` (encrypted), `scene_collection`, `input_url`, `reported_at` |

Notes on the tables:

- **Access.** Members read all of these except `output_control`, and administrators manage them. Only
  administrators read `output_control`, and only trusted code writes it, for the agent the output runs on.
- **Deleting a show** leaves its outputs following nothing. The service clears `show_id` first, because the composite
  foreign key can't set only one of its columns to null.

### Migration

Every existing `show` row becomes an output **with the same ID**, and its forwards, previews and recorders keep their
IDs too. So `program:<id>` and every other report subject carries on.

Each organisation's broadcast becomes the one show it keeps, with the organisation's ID, which is the name its object
already has. Every output follows that show. Any other show only existed as a way out, so it is an output now and the
show row is removed.

A broadcast composed before the migration sends frame pages to the old org-level stream URL until it is composed
again.

## API

- `organisations.shows.list|create|get|update|delete`, each with the outputs following it, and
  `organisations.shows.follow` (WebSocket), per show. How a show is operated, and `compose`'s removal, are in
  [shows.md](shows.md).
- `organisations.outputs.list|create|get|update|delete`: `control`, `showId` and the encoding.
  - `getDevice|setDevice|deleteDevice`: the agent the output runs on.
  - `forwards.*`, `previews.*` (with `previews.connect`), and `createRecorder|updateRecorder|deleteRecorder`.
- `organisations.outputs.control.report`, signed by the output's agent: the obs-websocket port and password, the scene
  collection, and the input URL template.
- `organisations.outputs.control.get`, administrators only: what the agent last reported. An external controller
  reads it with the API or CLI, and finds the host in `organisations.devices.listAddresses`.
- `organisations.topology.get`: `shows` (each with `placed`: every exposure of each stream it places, as the versions
  released before shows named streams say it: [shows.md](shows.md)) and `outputs`.

`deviceConfiguration.get` has two output sections:

- `obs`: `output: { id, organisationId, control }`, `encoding`, `forwards`, `previews`, `recording`, `program`.
- `show`: `{ id, url }`. It is present only while the output follows a show under `show` control.

## Agent

- `obs` (`output/obs/`) runs OBS, the program MediaMTX, forwards, previews, recording, the input relays and reports.
  It reports how to drive OBS whenever that changes.
- `show` (`output/show/`) runs vignette's OBS target following the show, and tells `obs` which scene the show is on.
  Without the `show` key, nothing in the agent touches scenes.
- `channels` is unchanged.

### Inputs: shared plumbing

Both kinds of control play streams the same way. OBS reads `rtmp://127.0.0.1:<port>/inputs/<streamId>` from the
program MediaMTX, whatever delivers the stream: vignette's `ctv-stream` source points a media source there, and an
external controller does the same (`inputUrl` in `organisations.outputs.control.get`). The agent relays each stream
only while something reads it (`output/obs/inputs.ts`), asking the studio API which delivery to read
(`organisations.streams.connect`), naming every protocol it can play: MoQ first, then RTSPS, RTMPS, RTSP and RTMP.

1. The first read hits a regex path whose `runOnDemand` runs a small Node launcher. While it runs, the launcher holds a
   request open to the agent's loopback demand server, naming the path.
2. The agent asks for a read as its device and starts the stream's relay (`output/obs/relay.ts`), which publishes
   into the same path, so the waiting reader plays it as soon as it arrives, within the path's 30 s start timeout:
   - MoQ (conservation.tv): `moq … export rtmp`, pushing the broadcast into the path.
   - RTSP(S) or RTMP(S) (a MediaMTX gateway, on the agent's network or the internet): a small MediaMTX of the relay's
     own (`output/obs/pull.ts`), the agent's pinned binary with every server off, whose one path pulls the gateway's
     URL and forwards what it gets to the input path. The URL and its token are given in its environment, never in a
     file or a log.

   No input path gets a config of its own, so relays coming and going never rewrite the program MediaMTX's config.
   The tracks pass through as they are sent, audio included, except where RTMP cannot carry them (below).

3. There is no offline segment: while a relay is down, OBS has nothing from that input. OBS's media source reconnects
   after its reconnect delay. vignette's `ctv-stream` sets 1 s; OBS's default is 10 s, so an external controller should
   set its media sources' reconnect delay to 1 s.
4. Each read is renewed 10 minutes before it expires (an hour after it was given):
   - A pull carries on: a gateway checks a token only as a reader connects, so the running pull reads past its token's
     expiry, and is given the new token for the next time it starts. Renewing a pull restarts nothing. Only a pull
     that has dropped, with its token expired, is started again with the latest, as soon as its input is found dark.
   - MoQ restarts: the relay ends a session as its token expires, so `moq` is started again with the new one, which
     is a gap on air of about the reconnect delay. Restarts are kept at least 15 s apart across the agent's relays, so
     cameras that started together don't all blink together each hour. A longer read for a show's streams would make
     these rarer: [shows.md](shows.md), Reads for a show, says why it is not done yet.
5. Once no launcher has held the path for 30 s, the relay stops. A launcher gives up its request once its MediaMTX is
   gone (its parent process changes), so a crashed MediaMTX doesn't leave paths held.

Both relays write into the input by RTMP, and OBS reads it by RTMP, so a stream whose sound is Opus (a browser or OBS
publishing by WebRTC) plays without it: MediaMTX's RTMP reader skips Opus. See [shows.md](shows.md), Not checked yet.

The studio API decides what may be read (`src/gateways/connect.ts`): what the followed show places (`placedStreams`,
resolved from the database: [shows.md](shows.md)), or, under `external`, anything in the organisation.

Checked by hand against MediaMTX v1.21.2 on macOS:

- `runOnDemand` on a regex path, with single-quoted arguments containing spaces.
- A pull's RTSP and RTMP sources carrying `?jwt=` to an HTTP-authenticated MediaMTX, which asked once per connection
  and never again while it stayed up; both tracks (H.264, AAC) forwarded; a dropped source and a restarted program
  MediaMTX both recovered by themselves.

## Not done yet

- Reporting which inputs each output reads as metrics, so the studio can draw inputs for an external output. The
  agent's status has them (`obs.inputs.reading`).
- A remote control surface of the studio's own. External control means obs-websocket, reached the way the deployment
  allows.
