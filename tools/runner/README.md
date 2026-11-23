# Runner

The checks a pull request is signed off with, run on a developer's machine rather than on Actions, and what they leave
for the review tool (`tools/review`) to show.

```sh
pnpm signoff                    # every signoff, at the checked-out commit
pnpm signoff lint typecheck     # some of them (also pnpm signoff:lint, …)
pnpm signoff --no-signoff       # run and upload, without giving any
pnpm signoff --no-upload        # give them without uploading anything
REVIEW_URL=http://localhost:6423 pnpm signoff test   # upload to a local review tool
```

Each signoff ([`src/signoffs.ts`](src/signoffs.ts)) runs its commands from the repository's root, streaming them to the
terminal. It fails when a command does, or when the run changes a file the commit has (a stale generated file, say);
that also stops the signoffs after it, which would no longer be of the commit. Then:

1. Its log and `result.json` ([`src/results.ts`](src/results.ts)) are uploaded to the review tool, under
   `<commit>/<signoff>/`, with `gh auth token`: the review tool checks with GitHub that the token's owner can push to
   the repository, and records them as who ran it.
2. One that passed is given with `gh signoff <name> --commit <sha> --url <its result>`, so the commit status links to
   the log. `gh signoff` keeps its own guards: it refuses a commit that isn't pushed, or a tree with changes.

| Signoff     | Runs                                                       |
| ----------- | ---------------------------------------------------------- |
| `lint`      | `pnpm lint`                                                |
| `typecheck` | every package's `typecheck`                                |
| `generated` | every API's `generate` (document, SDK, CLI): nothing moves |
| `test`      | every package's `test`, but the control plane's end-to-end |
| `contracts` | `pnpm contracts` and `pnpm contracts:snapshots`            |

The gatekeeper's tests start a Postgres container, so `test` needs Docker running. The control plane's end-to-end
tests also need the relay images, so they are left to
`pnpm --filter @conservationtv/controlplane-tests test`.
