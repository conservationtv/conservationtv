# The OBS agent, unattended

Sketch: an agent that is a show's output runs OBS without anyone at it. It owns OBS's profile, scene collection and
streaming lifecycle; OBS streams only to a MediaMTX of the agent's own, which forwards the program to the show's
channels (Twitch first) and keeps them live, with a slate, when OBS restarts. Channels are connected once, in the
studio, by OAuth.

```
                         studio API
        show DO ──WS──▶ ┌───────────────────────────── OBS agent ─────────────────────────────┐
  connected_channel ──▶ │  obs runtime                                                         │
  (twitch, OAuth)       │   ├─ OBS (portable, its profile + collection written by the agent)   │
                        │   │    vignette target ──▶ scenes      stream ──▶ rtmp://127.0.0.1/program
                        │   └─ program MediaMTX (agent-managed)                                │
                        │        path `program`: alwaysAvailable (slate.mp4 when OBS is gone)  │
                        │        forward ──▶ rtmps://ingest.global-contribute.live-video.net/app#<key>
                        └──────────────────────────────────────────────────────────────────────┘
```

## Why

- **Crashes happen.** OBS crashed after ~2h40 of scene churn in the first stress test (2026-11-08, a libobs
  `obs_scene_add` race). The agent restarted it in 8 s and the scene re-converged, but streaming had been started by
  hand, so Twitch went offline until someone pressed Start. Treat OBS as a process that will die, and make every
  piece of its state something the agent can write again.
- **Viewers shouldn't see it.** With OBS streaming to Twitch directly, any OBS restart ends the broadcast (and
  Twitch's VOD). Put a relay between them that never disconnects from Twitch: OBS can come and go behind it.
- **Credentials don't belong on the machine.** The stream key comes from the studio, per channel, when it's needed.

## 1. The agent owns OBS's configuration

Everything OBS reads is written by the agent before each launch, under its config folder (`settings.ts` already
writes obs-websocket, `user.ini` and clears the crash sentinel):

- **Profile** `basic/profiles/vignette/`:
  - `basic.ini`: output mode Advanced, with the encoding below (section 2, "Encoding"): the program is forwarded to
    Twitch without re-encoding, so what OBS encodes is what Twitch receives.
  - `service.json`: a custom RTMP server, `rtmp://127.0.0.1:<program port>/program`, no key. OBS never sees a
    channel's credentials.
- **Scene collection** `basic/scenes/vignette.json`: an empty collection; vignette's target owns the scenes it
  creates (`vignette/<show>/…`). The agent never edits scenes; the show does.
- **Launch**: `--profile vignette --collection vignette --startstreaming`, plus today's flags. `--startstreaming`
  makes "streaming" part of OBS being up: a restarted OBS streams again on its own.
- **Lifecycle** in the runtime: OBS is healthy when obs-websocket answers *and* `GetStreamStatus.outputActive`; if the
  output stops while OBS runs (it gave up reconnecting to MediaMTX, say), call `StartStream`; if OBS dies, the
  process supervisor restarts it (as now) and `--startstreaming` resumes the stream.
- **Spec**: the `obs` section gains what the profile needs, so it's the API's to decide, not the machine's:
  `{ show, output: { width, height, fps, bitrateKbps, keyframeSeconds } }` (from the show's canvas and the output's
  settings).

## 2. A program MediaMTX of the obs runtime's own

The obs runtime runs a second MediaMTX (separate directory, ports and config from the `mediamtx` runtime's gateway), with
the same binary manifest, `BinaryStore`, `AttachedProcess` and config builders (`packages/mediamtx`) the gateway runtime
uses. One path:

```yaml
paths:
  program:
    # OBS publishes here over RTMP from 127.0.0.1; nothing else may.
    alwaysAvailable: true
    alwaysAvailableFile: /…/obs/slate.mp4      # "We'll be right back", H.264/AAC matching the output profile
    forward:
      - dest: rtmps://ingest.global-contribute.live-video.net/app#<stream key>
      # - dest: moqt://…  the program to conservation.tv's relay, as a stream of the organisation
```

- **Never offline.** While OBS is up, `program` carries its stream; when OBS's RTMP connection drops, MediaMTX plays
  the slate on repeat (`alwaysAvailable`), so the forward to Twitch never ends. When OBS reconnects it takes over.
  Twitch sees one continuous broadcast.
- **Slate.** MediaMTX joins the offline segment and the live stream *without re-encoding any frame*
  ([always-available](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/08-always-available.md)),
  so the slate MP4 must be interchangeable with OBS's output (see "Encoding"). The agent renders it once per output
  profile with ffmpeg (or OBS itself), from a still or a short loop, and keeps it beside the MediaMTX config. Later it
  could be the show's own "be right back" scene, rendered to MP4.
- **Forwarding** is MediaMTX's native `forward` (RTMP(S) with `#streamKey`, SRT, WHIP, MoQ): no ffmpeg, no
  re-encoding ([forward](https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/11-forward.md)). Each
  connected channel of the show is a `forward` entry; adding YouTube or a second Twitch is another entry. Twitch's
  ingest per MediaMTX's guide is `rtmps://ingest.global-contribute.live-video.net/app#<key>` (check Twitch's
  recommended ingests; the studio can pick one, see section 3). A destination that needs different encoding (a lower
  bitrate for a second channel, say) would need ffmpeg in `runOnAvailable` instead, which MediaMTX's guide covers.

### Encoding

One encoding has to satisfy Twitch, every other forward, and the slate, because nothing re-encodes after OBS:

- **Video:** H.264 (High profile; Twitch's transcodes expect H.264), CBR, keyframe every 2 s (Twitch requires ≤ 2 s;
  also lets the switch between slate and live land on a keyframe quickly), no more than Twitch's ingest limit
  (~6000 kbps for most channels; 8000 with Enhanced Broadcasting), at the show canvas: 1920×1080 at 30 fps today.
- **Audio:** AAC-LC, 48 kHz, stereo, always present, even when silent. YouTube silently rejects video-only streams
  (per MediaMTX's guide) and Twitch's player expects audio; the slate must carry the same audio track.
- **The slate matches exactly:** same codec and profile, resolution, frame rate and audio track
  (`alwaysAvailableTracks`: H264 + MPEG4Audio 48000/2), short GOP, starting on a keyframe. A mismatch (different
  resolution or audio layout) reaches Twitch as a mid-stream format change, which its transcoder handles badly.
- The output profile is in the plan (`obs.output`), and both OBS's `basic.ini` and the slate are generated from it, so
  they can't drift apart.
- **Admission.** Bind the RTMP listener to 127.0.0.1 and admit only publishers to `program` from localhost (the
  gateway runtime's `auth.ts` pattern, with a local-only rule); no readers but the forwards, and the agent's own
  metrics.
- **Status and metrics.** The runtime reports the `program` path's ready state, ingest bitrate, "on slate" (source is
  the always-available segment), and each forward's state, through the same metrics shipping the gateway runtime has,
  so the studio sees "Twitch: live, on slate since 02:00:37".

## 3. Connected channels in the studio API

Built (first version) as two tables, so the stream key sits under a role of its own:

```
channel             id, organisation_id, kind ('twitch' | 'rtmp'), name,
                    external_id (Twitch broadcaster id), external_login, enabled, created_at
channel_credential  channel_id, organisation_id,
                    credentials  -- encrypted (src/db/encrypted.ts): OAuth tokens and expiry, or RTMP URL + key
                    updated_at
```

- **Who reads a key.** `channel_credential` is readable (and refreshable) only by `channelBroadcaster`: included in
  `organisationAdmin`, and granted to a show's output device for as long as it is the output (`syncBroadcasters`,
  after `organisations.show.output.set`/`delete`). Members see `channel` rows, never credentials; no trusted code
  reads a key. The studio UI never shows one.
- **Connect.** `organisations.channels.twitch.authorize` starts Twitch's OAuth authorization-code flow (scope
  `channel:read:stream_key`, state in the cache for 10 minutes); `/channels/twitch/callback` stores the tokens and the
  broadcaster, then returns to the studio's channels page. `organisations.channels.create` adds an RTMP(S) destination
  by hand. Every deployment has a Twitch application (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`; per stack, its
  `twitchClientId` and `twitchClientSecret`) whose redirect URLs include `<APP_URL>/channels/twitch/callback`.
- **Key on demand.** The plan never carries a key: `obs.forwards` is `[{ organisationId, channelId }]` for each enabled
  channel. The runtime calls `organisations.channels.ingest` (device-signed; row-level security admits only a
  `channelBroadcaster`), which for Twitch refreshes the tokens if due and reads the key from Helix, returning
  `rtmps://ingest.global-contribute.live-video.net/app` and the key. The runtime keeps it in memory and in the program
  MediaMTX's config (mode 0600), and asks again every 30 minutes.
- **Later:** `show_channel` (which channels a show forwards to, once shows aren't one per organisation), `youtube`,
  `conservationtv` (MoQ to the organisation's relay), a rendered slate in place of MediaMTX's offline segment, and
  reporting "on slate" and each forward's state.

## 4. Configuration, end to end

```jsonc
// deviceConfiguration.get, for a show's output (v2)
{
  "obs": {
    "show": { "id": "…", "url": "https://api…/organisations/…/show" },
    "output": { "width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 6000, "keyframeSeconds": 2 },
    "forwards": [{ "channelId": "…" }]
  }
}
```

The obs runtime then converges, in order: install OBS and MediaMTX; resolve each forward's ingest; write and (re)start
the program MediaMTX; write OBS's profile, collection, websocket config; ensure OBS is running and streaming; follow the
show. Each step is idempotent, so a crash of any piece is just the next convergence.

## Order of work

1. Profile + collection written by the agent, `--startstreaming`, and the "streaming" health rule (no MediaMTX yet;
   OBS streams to a hand-entered key). Fixes "a crash ends the broadcast until someone presses Start".
2. Program MediaMTX with `alwaysAvailable` + slate, OBS streaming to it, one `forward` from a key in the agent's config.
   Fixes "a crash ends the Twitch broadcast at all".
3. `connected_channel` + Twitch OAuth + `channels.ingest`, and `forwards` in the plan. Removes keys from machines.
4. Status: program/slate/forward state in the studio; more channel kinds.

## Open questions

- One OBS output per show, many shows per agent? (One OBS can only stream once; a second show needs a second OBS or a
  multi-output plugin.) Assume one show per OBS agent for now.
- Slate content: static image rendered to MP4 per output profile, or a show-defined "offline" scene?
- Audio: the cameras are muted today, so the program needs at least a silent AAC track (see "Encoding"), and later a
  deliberate mix.
- Should the program also go to conservation.tv's own relay (`forward: moqt://`), so the studio can watch the exact
  output?
