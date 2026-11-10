Write a diffmap spec of pull request #$PULL_NUMBER. It is the commits from its merge base, `$MERGE_BASE`, to its head,
`$HEAD_SHA`, which is checked out. Its base branch is `$BASE_REF`.

diffmap is https://github.com/tanishqkancharla/diffmap. Run `pnpm dlx $DIFFMAP guide` first and follow it, using that
exact version for every diffmap command. Run it with pnpm dlx, not npx: the repository's devEngines turns npx away.

The spec is for the person about to review this pull request. They will read it first, then the diff itself on a review
tool that already does some of the work, so spend the spec on what that tool cannot show:

- It sets apart generated code: API documents (`contracts/openapi.json`), SDKs and CLIs, Drizzle snapshots, umbrella's
  policies and `pnpm-lock.yaml` (the rules are in `tools/review/src/shared/classify.ts`). A signoff proves those match
  their generators, so do not describe them; describe the source change they were generated from.
- It already draws the calls between changed functions as trees. Do not write a call stack that only restates which
  function calls which; use one only where the order of calls or what each one does is the point.
- What it cannot show is the design: what state a service or Durable Object holds and how an event changes it, how a
  flow differs from before, why the change is shaped as it is, and where the risk is. Prefer service diagrams and
  diagram diffs for these, and a few sentences of prose for the reasons.

Read `AGENTS.md` and `CLAUDE.md` files near the changed code for how this repository is built.

Rules for this run:

- Map only this pull request's own commits, from `$MERGE_BASE` to `$HEAD_SHA`, never against `main` when the base is
  another branch. This pull request may be one of a stack.
- This is a finished pull request, not a plan: write no phases still to do.
- Cite code only by commit, and only where that commit changed it:
  - For the pull request as a whole, use the range: `[[$MERGE_BASE..$HEAD_SHA:path#L1-L9]]`, and a `changes` fence
    whose body is `$MERGE_BASE..$HEAD_SHA`.
  - A single commit, `[[<sha>:path]]`, means the change that commit made. Use one only for a commit that touches that
    path (`git log --format=%h $MERGE_BASE..$HEAD_SHA -- path`). Do not cite the head commit for a file it did not change.
  - A reference with no commit reads the working tree, which the published copy does not have, so never write one.
  - Before you finish, check every cited path appears in `git diff --name-only` for the commit or range it names.
    `validate` does not look at git; publishing does, and fails on a reference to a file the commit did not change.
- No local images or videos; the spec is published as a gist, which holds only text.
- Write the spec to `diffmap.md` in the repository root, run `pnpm dlx $DIFFMAP validate diffmap.md` and fix it until
  it passes. Do not start a server, do not share it, do not commit, push, comment or edit anything else. A later step
  publishes it.
