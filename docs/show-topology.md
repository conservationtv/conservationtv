# A show's topology

A stream is a picture delivered: a source, exposures carrying it to gateways, recorders. Each hop has an ID, reports
are filed against it, and the studio draws, colours and charts the whole chain from one list read. A show going out had
none of that: an organisation-wide broadcast, one `show_output` row naming the agent that runs OBS, and channels that
are on or off for the whole organisation. Nothing on the way out reported anything.

This gives the way out the same shape, so a show's page can be as capable as a stream's.

```
 Output agent's network                         Internet / its network
┌──────────────────────────────────────┐       ┌───────────────────────────┐
│ <agent>  (OBS, following the show)    │       │ Forward → Twitch channel  │
│  └ Programme  1080p30 · 6000 kbps ────┼──────▶│ Forward → RTMP channel    │
│     (OBS → program MediaMTX)          │──────▶│ Preview → conservation.tv │
│     └ Recorder (OBS records it)       │──────▶│ Preview → a MediaMTX gw   │
└──────────────────────────────────────┘       └───────────────────────────┘
```

Decided (2026-11-10):

- An organisation may have **more than one show**. Every show follows the organisation's one broadcast for now (its
  Durable Object, `src/shows/host.tsx`, keyed by the organisation): what goes out differs by show (output, encoding,
  forwards, previews, recording), what is on screen doesn't yet. That is sorted out later.
- A forward's `enabled` belongs to the show, not the channel: a channel is on for one show and off for another.
- **Inputs** (the streams the composition places) stay as they are: not a node yet.
- A **preview** has an exposure's shape, a place the programme is published to and read from (conservation.tv, or a
  MediaMTX gateway on a network), but a table of its own.
- A **recorder** has OBS record the programme alongside streaming, as MediaMTX will record an exposure for a stream's
  recorders.

## Data

All new tables use `uuidv7()` IDs, carry `organisation_id`, and take the topology's access (`topologyActions`,
`topologyRoles`): members read, administrators write. Composite foreign keys keep every row inside its organisation.

| Table           | Columns                                                                                                                                                                              | Notes                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `show`          | `id`, `organisation_id`, `name`, the programme's encoding (`width`, `height`, `fps`, `bitrate_kbps`, `keyframe_seconds`, defaulting to today's 1920×1080, 30, 6000, 2), `created_at` | The encoding moves here from the constant in `configuration/plan/index.ts`. |
| `show_output`   | as now, `show_id` now referencing `show` (cascade)                                                                                                                                   | One output per show, as now.                                                |
| `show_forward`  | `id`, `show_id`, `channel_id`, `enabled`, `created_at`; unique `(show_id, channel_id)`                                                                                               | Replaces `channel.enabled`, kept unused for a release, then dropped.        |
| `show_preview`  | `id`, `show_id`, `gateway_id` (text, as `exposure.gateway_id`: a built-in slug or one of the organisation's gateways), `created_at`; unique `(show_id, gateway_id)`                  |                                                                             |
| `show_recorder` | `id`, `show_id`, `kind` (`obs`), `params` (jsonb, `{}`), `created_at`                                                                                                                |                                                                             |

Migration, for what exists: a `show` row for every organisation that has a `show_output`, **with the organisation's
ID as its ID** (today's show ID is the organisation's, and every `show_output.show_id` already holds it), named
"Broadcast"; and a `show_forward` for each of that organisation's channels to that show, `enabled` as the channel was.

## Subjects and metrics

Reports are filed against new subject kinds, as `device:` and `exposure:` are now:

| Subject                 | Reported by                                                               | Metrics                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `program:<showId>`      | the output agent                                                          | `program.ingest.bitrate` and `program.ready` (the program MediaMTX's `show/program`), `program.fallback` (1 while the offline segment plays because OBS isn't publishing); from obs-websocket: `obs.fps`, `obs.render.skipped`, `obs.output.skipped`, `obs.output.congestion`, `obs.output.reconnecting` |
| `forward:<forwardId>`   | the output agent                                                          | `forward.egress.bitrate` (what the forward's reader of `show/program` is sent), `forward.connected`                                                                                                                                                                                                      |
| `preview:<previewId>`   | the output agent                                                          | `preview.egress.bitrate`, `preview.connected`                                                                                                                                                                                                                                                            |
| `recorder:<recorderId>` | the output agent                                                          | `recorder.active`, `recorder.bytes`                                                                                                                                                                                                                                                                      |
| `channel:<channelId>`   | the output agent, for each channel it forwards to that has stats (Twitch) | `channel.live`, `channel.viewers`, `channel.uptime`: what the platform says of the channel, from `organisations.channels.stats.get`                                                                                                                                                                      |

`organisations.subjects.states.list` and `metrics.query` already take any subject ID, so the studio reads these as it
reads a stream's.

## API (v1 operations, new unless said)

- `organisations.shows.list`: every show with its output, forwards, previews and recorders (a list with its
  relations, as `organisations.streams.list` is). `create` (`name`, encoding optional), `get`, `update` (name,
  encoding), `delete`.
- `organisations.shows.output.get|set|delete`, by show. The organisation-level `organisations.show.output.*`,
  `organisations.show.follow` and `organisations.show.compose` keep working unchanged: the output ones act on the
  organisation's show whose ID is the organisation's, while it exists.
- `organisations.shows.forwards.create` (`channelId`, `enabled`), `update` (`enabled`), `delete`.
- `organisations.shows.previews.create` (`gatewayId`), `delete`, and `connect` (`action` read or publish,
  `protocol`, `rendition`), as `organisations.streams.exposures.connect`: members read; the show's output device
  publishes. Through the same gateway providers as exposures, not a second copy of them.
- `organisations.shows.recorders.create` (`kind`, `params`), `update`, `delete`.
- `organisations.channels.stats.get`: what a channel's platform says of it now (`live`, and while it is, `viewers`,
  `startedAt`, `title`, `category`, `language`), for the show's output only, as `organisations.channels.ingest` is
  (a device holding `channelBroadcaster`). The API refreshes the Twitch connection's tokens and calls Helix
  `GET /streams` itself, so no token reaches the agent; `unsupported_channel` for an RTMP destination.
- `organisations.channels.*`: `enabled` is no longer a channel's (in place on v1: no contract snapshot has been cut,
  and only the studio web app calls these).

## Device configuration (`deviceConfiguration.get` v1: additive only)

Agents built from `main` poll this operation; it must not change shape in place. The `obs` section only gains fields:

- `output`: the show's encoding, rather than the constant.
- `forwards[]`: each keeps `organisationId` and `channelId`, and gains `forwardId`; only enabled forwards are listed,
  as only enabled channels were. Each gains `stats` (optional): whether its channel has stats to read.
- `previews[]` (new, optional): `previewId`, `gatewayId`, and what the agent connects with to publish it.
- `recording` (new, optional): `recorderId`, and anything the kind needs.
- `program` (new, optional): `subjectId` (`program:<showId>`), so the agent knows what to report against.

An agent on `main` ignores what it doesn't know (`ObsSpecSchema` is a non-strict `z.object`).

## Agent (`runtimes/obs`)

- **Reporting:** read the program MediaMTX's metrics as the gateway MediaMTX's are read
  (`runtimes/mediamtx/metrics.ts`), filed against `program:`, `forward:` and `preview:` subjects, splitting what
  `show/program` sends by reader as publisher egress is split now; and obs-websocket's `GetStats` and
  `GetStreamStatus` against `program:`. Each forwarded channel with `stats`, read with
  `organisations.channels.stats.get` every few seconds and reported against `channel:` (`channel-stats.ts`): the
  agent decides when and how often to read, and keeps nothing between reads.
- **Previews:** publish the programme to each preview: to conservation.tv by the `moq` CLI, as a stream's publishers
  are (`builders/publishers.ts`); to a MediaMTX gateway by pushing to its publish URL.
- **Recording:** with a recorder configured, OBS records alongside streaming (obs-websocket `StartRecord`), kept going
  by the watchdog that keeps it streaming (`streaming.ts`), into the agent's data directory.

## Studio

The Show section becomes Shows: a list, and a show's page laid out as a stream's, its tabs Configuration (the
topology above, the output agent, encoding, forwards, previews), Outputs (each preview, read as a stream's outputs
are), Recording and Traffic, with the broadcast's stage and Compose kept on it.
