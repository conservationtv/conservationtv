# Studio scenarios

Generated worlds for the studio web app: organisations of any size and shape, healthy or falling over, served by a
mock of the studio API that checks every response against the contract. Use them to run the web app against topologies
no local environment has, and to screenshot every page of every world into a report, compared with an earlier one.

```sh
# Screenshot every named scenario and six random worlds, in light and dark, into reports/<branch>/index.html.
pnpm --filter @conservationtv/studio-scenarios report

# On main first, then on a branch, comparing with it: the report leads with what changed most.
git switch main && pnpm --filter @conservationtv/studio-scenarios report --build --label main
git switch my-branch && pnpm --filter @conservationtv/studio-scenarios report --build --baseline main

# A narrower run: some scenarios, some pages, one theme, phone-sized too.
pnpm --filter @conservationtv/studio-scenarios report --scenarios site-outage,large-estate --pages home,streams --themes dark --viewports desktop,mobile

# Work on the UI against a world, with the dev server's hot reload.
pnpm --filter @conservationtv/studio-scenarios dev large-estate

# Or browse the production build against any world: open http://127.0.0.1:6431/__scenario/<id>.
pnpm --filter @conservationtv/studio-scenarios serve

pnpm --filter @conservationtv/studio-scenarios list                 # the named scenarios
pnpm --filter @conservationtv/studio-scenarios scenarios world typical   # what a world holds, and what is wrong in it
```

`report --help` lists every option. Reports are written under `reports/`, which is ignored.

## On pull requests

The runner's scenarios report (`pnpm signoff scenarios`, [`tools/runner`](../../../tools/runner)) does what CI used to:
it builds the web app at the merge base and at the head, each in a worktree of its own commit with its own install (the
base's build kept by commit), captures both against the head's worlds and mock API so only the app differs, compares
them, and uploads `report.json` and the images to the review tool, which draws them as the pull request's **Screens**.
`pnpm signoff` makes it whenever the change touches the web app, the UI package, the SDKs, the studio API's contracts or
health rules, the shared packages they draw on, or this package; `pnpm signoff scenarios --pr <n>` makes it for any
pull request.

A pull request that changes an operation the web app reads changes the head's mock too, so the base's build may then
fail to read it: those pages show as changed, which is worth a look anyway.

## How it fits together

- **A world** (`src/world/`) is one organisation in the contract's own shapes (each list as its current version
  returns it): networks, agents, cameras, gateways, streams (with their short codes) and their deliveries, shows (their
  slots, mix and takeover) with each one's `show_stream` rows (lineup rank and mix), pushed streams people publish to
  (shared ones, and members' own from a phone or a computer) and which of their deliveries are being published to now,
  outputs (and the gateway each reads from), channels, chat commands (show ones too), members (some let publish), and
  every subject's health state. It is generated from a **spec** (`spec.ts`): a seed and a few knobs for scale, gaps
  (half-set-up things: streams with no camera, networks with no active agent, shows at no slots), how the shows are
  operated and who goes live (`operating`: none in the base spec), and health.
- **Shows** (`shows.ts`) are resolved by the API's own pure code (`apps/studio/api/src/shows/resolve.ts`, and
  `packages/shows` for what a state places), imported rather than copied, from facts made from the world as the API
  reads them: so the lineup, positions, what is not placed and why, the cards and what a show places (and so what its
  deliveries' health and the status are of) are the API's, as is which streams each output following it cannot reach
  (`apps/studio/api/src/shows/reach.ts`): `site-only` has some.
- **Health** (`health.ts`) picks root causes (an agent stops reporting, a camera stops answering, a gateway, programme,
  forward or channel fails) and lets each reach what depends on it as it would for real. A pushed stream's deliveries
  are judged only while someone publishes to them, and are idle otherwise; whether a delivery is live
  (`organisations.streams.live.list`) is read from its state, so the live list and the status agree. What those states
  add up to is worked out by the API's own status rule (`apps/studio/api/src/health/status.ts`), imported rather than
  copied.
- **Randomness is keyed by path**, not drawn in sequence: each entity draws from a stream seeded by the world's seed
  and where it sits (`network/2/camera/0`). Changing one part of the generator leaves everything else as it was, so a
  generator change doesn't make every screenshot differ.
- **The mock API** (`src/api/`) serves each world under `/w/<scenario>/`, so the unmodified web app is pointed at one by
  its API URL. It routes by the published OpenAPI document, answers the handshake and session, and projects each read
  from the world; every response is checked against the SDK's generated schema for its version, so a projection that
  drifts from the contract fails loudly (and the projections are typed with the SDK's output types, so it fails
  typecheck first). Writes and live connections (MoQ relays, agents over iroh, camera control) aren't simulated: they
  answer errors, which the report notes rather than counts against the page.
- **The capture** (`src/capture/`) serves the web app's production build beside the mock, and screenshots each page in a
  fresh browser context with the clock fixed at the world's moment, motion reduced and animations stopped, the window
  grown to fit the app's scrolling pane. Beside each shot it records console and page errors, failed API calls, anything
  the mock couldn't answer, an error boundary on screen, sideways scrolling and the page's accessibility snapshot.
  Against a baseline, each shot's rows are lined up with the baseline's first (`src/capture/align.ts`), so what only
  moved is told apart from what changed; the rest is pixel-diffed, the snapshots' lines that came and went say what
  changed in words, and the report sorts by how much changed.
- **Reuse** (`src/capture/reuse.ts`): a page draws the same whenever the browser runs the same code against the same
  mock, so `report --reuse` takes an earlier report's shot rather than capturing it when both were captured with the
  same `--captured-with` (the caller's fingerprint of the mock, worlds and capture code) and every file the page loaded
  is the same in both builds. Each report records its build's files and each shot's loaded files for that. Every theme
  of a page is shot from one load of it.

## Adding to it

- **A scenario**: add one to `NAMED_SCENARIOS` in `src/world/scenarios.ts`. `health.incidents` gives an exact number of
  failures of a kind; `faults` makes an operation hang or fail, for loading and error states; `operating` chances of 1
  (or 0) make every show, stream or member one way, for a scenario about one thing.
- **A knob or a field**: draw it from a child stream of its own, named for what it decides (`rng.child('takeover')`),
  never from a sequence that is already drawn from, so everything already generated keeps its IDs, names and health. A
  draw that is no longer needed is still drawn and thrown away, with a comment saying why.
- **A page**: add it to `src/capture/pages.ts`.
- **An operation the web app starts reading**: add its projection to `src/api/projections.ts`, and drop the projection
  of a version it no longer reads: the map holds only what the web app reads. Until then the report shows it as an
  unmocked call on the pages that make it. Writes, including the ensure-style ones a button makes
  (`organisations.streams.personal.ensure`, `encoder.ensure`), aren't projected.
