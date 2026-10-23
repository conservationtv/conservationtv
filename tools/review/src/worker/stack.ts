import type { PullSummary, StackEntry } from '../shared/review.ts';

// A stack is pull requests based on one another's branches: each one's base is the head of the one below it, and the
// bottom one is based on the default branch, which no pull request is the head of.

/** The pull request each branch is the head of: an open one before a closed one, then the latest. */
function byHead(pulls: readonly PullSummary[]): Map<string, PullSummary> {
  const heads = new Map<string, PullSummary>();
  for (const pull of pulls) {
    const known = heads.get(pull.headRef);
    if (!known || (isOpen(pull) && !isOpen(known))) heads.set(pull.headRef, pull);
  }
  return heads;
}

function isOpen(pull: PullSummary): boolean {
  return pull.state === 'open' || pull.state === 'draft';
}

/** Open pull requests based on each branch, oldest first. */
function byBase(pulls: readonly PullSummary[]): Map<string, PullSummary[]> {
  const bases = new Map<string, PullSummary[]>();
  for (const pull of pulls.filter(isOpen).toSorted((a, b) => a.number - b.number)) {
    bases.set(pull.baseRef, [...(bases.get(pull.baseRef) ?? []), pull]);
  }
  return bases;
}

/** The pull requests stacked on `pull`'s branch, depth first, with their depths. */
function descendants(pull: PullSummary, depth: number, bases: Map<string, PullSummary[]>): StackEntry[] {
  return (bases.get(pull.headRef) ?? [])
    .filter(child => child.number !== pull.number)
    .flatMap(child => [{ ...child, depth }, ...descendants(child, depth + 1, bases)]);
}

/** The stack `pull` is in, bottom first; empty when nothing is stacked on it and it is based on no other's branch. */
export function stackOf(pull: PullSummary, pulls: readonly PullSummary[]): StackEntry[] {
  const heads = byHead(pulls);
  const below: PullSummary[] = [];
  const seen = new Set([pull.number]);
  let parent = heads.get(pull.baseRef);
  while (parent && !seen.has(parent.number)) {
    seen.add(parent.number);
    below.unshift(parent);
    parent = heads.get(parent.baseRef);
  }
  const stack = [
    ...below.map((entry, depth) => ({ ...entry, depth })),
    { ...pull, depth: below.length },
    ...descendants(pull, below.length + 1, byBase(pulls))
  ];
  return stack.length > 1 ? stack : [];
}

/** Every open pull request, each stack's members together and bottom first. */
export function openStacks(pulls: readonly PullSummary[]): StackEntry[] {
  const heads = byHead(pulls);
  const bases = byBase(pulls);
  // A stack's bottom is an open pull request not based on another open one's branch.
  const bottoms = pulls.filter(pull => {
    const parent = heads.get(pull.baseRef);
    return isOpen(pull) && !(parent && isOpen(parent));
  });
  return bottoms
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap(bottom => [{ ...bottom, depth: 0 }, ...descendants(bottom, 1, bases)]);
}
