# Studio UI pass — 10 November 2026

An overnight pass over the studio web app (`apps/studio/web`): the placeholder navigation replaced, and a page for
everything the API already has. Branch `t3/studio-ui-pass`, cut from `main` at `b630f880`. **Nothing is committed.**

A walkthrough with the camera live: [`walkthrough.mp4`](2026-11-10-studio-ui-pass/walkthrough.mp4) (1440 × 900, under
two minutes). Every page has a screenshot beside it, at 1440 px wide and the page's full height, numbered in the
order of the [list below](#every-screenshot). They were taken with headless Chrome, signed in as you; its sessions were
signed out afterwards.

## Every screenshot

Serval Reserve was only looked at; the dialogs were opened in UI Sandbox and closed unsent. The invitation was
made for the picture and cancelled straight after.

1. [Overview, Serval Reserve](2026-11-10-studio-ui-pass/01-overview.png)
2. [Streams](2026-11-10-studio-ui-pass/02-streams.png)
3. [A stream: Configuration, with traffic](2026-11-10-studio-ui-pass/03-stream-configuration.png)
4. [A stream: Recording](2026-11-10-studio-ui-pass/04-stream-recording.png)
5. [A stream: Outputs, on the internet and on Hide LAN](2026-11-10-studio-ui-pass/05-stream-outputs.png)
   - [WebRTC's endpoint and bearer token](2026-11-10-studio-ui-pass/05c-webrtc-dialog.png)
   - [WebRTC opened in the browser](2026-11-10-studio-ui-pass/05d-webrtc-in-browser.png)
6. [A stream, watching live](2026-11-10-studio-ui-pass/06-stream-watch-live.png)
7. [Show, with Sent out by](2026-11-10-studio-ui-pass/07-show.png)
8. [Channels](2026-11-10-studio-ui-pass/08-channels.png)
9. [Networks](2026-11-10-studio-ui-pass/09-networks.png)
10. [Agents](2026-11-10-studio-ui-pass/10-agents.png)
11. [An agent, read live over iroh](2026-11-10-studio-ui-pass/11-agent-live.png)
12. [Cameras](2026-11-10-studio-ui-pass/12-cameras.png)
13. [A camera](2026-11-10-studio-ui-pass/13-camera.png)
14. [Gateways, with where one is reachable](2026-11-10-studio-ui-pass/14-gateways.png)
15. [Devices](2026-11-10-studio-ui-pass/15-devices.png)
16. [Publishers](2026-11-10-studio-ui-pass/16-publishers.png)
17. [Organisation settings: General](2026-11-10-studio-ui-pass/17-settings-general.png)
18. [Organisation settings: Members](2026-11-10-studio-ui-pass/18-settings-members.png)
19. [Organisation settings: Roles](2026-11-10-studio-ui-pass/19-settings-roles.png)
20. [Overview, UI Sandbox (still setting up)](2026-11-10-studio-ui-pass/20-sandbox-overview.png)
21. [New stream](2026-11-10-studio-ui-pass/21-stream-new.png)
22. [Add camera](2026-11-10-studio-ui-pass/22-add-camera-dialog.png)
23. [Add network](2026-11-10-studio-ui-pass/23-add-network-dialog.png)
24. [Invite](2026-11-10-studio-ui-pass/24-invite-dialog.png)
25. [An agent that isn’t running](2026-11-10-studio-ui-pass/25-agent-unreachable.png)
26. [Your account](2026-11-10-studio-ui-pass/26-account.png)
27. [New organisation](2026-11-10-studio-ui-pass/27-organisation-new.png)
28. [The about page, signed in](2026-11-10-studio-ui-pass/28-about-signed-in.png)
29. [An invitation’s page](2026-11-10-studio-ui-pass/29-invitation.png)

## What state it is in

- `pnpm --filter @conservationtv/web typecheck`, `pnpm exec oxlint apps/studio/web/src packages/ui`,
  `oxfmt --check` and the studio API's typecheck all pass. `react-router build` succeeds and emits the iroh
  WebAssembly module and its shared worker as assets.
- No lint rule is disabled anywhere new. No `useQuery`, loader, `useMemo`, or test file was added. The one
  `useQuery` is still the about page's account menu, under its existing approval.
- Every page was opened in the browser against the local `dev:staging` stack. Every create, edit and delete was
  exercised in a second organisation made for the night (below); Serval Reserve was only looked at.
- Not checked: any page as a non-administrator (there is only one account), sign-out, the deployed build, and the
  things listed under [Not verified](#not-verified).

## How it was done

I built the foundations, then gave three slices to Opus 5.5 delegates working in the same checkout against a
written brief (the conventions from our earlier sessions, a reference page, the rules for the two organisations).
A fourth delegate reviewed the whole diff read-only, and I fixed what it found.

| Slice                                                                                                            | Who      |
| ---------------------------------------------------------------------------------------------------------------- | -------- |
| Navigation, page parts, queries for every resource, overview, networks, agents, iroh, pins, show output, cleanup | lead     |
| Organisation settings, members, roles, account, invitation, new organisation, home                               | delegate |
| Cameras, camera, gateways, devices, publishers                                                                   | delegate |
| Stream page, new stream                                                                                          | delegate |
| Review of the diff: 20 findings                                                                                  | delegate |

## Calling agents from the browser, over iroh

The agent page's "Right now" section is the agent's own answer to `system.get`, read with the agent SDK over
`@strangecyan/iroh-http-browser`. Nothing passes through the studio API except the request for the relay.

![An agent's page, with its machine and runtimes read from the agent](2026-11-10-studio-ui-pass/11-agent-live.png)

1. `organisations.browser.ensure` gives this auth session's browser device, with its key.
2. As that device, signed, `irohSessions.create` leases its endpoint on the relay.
3. **`createSharedEndpoint`** binds the endpoint in a SharedWorker named for the key, so every tab of the session
   shares one endpoint (iroh admits one per ID to a relay). A tab-owned endpoint is the fallback only where
   `SharedWorker` doesn't exist. In the preview browser it took the shared path: the WebAssembly loads in the worker,
   not the tab.
4. The browser binding dials tickets only, where the Node binding takes an ID and relay URL. `src/lib/iroh-ticket.ts`
   writes the ticket for "this public ID on this relay". Its output matches `EndpointTicket.fromAddr(new
EndpointAddr(id, relayUrl))` byte for byte (checked against the Node binding by me and again by the reviewer).
5. `askAgent(organisationId, publicId, agent => agent.system.get.v1())` keeps one connection per agent.

First answer from the Hide agent arrived in about half a second. An agent that is off shows "Can't reach this agent"
after a 15-second dial timeout and is retried every 20 seconds.

What it needed outside the web app, all of which want your eye:

- **`apps/studio/api/src/app.ts`**: the CORS allow-list gains `Content-Digest`, `Signature` and `Signature-Input`, so a
  browser can sign as its device. No operation changed shape.
- **Dependencies**: `@strangecyan/iroh-http-browser` 0.3.0 on the catalog (and in `minimumReleaseAgeExclude`, beside
  its siblings), and `@conservationtv/agent-sdk` in the web app.
- **`vite.config.ts`**: the iroh package is excluded from pre-bundling, because it finds its WebAssembly and worker
  beside itself with `import.meta.url`.

After the review: connections are closed when a call over them fails; a dial that fails for any reason other than
"no answer" lets the endpoint go so the next call rebinds; the device's private key is read inside the connection
module and never enters the query cache; and a change of signed-in account closes everything, so nothing dials as
the last account's device.

Known limits:

- If the SharedWorker's own endpoint dies, a rebind attaches to the same worker; only closing every tab replaces it.
  That is the library's design.
- Agents still admit every peer (`decide(undefined, …)` in `apps/agent/core`), so today any device on the relay
  can ask. The browser path doesn't change that, but it makes it more reachable.
- Only `system.get` is used. `system.spec` is one line away.

## Navigation

- The sidebar's Playground / Models / Projects placeholders are gone, with `components/blocks/sidebar-07`, `-09`,
  `-16`, the preview pages, the theme sample and the pins stand-in. The sidebar is now Overview, Streams, Show,
  Channels, then Infrastructure (Networks, Agents, Cameras, Gateways, Publishers, Devices), with Organisation settings
  and a working organisation switcher at the foot.
- The rail's four identical gear icons are replaced by home, **real pins**, your account and a sign-out that signs
  out. A pin button sits top-right on stream, camera and agent pages. Pins live in this browser's local storage
  (`studio.pins`), through the same this-device query pattern as known accounts, because the API has nowhere to keep
  them. Deleting a pinned thing unpins it; a pin's label doesn't follow a rename.
- The about page's menu shows those pins and an "Open studio" link instead of two placeholder gears.
- `/account`, `/organisations/new` and the no-organisation home sit under a new pathless `page-layout` route that
  gives them the scroll region the organisation layout gives its pages.

## The pages

![The organisation overview](2026-11-10-studio-ui-pass/01-overview.png)

**Overview** — counts that link to their pages, a setup checklist while anything is missing, what is failing, and
previews of up to three fed streams.

**Networks** — the reference page the delegates copied: list, add, rename, delete, and an inline active-agent select.

**Agents** — by network, active first. The agent page has the live section above, its facts, the environment to start
it with (the secret key is fetched only on pressing the button and never cached), edit, make active, remove.

**Streams** — the list gained "New stream" and links into each stream.

![A stream's page](2026-11-10-studio-ui-pass/03-stream-configuration.png)

The stream page follows your first sketch: back link, title with status, pin, line tabs, "Watch live". Configuration
draws the existing topology and lists each delivery as an editable row grouped by network then internet. Recording
lists recorders. Outputs lists the internet-side deliveries. Traffic is the existing chart, larger.
[Recording](2026-11-10-studio-ui-pass/04-stream-recording.png) ·
[Outputs](2026-11-10-studio-ui-pass/05-stream-outputs.png) ·
[Watch live](2026-11-10-studio-ui-pass/06-stream-watch-live.png)

![Create new stream](2026-11-10-studio-ui-pass/21-stream-new.png)

New stream follows the second sketch: source as radio cards, a searchable camera picker with "Add new" (which adds a
camera in a dialog over the form, at `streams/new/camera`, and chooses it), then where
it is delivered from the start. It creates the
stream, then its exposures in order. If a delivery fails after the stream exists, you land on the stream with a note
of what failed rather than a form that would make a second stream.

**Cameras** — list with state, how each is reached and its streams; add dialog with an Axis / RTSP choice. The camera
page has a live preview from its stream, facts, settings, credentials (replace or clear, never shown), state, delete.
[List](2026-11-10-studio-ui-pass/12-cameras.png) ·
[Camera](2026-11-10-studio-ui-pass/13-camera.png) ·
[Add](2026-11-10-studio-ui-pass/22-add-camera-dialog.png)

**Gateways** — conservation.tv as built-in and read-only, then your MediaMTX gateways with where each is reachable
now (read only when a row is expanded) and its URL overrides.
[Gateways](2026-11-10-studio-ui-pass/14-gateways.png)

**Devices** — every device in a table with kind tabs, rename and move, and a details dialog with reported addresses.
[Devices](2026-11-10-studio-ui-pass/15-devices.png)

**Publishers** — what publishes what to where: each delivery with a pinned publisher, grouped by device.
[Publishers](2026-11-10-studio-ui-pass/16-publishers.png)

[**Show**](2026-11-10-studio-ui-pass/07-show.png) — gained "Sent out by": the agent that runs OBS for the show, as a select for administrators. It
type-checks and renders; I did not change it in Serval Reserve, for obvious reasons.

**Organisation settings** — a layout route with General / Members / Roles as route tabs.
[General](2026-11-10-studio-ui-pass/17-settings-general.png) ·
[Members](2026-11-10-studio-ui-pass/18-settings-members.png) ·
[Roles](2026-11-10-studio-ui-pass/19-settings-roles.png)

- General: rename, your display name there, facts, leave, delete.
- Members: the directory, make or remove an administrator, remove a member, invitations with an Invite dialog.
- Roles: read-only. What each role may do (from `db/roles.ts`) and who holds it. Administrator is the only role
  granted by hand, and the page says so rather than drawing a permission matrix that does nothing.

**Account** — rebuilt as a page in the app: profile, passkeys (behaviour untouched), your organisations, invitations
waiting for you, sign out. [Account](2026-11-10-studio-ui-pass/26-account.png)

**Invitation** (`/invitations/:id?code=`) and **New organisation**.
[Invitation](2026-11-10-studio-ui-pass/29-invitation.png) ·
[New organisation](2026-11-10-studio-ui-pass/27-organisation-new.png)

## What your sketches show that the API doesn't have

None of these are in the UI. Nothing is faked.

- An enabled/disabled switch on a delivery. Adding and removing an exposure is the only on/off.
- A bitrate cap ("20Mb/s max"), retention, local versus archive storage, "Playback: local viewers".
- A protocol badge for internet gateways.
- Separate traffic charts per network and for the internet. There is one chart, already split.
- Recording archives. **Nothing acts on a recorder today**: kinds are free text and neither the configuration
  builders nor the agent read them. The Recording tab says so. Your topology component still draws a red
  "RECORDING" label beside any delivery with a recorder; I left your component alone, but it overstates.
- "Custom" as a third source. A raw RTSP source is a camera with the `rtsp` driver, so the picker points there.
- The third sketch (PTZ, presets, layouts) has no API at all.

Other gaps the pages ran into:

- **No health data.** `organisations.subjects.states.list` returns `[]` for both organisations, so every status reads
  "No reports". All of it is wired to `device:` and `exposure:` subjects and none of it has been seen with real states.
- The member directory has no email addresses, and **invitations are only written to the API's log**
  (`delivery.ts`). The Invite dialog says that.
- Only global administrators can delete an organisation and the client can't tell who they are, so Delete is offered
  to administrators and shows the refusal.
- "Still in use" refusals are generic ("The resource is still used by another resource").
- An agent's network can't change (409). The first draft of the agent's edit dialog offered it; it no longer does.
- `devices.listAddresses` is documented as preferred-first; Serval's agent returns its preferred address last. The
  pages sort on the client.
- Pins have no API.

## Things I changed that you didn't ask for

- **`cn` was dropping your type sizes.** `text-custom-13` followed by a text colour was merged as two colours and the
  size was thrown away, in your existing `StreamCardTitle` and `StreamCardNote` too. `packages/ui/src/lib/utils.ts`
  now teaches the merge the custom scale, and every kit component uses it (see Confirm dialogs). Stream card titles are back to 17px, which you will see.
- The Streams page's description was placeholder copy about HLS/DASH and instant replay. It now says what the page
  shows.
- `stream-page.ts` exports `isFed`, so the overview and the streams page agree on which streams are "being fed".
- `stream-chart.tsx` gained an optional `className` and a `StreamChartLegend` export.
- `oxlint.config.ts`: the vendored-files entry for the deleted `components/blocks` is removed.
- Dialogs in the kit have no maximum height; the tall ones carry `max-h-[calc(100dvh-2rem)] overflow-y-auto`
  locally. That probably belongs in `packages/ui`.

## Confirm dialogs

Every delete or clear is the kit's `AlertDialog` composed in place, with its own words; there are 11. The wiring they
repeated (open state, forgetting the last refusal, closing on success) is `useDialog(mutation)` (`hooks/use-dialog.ts`,
first written as `useConfirm`, now shared with every form dialog; see Addresses and dialogs below):
`<AlertDialog {...dialog.props}>`, and `dialog.mutate(variables, options)` on the action, the error and pending state
still read from the mutation. The kit's alert dialog is roomier (384 px,
24 px padding) and its description 13 px at a 1.4 line height.

That description first came out too large, which found a wider bug: the kit's components merged classes with the
stock `cn`, which doesn't know the custom type scale, so `text-custom-*` beside a text colour was taken for a colour,
the size never applied and the colour was dropped. All 58 components now import the configured `cn`
(`@conservationtv/ui/lib/utils`, which the shadcn config's `utils` alias already names). Every custom size passed to a
kit component now applies: page tabs, for one, are 13 px as written, their inactive ones muted again. Checked in headless Chrome: Cancel closes it; a refusal keeps it open with the
API's reason; reopening starts clean; a success closes it. ([screenshot](2026-11-10-studio-ui-pass/confirm-dialog.png))

## Addresses and dialogs

After review on the PR, what was only in memory and was really navigation now lives in the address:

- **Tabs** are query parameters, through nuqs (`NuqsAdapter` in `root.tsx`, `hooks/use-tabs-query.ts`): a stream's
  `?tab=recording|outputs`, the streams list's `?status=inactive`, devices' `?kind=agent|camera|browser`. The default
  tab is left out of the address. A stream's live preview is `?watch=true`, so a link can open it playing. Settings'
  tabs were already routes.
- **Dialogs that create something** are child routes over their list, rendered through an `<Outlet />`:
  `agents/new`, `cameras/new`, `networks/new`, `gateways/new`, `channels/rtmp/new`, `settings/members/invite`, and
  `streams/new/camera`. Their buttons are links. `useDialog(mutation, { closeTo: '..' })` opens such a dialog from the
  start and, once it has finished closing, steps back in history (or, opened by its address, replaces it with the
  page beneath). A new agent replaces the dialog with its own page.
- **Adding a camera while creating a stream** no longer leaves the form: the dialog opens over it, the form keeps what
  was filled in, and the new camera is chosen through the outlet's context. The outlet sits outside the stream's
  `<form>`, since a portal's submit would otherwise bubble into it.
- **Every form dialog** (edit, rename, add delivery or recorder, replace credentials, accept an invitation) uses the
  same `useDialog`, with `onOpen: () => form.reset()` where its form starts from what is stored.

Still in memory, on purpose: edit, rename and delete dialogs, which belong to one row and aren't somewhere to go; a
player's chosen rendition (`read-parts.tsx`, `local-read.tsx`, `output-read.tsx`); the new-stream form's own values;
and the dismissed delivery-failure note.

## What the review found, and what happened to it

Fixed: the agent network move; a delivery form that could submit a rendition whose checkbox had disappeared; the
iroh items above; "Not reporting" shown for an agent reporting unhealthy; publishers counting deliveries as streams;
"Source" and "Original" as two names for one rendition; nothing highlighted in the sidebar on the Roles tab; pins
outliving deletes; "Live now" claiming more than it knew (now "Being fed"); three pages wrapping themselves in a
scroll region; four back links and three not-found states (now one `BackLink` and one pattern); subject IDs built by
hand in six places; three pluralisers; duplicated constants; two different publisher choice lists; dead exports; a
"not found" flash after deleting from a detail page; a possible duplicate stream after a failed create.

Left as they are:

- Some duplicate type declarations across slices (`ListedGateway` in two modules, the camera state and rendition
  enums repeated between `forms/schemas.ts` and the components). Harmless, but you will notice.
- `invitation.tsx` exports a route `ErrorBoundary` to turn the API's 404 for a used or expired invitation into a
  card. It is not a loader, but it is a pattern the app didn't have. Your call.
- The form schemas are slightly stricter than the API in three places: an Axis host must be http(s), gateway URL
  overrides are checked against the schemes in `mediamtx-protocols.ts`, and an RTSP URL with credentials in it is
  refused so they don't land in settings every member can read.

## Gateway hostnames, the morning after

You asked whether giving an agent a domain was implemented. It was, on `main` since `8fba23d7`: a MediaMTX gateway
gets `<gateway>.<organisation>.<GATEWAY_DOMAIN>`, an A record at the agent's preferred address, and a Let's Encrypt
certificate, all while its agent asks for its configuration; the agent then serves TLS and registers its endpoints
under the name. Nothing showed it, and it had never run here. Both are now done.

![The Gateways page, with the gateway's hostname and certificate](2026-11-10-studio-ui-pass/14-gateways.png)

**In the API.** `organisations.gateways.list` and `.get` give each of the organisation's own gateways `tls`: its
`hostname`, the `address` it points at, the certificate's `issuedAt` and `notAfter`, and the last `attemptedAt` with its
`error`; null until it has a hostname. It is the same v1 operation with a field added, read through a left join on
`gateway_certificate` (which members could already read under its RLS), and nothing outside the web app calls these
reads. The contract, SDK and CLI are regenerated. The Gateways page shows the hostname with a copy button, how the
certificate stands, where it points, and why the last attempt failed when it has.

**Switching it on locally** took a config change and three fixes, all in `apps/studio/api`:

1. `cf dev` hands the Worker only the secrets the config declares, and #90 undeclared `CLOUDFLARE_API_TOKEN` and
   `ACME_ACCOUNT_KEY` so releases needn't upload them. With `GATEWAY_DOMAIN` set the API refused every request ("must
   be set when GATEWAY_DOMAIN is"); I reverted at once and the dev API was down for a minute or two. `cloudflare.config.ts`
   now declares the two only where `GATEWAY_DOMAIN` is set, which CI never does, so releases are unchanged.
2. **A bug on `main`** in `acme.ts`: a stored certificate key's public half was imported from its private JWK with `d`
   removed but `key_ops: ["sign"]` kept, which Web Crypto refuses for `verify`. Every issue for a gateway with a key
   failed. `key_ops` is dropped too.
3. **Another on `main`**: every challenge Let's Encrypt offers had to have a `token`, and it now offers types without
   one beside dns-01, so the whole authorization failed to parse. The token is optional, and required of the dns-01
   challenge that is used.
4. **And a third**: the TXT record was made and the authority told to look at once, before Cloudflare served it, so it
   found NXDOMAIN. It now waits `RECORD_PROPAGATION_MS` (20 s; I measured 9 s to the zone's own nameserver) first. I
   tried looking for the record through a public resolver instead, which made it worse: asked before the record
   exists, a resolver keeps the NXDOMAIN for the zone's negative TTL, 30 minutes. Issuing is rare and the agent keeps
   serving meanwhile, so the 20 s only lengthens that one ask.
5. A failed attempt recorded only the API failure's category ("cannot be connected to right now"); it now records
   the cause, which is what the page shows.

Then it worked: `hide-mediamtx.serval-reserve.conservationtv.net` points at `192.168.4.43`, its certificate was issued
at 12:16 and runs to 13 January 2027, MediaMTX serves it, and the agent registers HLS, WebRTC, RTSPS and RTMPS under the
name. Both cameras stayed live through the change.

That first certificate came from **Let's Encrypt's staging authority**, the config's default for development, which
browsers don't trust. `.env.staging.local` now sets `ACME_DIRECTORY_URL` to the production directory, and I deleted the
staging certificate (keeping the hostname and its key) and let the API issue again: a trusted certificate from Let's
Encrypt (issuer YE2), issued at 12:38 and valid to 8 February 2027. curl and openssl verify it against the system's
trust store on HLS, WebRTC, RTSPS and RTMPS. The API renews it once it is within 48 hours of expiring.

**Outputs, the network's side.** A stream's Outputs tab lists each network's delivery beneath the internet one, under
"On Hide LAN", saying only readers on that network reach it. Every MediaMTX address needs a read token: the agent lets
loopback in as it is and anyone else only with a token the API signed for that gateway, path and action
(`runtimes/mediamtx/auth.ts`); I checked each protocol refuses without one and plays with one. So instead of
addresses, each protocol (for the rendition chosen above) has a button per way to reach the gateway, its hostname and
the IP it points at (the agent's preferred address, for when DNS doesn't resolve the name):

- RTSP, RTSPS, RTMP, RTMPS and HLS copy the whole working URL, the token in it as `?jwt=`. Copied through the clipboard
  in headless Chrome, all three I tried (RTSP by hostname and by IP, HLS) play in ffprobe at 1280×720.
- WebRTC opens a dialog with the WHEP endpoint and the bearer token to copy, and **Open in browser** opens MediaMTX's
  own WebRTC player for the feed in a new tab, which played in headless Chrome.
- The renditions are compact line tabs inside the delivery's card, its rows running edge to edge beneath them
  ([Data saver](2026-11-10-studio-ui-pass/05b-stream-outputs-data-saver.png)). The tabs are the kit's own line tabs at a new `size="sm"`
  (`packages/ui` `tabs.tsx` and `tabs-variants.ts`), and `DeliveryRow` is now composed (`DeliveryRow` the card,
  `DeliverySummary` its header, `Renditions` added where wanted) so this card can carry tabs instead of badges.
- Nothing moves while it loads. Each tab needs six `exposures.connect` calls, one per protocol (the six tokens are
  interchangeable: the API signs them for the gateway, `read` and the path, not the protocol). A row's name and use show
  at once and only its buttons wait, behind a placeholder their height; the tab moves at once and the rows change in a
  `useTransition`, the old ones staying until the new are ready. Measured in headless Chrome, the card held one height throughout.
- The conservation.tv card has the same layout: its renditions as tabs, and a MoQ row with **Relay URL** (copied with
  a read token in it) and **Broadcast** buttons. One MoQ connection carries every rendition as a track, so its row is
  the same under each tab. The tabs, rows and copy hook are shared parts (`components/streams/read-parts.tsx`,
  `hooks/use-copy.ts`).
- An encrypted protocol at the IP is marked: its certificate names only the hostname.
- Each button's tooltip says how to use it (what to paste it into), why you'd reach the gateway that way, the
  certificate caveat where it applies, and that the token lasts an hour, rather than repeating the URL.
  ([RTSP by hostname](2026-11-10-studio-ui-pass/tooltip-rtsp-hostname.png) · [HLS by IP](2026-11-10-studio-ui-pass/tooltip-hls-ip.png))

The tokens are this account's read tokens from `exposures.connect`, kept in the query cache like the MoQ preview's
(so a copy is synchronous with the click, as the clipboard needs) and renewed five minutes before they expire; each lasts
an hour. ([Outputs](2026-11-10-studio-ui-pass/05-stream-outputs.png) · [WebRTC dialog](2026-11-10-studio-ui-pass/05c-webrtc-dialog.png) ·
[in the browser](2026-11-10-studio-ui-pass/05d-webrtc-in-browser.png))

**Hide MediaMTX's URL overrides are cleared.** It had four, all `localhost` (WebRTC, RTSP, RTMP, HLS), set when it was
made on 21 October, before agents registered their own addresses (29 October); `connect` lets an override win, so they
were shadowing the hostname. With them gone every protocol uses what the agent registers. They were
`{"hls":"http://localhost:8888","rtmp":"rtmp://localhost:1935","rtsp":"rtsp://localhost:8554","webrtc":"http://localhost:8889"}`,
should you want them back. Both streams kept publishing to conservation.tv through the change.

None of the four API fixes has a test, by your standing rule; each was checked by running it against Let's Encrypt and
Cloudflare, and the key fix also by a standalone Web Crypto check of before and after.

## Left behind on this machine

- **`UI Sandbox`** (`01a1c339-a711-72c1-b735-ce3957d2bcb2`): the organisation the writes were exercised in. It has a
  network, an agent, two cameras, two gateways and two streams.
- **`Throwaway from the UI pass`** (`01a1c347-3cd7-7cb5-a2db-43b6683a9a9f`): a delegate made it to test leave and
  delete for real, and the API refused both (last administrator; not a global administrator). It needs deleting by
  someone who is. The final rename to that name was submitted but not confirmed.
- **Axis Simulator's preferences.** Its one camera pointed at a scene folder in an earlier session's temp directory,
  which was gone, so the app was open and serving nothing. I pointed it at
  `~/Developer/axis-simulator/examples/tortoise-walking` and restarted it. The original is beside it as
  `prefs.json.before-ui-pass`.
- **`.env.staging.local`** now sets `GATEWAY_DOMAIN` and `CLOUDFLARE_ZONE_ID` (copied from `apps/studio/api/.env`),
  so `pnpm dev:staging` gives gateways hostnames, and `ACME_DIRECTORY_URL` to Let's Encrypt's production directory, so
  their certificates are trusted. Remove those lines to turn it off.
- **In your Cloudflare zone**: an A record, `hide-mediamtx.serval-reserve.conservationtv.net` → `192.168.4.43`. The
  challenge TXT records, and the probe record I made to measure propagation, were deleted.
- `pnpm dev:staging` is running in the background, including the local Hide agent, and Axis Simulator is open.
- The preview browser is signed in as you (I used the code from the local API log).
- `apps/studio/web/public/show/` was untracked before I started and is still there. It fails lint if you lint that
  directory.

## Not verified

- Anything as a non-administrator.
- Sign-out from the rail, and that it closes the iroh endpoint.
- The home page's empty state (the account is always in an organisation), and accepting or declining an invitation
  from the account page (the UI only invites by email, and those never appear in your own list).
- The invitation page's "expired" card, a successful gateway delete, the publishers empty state.
- The stream-created-but-delivery-failed path. The form blocks every case the API would refuse.
- The rendition pruning fix in the delivery form, beyond typecheck. The sandbox camera is RTSP, which offers only one.
- The show's "Sent out by" select, beyond rendering.
- The deployed build: that the web Worker serves the `.wasm` asset correctly.
