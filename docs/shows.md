# Shows: state, order, takeover and delivery

> Supersedes the show parts of [outputs.md](outputs.md) and [show-topology.md](show-topology.md): a show's state now
> lives in the database, a show names streams rather than exposures, and Compose only asks a show to look again.

A show is controlled by a few attributes in the database. One pure function turns them, with the current state of the
organisation's streams, into the plain state the broadcast (packages/shows) is composed from. vignette is how the scene
is built, never where state lives. Nobody hands the show's object state: callers only tell it to look again.

```
 database (intent)                 resolve (pure)                  show object (cache + fan-out)
┌──────────────────────────┐      ┌───────────────────────┐       ┌──────────────────────────────┐
│ show: slots, mix,        │      │ lineup, positions,    │       │ compose; if that changed:    │
│   takeover               │─────▶│ cards, takeover,      │──────▶│ keep the bootstrap, and      │
│ show_stream: rank, audio │      │ what is placed        │       │ send it to every follower    │
│ stream, camera, exposure │      └───────────────────────┘       └──────────────────────────────┘
│ subject_state (health)   │                 ▲
└──────────────────────────┘        sync(): a poke, never a payload
```

## Decisions

| Question                            | Decision                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Where state lives                   | The database. The object's copy is a cache, rebuilt from the database whenever it is missing or poked. |
| A cam locked, disabled, deleted     | Leaves the lineup; the rest move up.                                                                   |
| A cam unlocked, or a new cam        | Joins at the end, so it never disrupts what is on screen. Swap it in.                                  |
| Someone goes live (a pushed stream) | Waits on standby while published, never on air by itself: swap it in, or put it in an empty slot.      |
| Fewer cams than slots               | The layout keeps its shape; the spare slots show the empty card.                                       |
| A cam never given audio settings    | Standard volume (0 dB), not muted.                                                                     |
| Short codes                         | `stream.code`, at most 4 characters, unique in the organisation.                                       |
| A cam an output cannot reach        | Keeps its slot and shows its card on that output; the show's controls warn, naming the output.         |
| Who operates a show                 | Any member: slots, order, audio, takeover. Naming and deleting stay with administrators.               |
| What delivers a stream              | Not the show's business. Each reader resolves its own delivery.                                        |
| Takeover                            | A mode of the show, not slot one. The grid's state is untouched, and not placed while it is live.      |
| A takeover that drops               | Holds on its card until someone ends it.                                                               |
| Sizes                               | No named renditions. Readers say what size they need; a delivery gives the closest it has.             |
| A stream with no source             | Pushed: its deliveries are plumbing the API makes when someone publishes it, and keeps.                |
| Who goes live                       | Holders of `streamPublisher`: administrators, and members one lets. It also reads and replaces keys.   |

## Data

| Table             | Columns added                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream`          | `code` (text, nullable, 1–4 of `A-Z0-9`, unique per organisation)                                                                                   |
| `show`            | `slots` (0–6, default 6), `volume_db` (default 0), `muted` (default false), `takeover_stream_id` (nullable), `takeover_live` (default false)        |
| `show_stream`     | new: `show_id`, `stream_id` (primary key together), `organisation_id`, `rank` (nullable), `volume_db`, `muted`, `sync_offset_ms`, `audio_stream_id` |
| `output`          | `input_gateway_id` (text, nullable): read every stream from this gateway; null chooses per stream                                                   |
| `stream_key`      | new: `stream_id` (primary key), `organisation_id`, `key` (encrypted), `key_sha256`, `created_at`: a pushed stream's encoder key                     |
| `personal_stream` | new: `organisation_id`, `user_id`, `device` (`phone`, `computer`) (primary key together), `stream_id` (unique), `created_at`                        |

- `show_stream` is one stream's membership of one show. It is made the first time something needs it, and is gone with
  its show or its stream. Its audio columns outlive the stream's time on screen.
- `takeover_live` is false whenever `takeover_stream_id` is null (a check constraint).
- `takeover_stream_id` and `audio_stream_id` are composite foreign keys to the organisation's streams, so deleting a
  stream clears them first (src/services/streams.ts): `on delete set null` would clear `organisation_id` too.
- Members read all of it. Members also write a show's operating columns and `show_stream`; administrators alone
  create, name and delete shows. Umbrella grants columns to the application role, not to a principal, so `show`'s
  one update action (`operate`) is the members', `name` is immutable to every request session, and a rename is
  trusted code that first asks umbrella whether the caller may `create` the organisation's shows.
- `output.input_gateway_id` is read by `organisations.streams.connect`, and set by `organisations.outputs.create` and
  `update` (version 2), which refuse a gateway that is neither built in nor the organisation's (`invalid_reference`).
  A gateway an output reads from cannot be deleted (`in_use`), as one an exposure or a preview uses.
- `stream_key` is readable and writable by `streamPublisher` alone (a role of its own, included in
  `organisationAdmin`, and granted on its own by an administrator: `organisations.members.grantPublisher`), never by
  members or any device; its `key` is sealed at rest (`stream.key`). Agents are told
  `key_sha256` alone. Gone with its stream.
- `personal_stream` is the stream a member goes live on from a kind of device. Members read it; only trusted code
  writes it, once the member may publish. Gone with its stream or the membership: the stream stays. It makes the
  stream that member's to publish and to hold the key of (see [Stream keys](#stream-keys)).

## The lineup

The **lineup** is the show's streams in order. A camera's stream may be in it while its camera is `enabled` and it
has at least one exposure. A pushed stream (no camera: a phone or a PC going live, OBS) may be in it while someone
publishes it, as its deliveries' health says: an exposure of it `active` and fresh, which is while its relay
announces it or its ingest path is ready, for a quarter of the window ([Health and stats without an
agent](#health-and-stats-without-an-agent)). That takes about half a minute after it starts and lasts about a minute
and a half after it stops, and needs an agent covering the relay. A health transition pokes the show, so it is
noticed as soon as health says so.

A pushed stream is never placed by itself, even in an empty slot: it waits on **standby** (out of the lineup, with no
rank, `absence: standby`) until a swap ranks it, in another stream's place or an empty slot's. When nobody publishes
it any more it leaves the lineup like a locked camera, and the rest move up; going live again puts it back on
standby. Any stream can still [take over](#takeover).

`rank` orders the lineup. Positions are never stored: position _n_ is the *n*th stream by rank, and the first `slots`
of them are on screen.

Every sync **normalises** before it resolves, in the same transaction, holding the show's row:

1. a ranked stream that may no longer be in the lineup loses its rank;
2. a camera's stream that may be in it with no rank is given the next rank after the greatest, oldest stream first. A
   pushed stream is never ranked here: only a swap ranks it.

So a camera that is locked and unlocked comes back last, a new camera joins last, and no stale rank survives a sync.
Nothing else has to remember to do this.

A command names streams. Anything that speaks in positions (chat, a keyboard shortcut) is resolved to streams inside
the command's transaction, against the lineup as it is then. `swap(a, b)` exchanges two streams' ranks, wherever they
are: both on screen, or one off it, which is how a camera is brought on. A stream on standby swapped with one in the
lineup takes its place, and that one leaves the lineup (a camera's rejoins at the end, a pushed one goes back to
standby); swapped with an empty slot (a position past the lineup's end that is on screen), it takes the first empty
slot.

## Layouts

`packages/shows` has one table: for each slot count, a rectangle per position on a 6×6 grid of the 1920×1080 canvas
(a unit is 320×180). Position 1 is always the largest. Video fills its slot, centred and cropped (`fit="cover"`). The
studio draws its layout picker from the same table.

```
 1            2            3            4            5            6
┌─────────┐  ┌────┬────┐  ┌────┬────┐  ┌────┬────┐  ┌──┬──────┐  ┌──┬──────┐
│         │  │    │    │  │    │ 2  │  │ 1  │ 2  │  │3 │  1   │  │2 │      │
│    1    │  │ 1  │ 2  │  │ 1  ├────┤  ├────┼────┤  ├──┤──────┤  ├──┤  1   │
│         │  │    │    │  │    │ 3  │  │ 3  │ 4  │  │4 │  2   │  │3 │      │
└─────────┘  └────┴────┘  └────┴────┘  └────┴────┘  ├──┤      │  ├──┼──┬───┤
                                                    │5 │      │  │4 │5 │ 6 │
                                                    └──┴──────┘  └──┴──┴───┘
```

| Slots | Rectangles `[column, row, width, height]`, in position order            |
| ----- | ----------------------------------------------------------------------- |
| 1     | `[0,0,6,6]`                                                             |
| 2     | `[0,0,3,6]` `[3,0,3,6]`                                                 |
| 3     | `[0,0,3,6]` `[3,0,3,3]` `[3,3,3,3]`                                     |
| 4     | `[0,0,3,3]` `[3,0,3,3]` `[0,3,3,3]` `[3,3,3,3]`                         |
| 5     | `[2,0,4,3]` `[2,3,4,3]` `[0,0,2,2]` `[0,2,2,2]` `[0,4,2,2]`             |
| 6     | `[2,0,4,4]` `[0,0,2,2]` `[0,2,2,2]` `[0,4,2,2]` `[2,4,2,2]` `[4,4,2,2]` |

## The state a show is composed from

```ts
interface BroadcastStream {
  organisationId: string;
  streamId: string;
  name: string;
  code: string | null;
  /** What is under its video: shown whenever the video has no picture. */
  card: 'loading' | 'offline';
}

interface BroadcastState {
  /** The layout: 0 to 6. */
  slots: number;
  /** The lineup's first `slots` streams, in position order. Fewer leaves empty slots. */
  cameras: BroadcastStream[];
  /** The armed takeover source, and whether it is on air. */
  takeover: (BroadcastStream & { live: boolean }) | null;
  /** How each stream it places is mixed, by stream ID; and the show's own mix. */
  audio: Record<string, { volumeDb: number; muted: boolean; syncOffsetMs: number; from: string | null }>;
  mix: { volumeDb: number; muted: boolean };
}
```

`packages/shows` also says which streams a state places (`placedStreams(state)`): the takeover source while one is
armed, the grid's cameras unless a takeover is live, and each stream a scene places for its sound alone
([Audio](#audio)). Reads are authorised from that, so the composition and what an output may read cannot drift.

### Cards

Each slot stacks a card under its video, and the video is always placed. A stream's health chooses only which card is
there, so a late or wrong verdict can never hide a live picture, and a picture that returns covers its card at once.

- `loading`: the default. A stream that is healthy, starting, or not yet judged.
- `offline`: the stream's source is unreachable, or every delivery of it is failing or has stopped reporting. Each by
  its own state, as `organisations.status.get` judges a subject's own status (`streamOffline`, src/health/status.ts).
- An empty slot shows the empty card.

A takeover's card fills the canvas under a picture fitted whole, so it shows in the bars around a picture that is not
the canvas's shape: the cards are near-black for that.

Cards are composed from the show's own colour and text sources. A designed image can replace them later as an asset of
the bundle; none is generated here.

For this to work a target's video must be transparent while it has no picture.

### Audio

`show_stream` holds each stream's channel for a show (`volume_db`, `muted`, `sync_offset_ms`), and whose sound it
brings (`audio_stream_id`: null for its own). The state carries a channel for each stream it places, and the broadcast
composes them as vignette 3's audio channels:

- Each stream placed with its picture is heard through its own channel: `audio={{ volumeDb, muted, syncOffsetMs }}` on
  its `CtvStream`.
- A stream whose sound comes `from` another is placed with `audio={false}`, and the other stream is placed once in the
  same scene for its sound alone (`video={false}`: it takes no space), heard through its own channel. Not when that
  scene already hears it with its picture. `soundSources` in packages/shows says which, for the show, the resolver and
  `placedStreams` alike. A `from` that is the stream itself, or no stream of the organisation's, is its own sound.
- `CtvStream` carries sound and, unless `video={false}`, a picture (vignette's `media`).
- A source is heard only while the scene on air places it: an armed takeover is silent until it goes live, and the
  grid is silent while one is.
- The show's `volume_db` is vignette's master bus (`<Show mix>`). vignette's mix has no mute, so the show's `muted`
  mutes every channel.
- `sync_offset_ms` is vignette's range, −950 to 20000: positive delays the sound, negative holds the picture back.

## Takeover

`takeover_stream_id` **arms** a stream: it is placed in the `takeover` scene, off air, so its picture is already
playing when it is cut to. `takeover_live` puts that scene on air.

What goes on air is only ever what someone asked to put there: a command that arms another stream, or disarms, without
also saying `takeoverLive` ends a live takeover (the new stream is armed, off air). One that says both, as chat's
`!takeover` does, cuts straight to the new stream. Arming the stream already armed changes nothing.

- `main` scene: the grid, then the overlay.
- `takeover` scene: black, the stream fitted whole (`fit="contain"`), its card under it, then the same overlay.
- The overlay is the show's own layers, placed in both scenes: the clock today.
- While a takeover is live the grid is not placed, so its inputs are released. Ending it brings the grid back through
  its cards.
- Any stream can take over. A camera stream taking over is "solo".

## Sync

`ShowHost.sync()` takes no state. Inside the object, one at a time, it reads the database as trusted code, normalises
the lineup, resolves, composes, and sends followers what changed only if the composition differs from what it keeps
(its snapshot but for the revision). It composes every time rather than comparing the state, because the composition
depends on its code too: a deployment that changes `packages/shows` changes what a show composes to with no row
changed. Later callers always see later rows, so nothing can apply stale state.

Syncs are level-triggered: one asked for while another runs is queued behind it, and every request meanwhile shares
that one, so a poke is never lost and at most one waits. A sync that fails (the database, the bundle's manifest) is
logged and changes nothing kept; it never resets the object, so followers stay connected, and the alarm tries again.

What pokes it:

1. A show command, after it commits: each is audited as a configuration change, and one on a show's own path pokes
   that show alone (`showId`).
2. Any other audited configuration change in the organisation, after it succeeds and its entry is written: one hook
   beside `audited('configuration')` pokes each of the organisation's shows. Locking a camera, adding an exposure and
   renaming a stream all arrive here.
3. A recorded health transition (src/health/consumer.ts), after it commits.
4. The object's own alarm, every minute while anyone follows it: the backstop for a missed poke, and the only way a
   subject that stopped reporting is noticed, since going stale writes nothing. Following sets it only when none is
   set, so following again and again cannot hold it off; it sets itself again after every sync, failed or not, and
   stops once nobody follows.

The first follow since the object started syncs it first, which is after every deployment: a fresh object rebuilds
itself, and one composed by older code is brought up to date before anyone is sent it. A frame page's follow, which
has no session, syncs only an object that has composed something, so nobody can make the API read the database for a
show that is not there. A sync that finds the show gone closes every socket (code 4404) and forgets everything,
alarm included: from then on its object answers 404.

A camera locked and unlocked again before the lock's poke has run comes back at its old place, not last: ranks are
cleared by the next sync, not in the transaction that locks it.

## Delivery

A `ctv-stream` source names a stream: `{ organisationId, streamId, size }`. How it is read is each reader's own
business, asked for when it plays it. It also carries `exposureId`, deprecated, where the stream has an exposure at
conservation.tv (its first): agents built before this build their OBS input from it and read that exposure by MoQ
(`organisations.streams.exposures.connect` v1), as they always did. Readers since ignore it. Such an agent places a
stream that has none as an input that never plays, so its card shows; and it creates an input for each source placed
for its sound alone, off every scene it shows, which it never puts on air.

`organisations.streams.connect` (`POST /organisations/:id/streams/:streamId/connections`) takes the protocols the
caller can play, in its order of preference, and answers with one connection and the exposure it chose.

1. Candidates: the stream's exposures on gateways the caller can reach. A gateway with no network is on the internet,
   reachable by everyone. A gateway on a network is reachable by an agent on that network, and by nobody else.
2. Of those, the ones read by a protocol the caller named.
3. An output's `input_gateway_id`, when set, leaves only that gateway.
4. Preferred in this order: on the caller's own network, then conservation.tv, then any other internet gateway;
   exposures whose health is failing last.

A member's browser reaches internet gateways only. A device reads what its output's show places
(`placedStreams`), or anything in its organisation under `external` control; asking for one exposure of it
(`organisations.streams.exposures.connect`, as agents built from `main` do for conservation.tv's), it is admitted only
to one on a gateway it reaches, and on its output's input gateway when that names one. A MediaMTX gateway counts only by the
protocols it has a server for now: one its agent registered, or its settings override (`served`,
src/gateways/provider.ts). So a reader is never handed a gateway that would answer `gateway_unavailable`, and the same
holds for choosing where a publisher goes live.

A pushed stream (no source) has chains that stand whether or not anyone publishes them: a phone may have gone live by
MoQ one day and by WebRTC the next. For one with several candidates the reader's choice also asks each candidate's
gateway whether it is live (`live`, as `organisations.streams.live.list` does, from the same 5-second cache), and puts
those it says are not live last of all. A camera's are chosen as before, without asking.

In OBS, a stream is `inputs/<streamId>` on the program MediaMTX whatever delivers it, so an input never changes when
its delivery does. Behind it the agent relays MoQ with `moq export`, and pulls any other protocol.

In the studio, a stream with no delivery a browser can play shows its card. Such a show is watched through its
output's preview.

## Sizes

A delivery carries one picture, the one its source gives. Where its protocol has a catalog, a MoQ broadcast's, it may
carry smaller pictures beside it, each described by what it is (`codedWidth`, `codedHeight`, `bitrate`): a ladder, its
rungs decided by the system from what the source can do, never configured per exposure. There are no named renditions
anywhere: not on exposures, recorders, previews, connections, paths, tokens or metrics.

The database still has `exposure.renditions` and `recorder.rendition`, deprecated, read by nothing and left at their
defaults on new rows: the Worker still serving while a release's migrations run reads and writes them, and they keep
which deliveries had been set to a smaller rendition, which a size cap may carry over. A later release drops them.

- **Readers say what size they need.** The studio's player sets `@moq/watch`'s `target: { width, height }` from the
  size it draws at (src/components/streams/moq-player.tsx), and the player picks the catalog's closest picture.
- **Path protocols carry the one picture.** RTSP, RTMP, WebRTC and HLS on a MediaMTX gateway read one path per
  exposure, `<exposure>/live` (a preview's `<preview>/live`), as its MoQ broadcast is `<exposure>/live.hang`.
- **Recorders record the largest picture.**
- **One MoQ token covers the exposure's path**, so a reader changing size needs no new session.
- **Slots want 1920, 1280, 960 and 640 wide** (the layouts above, at 320 a unit), so the rung that pays is 640 wide;
  960 is optional. An Axis camera can encode a smaller picture itself (`cameraRungOrigin` in packages/cameras: VAPIX
  `resolution`, `videomaxbitrate`); a plain RTSP camera has its one stream.

### What readers get today

The source alone. The agent's moq CLI pulls the exposure's MediaMTX path over RTMP and publishes it as the one
broadcast readers watch, `<exposure>/live.hang`, whose catalog is the CLI's own: one video and, where the camera sends
it, one audio track, with their sizes. The agent covering the exposure reads that catalog back through the relay to say
whether the relay has the exposure (`relay.announced`, apps/agent/core/src/gateway/streams/relay-check.ts; see
[Health and stats without an agent](#health-and-stats-without-an-agent)). Agents from before this
published each rendition as a broadcast of its own and joined them into `live.hang` with a catalog pointing into
them; the API tells them of one rendition, `default`, so they publish the same picture the same way.

MediaMTX paths were `<id>/default`, one per rendition, and are `<id>/live` now, whichever agent serves them, since
agents serve the names they are told. A reader holding a URL, and a token, from before the change reads nothing at the
old path until it asks again: an output's relay asks when its token is due, up to an hour later.

### Why there is no ladder yet

Checked on 2026-11-26, against the pinned moq CLI (0.14.7), the newest release (0.14.18), MediaMTX 1.21.2 and ffmpeg
8.1, each catalog read back with `moq fetch catalog.json` from a local `moq --listen-tcp-bind` (no browser):

| Route                                                            | Result                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A rung as a broadcast of its own, joined into one catalog        | Collides. A hang catalog keys each picture by the track to subscribe to, with no field to name it apart (`broadcast` only says where it is), and the CLI names every import's tracks alike (`0.flv-v`). Renaming means relaying media through the agent, doubling its uplink. |
| `import ts`, MPEG-TS with two H.264 streams on stdin             | Works with stock tools: one broadcast, `0.avc3` 1280×720, `1.avc3` 640×360, `2.aac`, sizes and bitrates in the catalog. Needs ffmpeg (`-c copy`) to mux two encodes into one TS.                                                                                              |
| `import flv`, enhanced-RTMP multitrack (as ffmpeg and OBS write) | Refused: `unknown format: FLV video FourCC [0, 97, 118, 99]`. moq-mux reads video multitrack as packet type 5; E-RTMP v2 has 6 (5 is `MPEG2TSSequenceStart`). Patched to 5, the same file gives `0.flv-v` and `1.flv-v` in one catalog. Unchanged on moq's `main`.            |
| `import rtmp --connect` from a MediaMTX path with two videos     | One video: MediaMTX's RTMP reader skips the second (`skipping track 2 (H264)`). WebRTC (WHEP) does the same.                                                                                                                                                                  |
| `import srt --connect` from MediaMTX                             | Refused by MediaMTX: `peer is older version than agent's minimum set`.                                                                                                                                                                                                        |
| `transcode`, a ladder encoded only while watched                 | Not released: on moq's `main` only. On a Pi 5 it would be a software decode and openh264 encode per watched rung; the Pi has no H.264 encoder, so a few cameras at most.                                                                                                      |

Each working route needs a tool no agent carries yet, and none could be exercised with a real camera and player
here, so the plumbing is ready and the ladder waits: readers already ask by size, the publisher's catalog is the one
readers get, tokens cover every size, and `cameraRungOrigin` says what an Axis camera can make.

### What adding one takes

The rung for an Axis camera is a second encode from the camera, so it costs the agent nothing to make. One publisher
must put both pictures in one broadcast with distinct track names. It plugs in at the publisher command
(`moqPublishCommand`, apps/agent/core/src/binaries/moq.ts, run per exposure by builders/publishers.ts); the API plans
the rung's path beside the exposure's (`planActiveAgent`, apps/studio/api/src/configuration/plan/index.ts) and names
it to the publisher in a new version of `deviceConfiguration.get`. Nothing else changes.

- **A small CLI** that imports several sources into one broadcast, each its own track. The owner's `cstream-moq`
  (`publish --broadcast … --rendition --name … --source rtsp://…`, repeated) is that, with sources parked until
  watched; it reads RTSP, which MediaMTX serves on loopback without a token. It needs a release per platform and a
  check that its moq crates (hang 0.20, moq-mux 0.9) speak to the deployed relay. Track names are keys, not a
  vocabulary: name them by size.
- **Or a fix upstream** of moq-mux's video multitrack packet type, plus something that writes multitrack FLV from two
  RTSP sources, which MediaMTX does not.
- **Or ffmpeg** on every agent, muxing the two encodes into MPEG-TS for `moq import ts`: a new managed binary, and a
  pipe, which MediaMTX's `runOnInit` cannot express without a shell.

Whichever, check that the two encodes' timestamps are close enough for `@moq/watch` to switch between them cleanly.

## Operations

| Operation                                     | Who              | What                                                                                      |
| --------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `organisations.shows.list`, `get`             | members          | gains `slots`, `volumeDb`, `muted`, `takeoverStreamId`, `takeoverLive`; `get` the lineup  |
| `organisations.shows.get` v2                  | members          | also `takeoverMix`, how the armed stream is mixed; `unreachable`, what outputs can't read |
| `organisations.shows.controls.update`         | members          | `slots`, `volumeDb`, `muted`, `takeoverStreamId`, `takeoverLive`                          |
| `organisations.shows.lineup.swap`             | members          | `{ a, b }`, each `{ streamId }` or `{ position }`                                         |
| `organisations.shows.streams.mix`             | members          | a stream's `volumeDb`, `muted`, `syncOffsetMs`, `audioStreamId` in the show               |
| `organisations.streams.connect`               | members, devices | read a stream by whatever delivers it, or publish a pushed one (`action: publish`)        |
| `organisations.streams.personal.ensure`       | publishers       | the stream you go live on from a `phone` or a `computer`, made the first time             |
| `organisations.streams.encoder.ensure`        | publishers       | what an encoder pastes, and the key; makes the chain                                      |
| `organisations.streams.key.replace`, `delete` | publishers       | a new key, or none                                                                        |
| `organisations.streams.live.list`             | members          | which of the organisation's exposures are live now                                        |
| `organisations.outputs.*` v2                  | as v1            | `list`, `get`, `create`, `update` gain `inputGatewayId`                                   |
| `organisations.chatCommands.*` v2             | as v1            | `list`, `get`, `create`, `update` gain the `showSwap` and `showTakeover` actions          |
| `organisations.shows.compose`                 | members          | deprecated, in its released shape: it only syncs the show, and answers once it has        |
| `organisations.streams.exposures.*` v2        | as v1            | `create`, `update` without `renditions`; `connect` without `rendition` or `renditions`    |
| `organisations.streams.recorders.*` v2        | as v1            | `create`, `update` without `rendition`: a recorder records the largest picture            |
| `organisations.outputs.previews.connect` v2   | as v1            | without `rendition` or `renditions`                                                       |
| `deviceConfiguration.get` v4                  | devices          | a path names no rendition; a publisher names the one `path` it reads; pushed paths        |
| `deviceConfiguration.get` v4                  | devices          | `relays`: the stats to read and the exposures to watch; `mediamtx` has no `stats`         |
| `organisations.members.grantPublisher`        | administrators   | give a member `streamPublisher`; `revokePublisher` takes it away                          |

`get` returns the organisation's camera streams, and its pushed streams while someone publishes them, for the show
(`lineup`): those in the lineup with their `position` (from 1), and those out of it with why (`absence`: `standby`,
`locked`, `disabled`, `undelivered`), each with its `show_stream` settings. `lineup.swap` answers with the same
`lineup`, and takes a stream on standby by ID, or an empty slot by position. A stream out of the lineup has no row
there to mix, so `get` also says how the armed takeover is mixed (`takeoverMix`, null with none armed), which is where the show's controls
set its level and mute. And it says what the outputs following the show cannot read (`unreachable`,
src/shows/reach.ts; see [What an output cannot reach](#what-an-output-cannot-reach)).

The mix is `streams.mix`, not `streams.update`: the SDK names an operation by its last two segments, and
`streams.update` would collide with `organisations.streams.update`.

`organisations.streams.live.list` (`GET /organisations/:id/streams/live`) answers
`{ exposures: [{ id, streamId, gatewayId, live, checkedAt }] }`, oldest first: `live` is null where the gateway cannot
say (see [Going live](#going-live)), and `checkedAt` is when it said so.

The versions of the operations above released while exposures named renditions (`streams.list` and `get` v1,
`topology.get` v1 and v2, `exposures.*` v1, `recorders.*` v1, `previews.connect` v1, `deviceConfiguration.get` v1
to 3) answer as if every exposure, recorder and preview offered `default` alone (src/topology/renditions.ts). They
accept the `renditions` an old client sends, and ignore them; a `rendition` other than `default` to connect to or
record is `rendition_not_offered`.

The versions of `organisations.chatCommands.*` released before show commands do not tell of them: `list` leaves them
out, and `get` and `update` answer `not_found` for one (an `update` changes nothing).

`organisations.streams.connect` takes `{ protocols, action, networkId }` (`action` is `read` when left out;
`networkId` is the publisher's network, publishing only) and answers `{ exposureId, gatewayId, connection }`, where
`connection` is what `organisations.streams.exposures.connect` answers. Publishing is refused for a stream with a
source (`not_pushed`), and where no gateway the publisher reaches takes a protocol it named (`no_ingest`). The versions of
`organisations.topology.get` and `organisations.status.get` released before this still say what a show places in
exposures: `placed` is every exposure of each stream it places, and a show's status is those streams' sources and
deliveries.

## Chat

Two action kinds, run by the studio API as the answer to the trigger (`ran`, with a reply), so the agent carries
nothing (src/chat/shows.ts):

- `showSwap`: two words, each a position (a number) or a name. `!swap 1 2`, `!swap serval 2`, `!swap serval fox`. Both
  must be in the lineup, or a name may be a stream going live on standby (`!swap phone 2`, which puts it on).
- `showTakeover`: one word, a name or `off`. A name arms that stream and puts it on air at once; `off` ends the
  takeover: not live, and disarmed. Any stream can take over but one whose camera is locked or disabled.

The show is the one the triggering agent's output follows; with none (or under `external` control) the use is
`unavailable`. A word of digits alone is a position, from 1. Any other word is a name: it matches a stream's code, its
name, or its source camera's name and aliases, compared as chat compares names (`chatName`). The lineup's streams are
matched first, so a camera with other streams is still found; then any of the organisation's, so a name off the
lineup says why. No match, an ambiguous name, a position past the end, a stream out of the lineup and a missing word
are `unresolved`, with a reply told only to a moderator or the broadcaster, as for cameras. Camera presets find their
camera the same way (`calledIn`, `onlyOne` in src/chat/resolve.ts).

The decision is pure, from facts read first: the show is read holding its row, its lineup normalised in memory. Once
the command's turn is taken, in the same transaction, the normalised ranks and the swap, or the takeover, are written;
the show is poked after the transaction commits.

## Going live

A stream stands; its deliveries are made when they are needed. Someone going live asks how to publish stream S with
what they can send, and the API picks the gateway and makes sure the chain of exposures exists
(src/gateways/publish.ts).

| Publisher                 | Sends             | Lands on                                         |
| ------------------------- | ----------------- | ------------------------------------------------ |
| A browser, phone or PC    | MoQ               | conservation.tv directly                         |
| OBS, a phone's stream app | RTMPS, RTMP, WHIP | a MediaMTX gateway, on a network or the internet |

### The chain

A stream with no source device is **pushed**. Publishing it (`organisations.streams.connect` with
`action: publish`, or `organisations.streams.encoder.ensure` for an encoder) runs one trusted transaction, once the
caller may publish (`streamPublisher`, the decision row-level security makes on `stream_key`) and, for a member's
personal stream, is that member (see [Stream keys](#stream-keys)):

1. The gateway: as a reader's is chosen (`chooseIngest`, src/gateways/delivery.ts). Candidates are the built-in
   gateways and the organisation's, published to by a protocol the publisher named, that it reaches: the internet's,
   and a network's only when the publisher says it is on that network (`networkId`). The API cannot tell for a
   browser or an encoder, so it is one choice the person makes ("Where are you?": anywhere, by the internet, the
   default; or "On site at" a network with a MediaMTX gateway). Preferred: the publisher's own network, then
   conservation.tv, then any other internet gateway; then the publisher's order of protocols.
2. The **ingest**: the stream's exposure at that gateway with no upstream and no pinned publisher, made if it has none.
3. The **onward hop**, for an ingest that is not at conservation.tv: an exposure at conservation.tv whose upstream is
   the ingest, made if it has none, which the agent running the ingest's gateway republishes by MoQ, as it does a
   camera's.

Both are kept, so a URL an encoder saved keeps working, and nobody configures them by hand. Then the publisher is
given a short-lived credential for the ingest (an hour, as a reader's), or for an encoder, what to paste with the
stream's key.

### In the agent's plan

`deviceConfiguration.get` v4 serves a pushed stream's ingest on the agent's own gateway as a path whose source is
`{ push: { keySha256 } }`: nothing is pulled, a publisher pushes to it, attributed to its exposure like any other path
(so `path.ready` and the path metrics are its exposure's). The onward hop's publisher reads it as it reads a camera's
path, but only while someone publishes to it, rather than restarting it forever against an empty path, and the agent
runs it itself rather than MediaMTX (apps/agent/core/src/gateway/streams/pushed.ts): MediaMTX closes and remakes a
path whose config changes in all but a few settings, cutting off its publisher and readers, and the publisher's token
is renewed hourly. So every pushed path runs one fixed hook, `runOnAvailable`, a launcher holding a request to the
agent open while the path is published; the agent starts `moq import` (its relay URL and token in its environment)
when the request comes and stops it when it closes. A renewed token restarts that CLI alone; the encoder never sees
it. Versions 1 to 3 are told of no pushed path, nor of a publisher reading one: agents
built from `main` pull every path from somewhere.

A new ingest is served from the agent's next configuration, within about half a minute; until then WHIP answers 404
and RTMP is refused, and the studio's publisher waits and tries again.

### Admitting a publisher

The agent's MediaMTX asks the agent about every connection (apps/agent/core/src/gateway/streams/auth.ts):

- The studio's own publishers present a token this API signs as the agent, for one action on one path, for an hour.
- An encoder presents the stream's key. The configuration carries only its SHA-256 (`keySha256`): the key is 32 random
  bytes, so the digest cannot be turned back into it or guessed, and neither the agent nor its logs ever hold the key.
  A key admits publishing that one path, nothing else, not reading it. A replaced key's digest is gone from the next
  configuration; an encoder already publishing carries on until it reconnects.
- Asking the API at connect time instead was rejected: a gateway on a site's network would then refuse encoders
  whenever its internet link was down, and the API would see every connection attempt.

Checked on 2026-11-26 with the pinned MediaMTX (1.21.2), the agent's own config builders and auth answers, and ffmpeg
8.1 as the encoder, from a LAN address (loopback is trusted as it is): RTMP with the server and key apart (as OBS
sends them), RTMP as one URL, and WHIP with the key as bearer token were admitted, and the onward publisher started
on publish and stopped when it ended (then run by MediaMTX's `runOnReady`, before the agent ran it; not yet checked
since); a wrong key, no key, the key on another path, and the key to read (RTSP, RTMP)
were refused; a studio JWT still admitted. The key was in neither MediaMTX's log nor its metrics page (what the agent
reports); it is in MediaMTX's own loopback control API (`/v3/rtmpconns/list`, `query`) while connected, as tokens
are, which the agent does not read.

### What an encoder is given

`organisations.streams.encoder.ensure` answers, for each protocol whose server the gateway's agent registered
(or the gateway's settings override), what to paste. MediaMTX names a path `<exposure>/live`, and RTMP reads a URL as
an app and a stream name, joining them into the path, with the stream name's query handed to the agent's answers:

| OBS service | Server                                             | Stream key / Bearer token |
| ----------- | -------------------------------------------------- | ------------------------- |
| Custom…     | `rtmps://<gateway host>:1936/<exposure>`           | `live?key=<key>`          |
| Custom…     | `rtmp://<gateway host>:1935/<exposure>`            | `live?key=<key>`          |
| WHIP        | `https://<gateway host>:8889/<exposure>/live/whip` | `<key>` (bearer token)    |

An app that takes one URL is given `rtmps://<gateway host>:1936/<exposure>/live?key=<key>`. SRT is served by the
agent's MediaMTX but no agent registers where (`MEDIAMTX_PROTOCOLS` has no `srt`), so it is not offered yet.

### Stream keys

One per pushed stream, in `stream_key`, made by the first `encoder.ensure`, read again by it (so a member can copy it
once more), replaced by `organisations.streams.key.replace` and removed by `organisations.streams.key.delete`. Only
`streamPublisher` holds them, and every read or change is audited (`secrets`). A stream with a source device has none:
`key.replace` refuses one (`not_pushed`), as `encoder.ensure` does, and a stream given a source by
`organisations.streams.update` loses the key it had, so taking the source away again does not revive it.

- A member's personal stream (`organisations.streams.personal.ensure`) is theirs: only they publish it
  (`organisations.streams.connect`, `action: publish`, signed in or by their browser's own device), read its key
  (`encoder.ensure`) or replace it; they or an administrator remove it. Anyone else is refused (`forbidden`).
  `personal.ensure` only ever answers the caller's own.
- When a member loses the right to publish (`revokePublisher`, `revokeAdmin` leaving them without it, or leaving the
  organisation), the keys of their personal streams are removed in the same transaction, so an encoder they set up is
  refused from its agent's next configuration on. The streams stay the organisation's.
- A shared pushed stream's key is a shared secret: every publisher may read it, so removing someone who had it does not
  change it. An administrator replaces it (`key.replace`) after removing someone who should no longer publish it.

### From the studio

A member with the right to publish opens **Go live** (one tap from the app bar on a phone, or the sidebar), turns on
the camera or chooses a screen, and is live. The link, and a pushed stream's encoder settings, show only to those who
hold `streamPublisher` or are administrators, as the organisation list says of the signed-in account; anyone else who
opens the page is told an administrator can let them, on the Members settings. "Go live" makes or reuses their stream for this kind of device
(`organisations.streams.personal.ensure`: "Ada's phone", "Ada's computer"), not a throwaway.

- The browser is asked at runtime whether it can encode (`@moq/publish/support`, pinned at 0.5.4: the release matching
  `@moq/watch` 0.6.6's `@moq/hang` 0.5 and `@moq/net` 0.4), over WebTransport or the WebSocket fallback; one that
  cannot is told so. Nothing assumes Safari on an iPhone can publish. Going live by WebRTC (WHIP to a gateway) is not
  offered for now: a WebRTC reader picks no size, and the gateway's onward hop drops Opus (see
  [Not checked yet](#not-checked-yet)). So there is no "Where are you?" either: only conservation.tv takes MoQ.
- There is nothing to choose but the camera, microphone or screen. MoQ goes straight to conservation.tv as the
  broadcast readers watch, `live.hang`, as a ladder of sizes (packages/broadcast, src/profile.ts): a camera's 1080,
  720, 540 and 360 high, a screen's 2160 and 1440 above them, each no larger than the capture, all at 30 fps in
  hardware H.264 where the device has it. Each rung is Mediabunny's: a `MediaStreamVideoTrackSource` resizing the
  capture (halving past 2:1, so text stays whole) at its `Quality` level `high` (about 6 Mb/s at 1080p, 2.8 at 720p;
  360p is lifted to 1 Mb/s), in variable bitrate. The rungs are the sizes slots draw at ([Sizes](#sizes)); each is
  encoded only while someone watches it, and readers pick theirs by size. The sound is stereo Opus, untouched by voice processing. Its credential is renewed before it
  expires; the connection redials by itself.
- The page says where it is: not live, starting, connecting, live, or lost and retrying; and, from
  `organisations.streams.live.list`, whether the studio sees it live.
- Members publish as themselves, signed in; their browser's own device may sign for them. No credential lasts beyond
  an hour, and nothing is installed.

### Knowing it is live

- `organisations.streams.live.list` answers from each delivery's own source of truth, through its gateway's provider
  (`live`, src/gateways/provider.ts), each gateway asked once for all of the organisation's exposures there and its
  answer kept for 5 seconds in the cache (src/gateways/live.ts):
  - conservation.tv: what the relay has announced under the organisation's path. moq-relay answers
    `GET <relay>/announced/<root>?jwt=<token>` with a read token from gatekeeper for the organisation's path: plain
    text, one active announcement per line, relative to the token's root (moq-relay 0.17, `serve_announced`). An
    exposure is live while `<exposure>/live.hang`, the broadcast its readers watch, is announced.
  - A MediaMTX gateway: whether the exposure's path was ready (`path.ready`) in the last report its agent sent, within
    45 seconds. Unknown with no report so recent. A pushed path is ready while someone publishes to it.
  - A gateway that cannot be asked, or fails to answer, leaves its exposures unknown (`live: null`), not the read.
- A show's controls offer a pushed stream that is live, and is not already its takeover, with **Preview** (arm it; not
  while another takeover is on air, which arming would replace) and **Take over** (arm it and put it on air).
  Dismissing one is the viewer's own, and lasts until that stream goes offline again.

## Health and stats without an agent

A gateway is observed per gateway, not per publisher. The agent that runs a MediaMTX gateway reports every path on it,
a pushed one included. Every exposure of the organisation on a gateway whose relays publish stats (conservation.tv) is
**covered** by exactly one agent (`selectRelayCoverage`, src/configuration/plan/helpers.ts), which reports what the
relays carry of it (its traffic, from the stats broadcast) and whether the relay has it (`relay.announced`):

1. The agent that delivers it, as the configuration plans it: its pinned publisher, or with none the active agent whose
   MediaMTX gateway its upstream is on, while that agent runs a gateway. It covers the exposure whether or not it can
   publish it right now (a camera switched off, an upstream it cannot read).
2. Otherwise the organisation's **oldest active agent** (the lowest ID: IDs are UUIDv7): an exposure a browser
   publishes straight to the relay, one whose upstream no agent delivers, one pinned to a device that runs no gateway.
   It need not run a gateway itself.

The fallback is chosen from rows alone, never from who is online or reporting, so every agent that asks works out the
same answer, and it changes only when that agent is removed or stops being its network's active agent. An agent that is
off is still chosen; then nothing reports about what it covers, and those exposures read as nothing reporting, as they
did before. The oldest is the one most likely to be a standing site box rather than a laptop added later.

Two agents can both believe they cover an exposure, for at most a configuration interval each (about half a minute),
when the fallback changes: the one leaving has not asked again yet, the one arriving already has. Both read the same
relay, so their opinions agree; each is one reporter's opinion, the subject's state is the worst of the fresh ones, and
the one no longer told to stops reporting and goes stale. A gap the other way, neither reporting, lasts as long.

`deviceConfiguration.get` v4 tells the covering agent `relays`: the stats to read (`stats`), and each exposure it covers
but does not publish (`watched`), with a `connect` ask to read it (`action: read`), which
`organisations.streams.exposures.connect` grants the covering agent alone. It reads only the broadcast's catalog back through the relay, as it
does for what it publishes (apps/agent/core/src/gateway/relay-traffic/runtime.ts): for an exposure it only watches,
being announced is the only sign anyone is publishing it at all. Its traffic is charted, never judged: a relay asks a
publisher only for what viewers take, so little received says only that little was watched. Versions 1 to 3 still name
the stats of the gateways an agent publishes to inside `mediamtx`, and those agents report only what they publish.

A publisher that is the studio's own code (a browser) may report as a second opinion; an encoder cannot. The browser
files no reports yet: it would sign as its own device for each, and what it would say (bitrate, frame rate) the gateway
already does.

A pushed stream's exposures are judged only while someone publishes them (src/health/exposure.ts): its ingest path
while it is ready, its relay while it is announced. Until then they are `idle`, not down, so a phone nobody is
streaming from raises nothing. Any other exposure the relay does not have is unhealthy, whoever covers it, unless its camera is switched off.

## Reads for a show

### What an output cannot reach

`organisations.shows.get` v2 answers `unreachable: [{ outputId, inputGatewayId, streamIds }]`: one entry for each
output following the show that has an agent, oldest first, naming the streams the show needs that its agent reaches no
delivery of (empty when it reaches them all). An output with no agent reads nothing, so it is left out rather than
listed as reaching everything. What the show needs is what it places with its takeover off air (`neededStreams`,
src/shows/resolve.ts): the cameras on screen, the armed stream, and each stream one of those brings the sound of, so a
live takeover does not hide the cameras it hands back to. A stream counts only when it has deliveries and none passes
`reachable` (src/gateways/delivery.ts) for the agent's network and the output's input gateway, as its reads are chosen
and admitted (`deviceReader`, src/gateways/connect.ts); a stream with none at all is already `undelivered`. Protocols
are not considered, since which an agent asks with is its own. It is read in the member's own transaction with the rest
of the show: members read the whole topology.

The output still places such a stream, so its card shows there. The show's controls warn on its lineup row, its slot in
the layout map (an icon, and the slot's label for assistive technology) and the armed takeover: "‹Output› cannot reach
this camera: it reads only from ‹gateway›." when the output names one, and otherwise "…: the camera is delivered only
on another site." What changes it (an output's agent or input gateway, a delivery, a gateway's network) reaches the
controls through the show's read, which is asked again every half minute and whenever the show is composed again; a
change to an output's agent, input gateway or show from the studio reads the shows again at once. On an output's page,
**Reads streams from** shows Automatic or the gateway, and an administrator chooses among Automatic, conservation.tv
and the organisation's own gateways, the ones `organisations.outputs.update` takes.

### How long a read lasts

Every MoQ read an output's agent holds lasts an hour (`CONNECTION_LIFETIME_SECONDS`), and the relay ends a session when
its token expires, so each renewal restarts that stream's `moq export`: a flash of its card on air, kept apart from the
others' (apps/agent/core/src/output/obs/relay.ts). A read pulled from a MediaMTX gateway is not affected: a pull reads on
past its token. A longer read for the streams a show places would make the flashes rarer, but it has not been made,
because the API decides what an output may read only when it issues a read, and nothing can take a read back yet.

What gatekeeper and the relay support today, from gatekeeper's code and tests:

- Every MoQ token is a recorded grant (`grants`, its ID the token's `jti`). The relay asks gatekeeper about every
  session on connect and again every `MOQ_REVALIDATE_SECONDS` (60); gatekeeper refuses a grant whose `revoked_at` is
  set, on connect and on revalidation (`assertGrantStands`, src/relays/moq.ts). Its unit test
  (test/moq-admission.test.ts, "closes sessions of a revoked grant at revalidation") checks only that gatekeeper's
  answer to a revalidation turns to 403. The controlplane tests (apps/controlplane/tests/moq-relay.test.ts) check, with
  a real relay, that a new session of a revoked grant is refused; none checks that a session already open is closed.
- Nothing sets `revoked_at` but a hand-written `update` (gatekeeper's README, Configuration): there is no revoke
  operation in gatekeeper's contract, and the studio API keeps no grant IDs, so it could not name the grant to revoke.

So, before the lifetime can rise:

1. Gatekeeper: a `grants.revoke` operation, for its consumer's own grants only, setting `revoked_at`; tested in
   test/moq-admission.test.ts that the next revalidation is refused.
2. A check, against a real relay (the controlplane tests), that a session open when its grant is revoked is closed
   within `MOQ_REVALIDATE_SECONDS`, not only refused on its next connect.
3. The studio API: record each read it issues an output's device for a stream (device, stream, grant ID, expiry), and
   revoke them when a sync of the show finds a stream no longer placed (`placedStreams`, in `ShowHost.sync()`), and when
   the output stops following the show, changes control, or moves to another device.
4. Then a lifetime of its own for those reads, beside `CONNECTION_LIFETIME_SECONDS` (src/gateways/provider.ts,
   conservationtv.ts, src/gatekeeper/grants.ts), and gatekeeper's `MAX_CREDENTIAL_LIFETIME_SECONDS` raised to match
   (apps/controlplane/gatekeeper/cloudflare.config.ts, `'3600'` for every environment). That also raises the least
   time between MoQ signing-key rotations: the controlplane stack drops the previous key at the next rotation
   (apps/controlplane/infrastructure/README.md), so they must be at least the new lifetime apart.
   `PROTOCOL_MAX_LIFETIME_SECONDS` (24 hours) caps it either way.

Deployed in that order: gatekeeper first, then the studio API recording and revoking, and only then the longer lifetime.

## Not checked yet

Nobody has seen any of this run with a browser stage, OBS, a phone or a deployed relay: what was checked is said where
it was, and everything else is only typechecked, linted and unit-tested.

- A show end to end: composed in the show's object, followed by an output's agent, and played in OBS from its inputs
  (cards, layouts, takeover, the lineup's order, chat's `!swap` and `!takeover`).
- Whether an OBS media source goes transparent, or holds its last frame, when its relay stalls.
- Whether OBS keeps an input playing in a scene that is not on programme.
- `fit="contain"` when a picture is not the shape its source declares.
- The relay's `/announced` answer from a deployed relay, and whether one node of a cluster announces what its peers
  have: it was read from moq-relay's source, never exercised.
- Sound in OBS and the studio: the composition's channels are checked, not what a target plays.
- A ladder end to end: `@moq/watch` switching between two encodes of one camera in one broadcast (see
  [Sizes](#sizes)). A browser publishing MoQ now sends two; never watched.
- Going live in a real browser, on a phone or a computer: nothing in the studio's publisher was run in one (camera
  permission, `@moq/publish` against the deployed relay, WHIP against an agent's MediaMTX, Safari's fallback on an
  iPhone).
- RTMPS from OBS: the same answers as RTMP, but not exercised (no certificate here).
- Sound from WHIP: MediaMTX's RTMP reader skips Opus (`skipping track 1 (Opus)`), so a browser or OBS publishing by
  WHIP is republished to conservation.tv without sound, and an output's agent pulling it from the gateway forwards it
  into OBS's input by RTMP without sound too. It is heard only by a WebRTC reader of the gateway itself. MoQ from a
  browser, and RTMP from OBS (AAC), carry it. Tried on 2026-11-26 with the pinned moq CLI (0.14.7), MediaMTX 1.21.2 and
  ffmpeg 8.1 pushing H.264 and Opus by WHIP: `moq import rtmp --connect` from the path gives a catalog with no audio;
  `moq import rtc --connect <path>/whep` (WHEP) starts an Opus track, but its session to MediaMTX never connected on
  loopback (MediaMTX: `deadline exceeded while waiting connection`) and the CLI exited. So there is no cheap fix with the
  pinned tools: it needs that WHEP route made to work and checked, or Opus turned into AAC (ffmpeg, which no agent
  carries).
- Who covers an exposure on the relay ([Health and stats without an agent](#health-and-stats-without-an-agent)): the
  fallback agent watching a browser's MoQ broadcast, and the health that follows, were never run against a relay.
- The studio since the last of these changes: Go live and encoder settings shown only to publishers, letting a member
  go live from the Members settings, the takeover's sound control, and the stream, output, overview and device views
  reading each part's status from `organisations.status.get`. Typechecked and linted, never seen in a browser.
- The warnings of what an output cannot reach, and an output's **Reads streams from** setting: typechecked, linted and
  served by the scenarios' `site-only` world, never seen in a browser.
- Revoking reads: nothing does yet ([How long a read lasts](#how-long-a-read-lasts)), so a show's reads still last
  an hour.
