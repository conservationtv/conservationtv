import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ControlUpdateParams,
  ShowCreateParams,
  ShowGetOutput,
  ShowListOutput,
  ShowUpdateParams,
  StreamMixParams
} from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// An organisation's shows (apps/studio/api/src/routes/shows.ts, docs/shows.md): what is on screen, each composed by an
// object of its own from what is in the database and followed by name, with the outputs following it. Any member
// operates one: its layout, its lineup's order, its sound and its takeover. How a show goes out is each of those
// outputs' (src/queries/outputs.ts).

/** A show as the organisation's list has it: how it is operated, and the outputs following it, without its lineup. */
export type ListedShow = ShowListOutput['shows'][number];

/** A show as it is read on its own: how it is operated, the outputs following it, and its lineup. */
export type OperatedShow = ShowGetOutput;

/**
 * One of the organisation's camera streams as the show has it: in the lineup at its `position` (from 1; the first
 * `slots` are on screen), or out of it with why (`absence`), and how the show mixes its sound.
 */
export type LineupStream = OperatedShow['lineup'][number];

/** What operating a show changes: its layout, its own mix, its takeover. Only the fields given change. */
export type ShowControls = Omit<ControlUpdateParams, 'id' | 'showId'>;

/** How the show mixes one stream's sound. Only the fields given change. */
export type StreamMix = Omit<StreamMixParams, 'id' | 'showId'>;

/** Two streams to exchange places in the lineup, by ID. */
export interface LineupSwap {
  a: string;
  b: string;
}

/** The organisation's shows, oldest first, each with the outputs following it. */
export const showListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['shows', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.shows.list.v2({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.shows;
    }
  });

/**
 * One show with its lineup, as its controls read it. Read again whenever anyone operates it from here, whenever its
 * broadcast is composed again (src/components/shows/broadcast-stage.tsx), and every half minute besides, since a
 * camera locked off screen changes the lineup without changing what is on screen.
 */
export const showQueryOptions = (organisationId: string, showId: string) =>
  queryOptions({
    queryKey: ['shows', organisationId, 'get', showId] as const,
    queryFn: async ({ client, queryKey }) => {
      const asked = Date.now();
      const result = await api.organisations.shows.get.v2({ id: organisationId, showId });
      if (result instanceof Error) throw result;
      // A read asked before the API answered an operation from here (one on the half-minute, on focus, or after
      // another operation) may not have it: answering with it would undo the change shown at once, until the
      // operation's own read afterwards. The change as shown stands instead.
      if (unansweredSince(client, organisationId, showId, asked)) {
        return client.getQueryData<OperatedShow>(queryKey) ?? result;
      }
      return result;
    },
    refetchInterval: 30_000
  });

/** What every operation of one show is keyed by, so a read of it waits until the last of them has settled. */
export const showOperationMutationKey = (organisationId: string, showId: string) =>
  ['shows', organisationId, 'operate', showId] as const;

/**
 * The show's read as it was before an optimistic change, to put back if the change is refused; and once the API has
 * answered the change, when, so a read asked before then is known to maybe lack it. Kept by the mutation as its
 * context, which the show's read finds it by.
 */
interface ShowRollback {
  previous: OperatedShow | undefined;
  answeredAt?: number;
}

/** Notes that the API answered the change, whether it took it or not. */
function answered(rollback: ShowRollback | undefined) {
  if (rollback) rollback.answeredAt = Date.now();
}

/** Whether an operation of the show from here is in flight that the API had not answered by `time`. */
function unansweredSince(client: QueryClient, organisationId: string, showId: string, time: number): boolean {
  const operations = client.getMutationCache().findAll({
    mutationKey: showOperationMutationKey(organisationId, showId),
    status: 'pending'
  });
  return operations.some(operation => {
    // SAFETY: every operation under the show's key keeps a `ShowRollback` (or nothing yet) as its context.
    const rollback = operation.state.context as ShowRollback | undefined;
    return rollback?.answeredAt === undefined || rollback.answeredAt > time;
  });
}

/**
 * Shows a change to the show at once, in its cached read, before the API has it: drag and drop should feel immediate.
 * The cache stays the source of truth: any read in flight is cancelled so it can't overwrite the change, a read asked
 * before the API answers keeps it (`showQueryOptions`), and the read as it was is kept to put back.
 */
async function changeOptimistically(
  client: QueryClient,
  organisationId: string,
  showId: string,
  change: (show: OperatedShow) => OperatedShow
): Promise<ShowRollback> {
  const key = showQueryOptions(organisationId, showId).queryKey;
  await client.cancelQueries({ queryKey: key });
  const previous = client.getQueryData(key);
  if (previous) client.setQueryData(key, change(previous));
  return { previous };
}

/** Puts the show's read back as it was before a refused change. */
function rollBack(client: QueryClient, organisationId: string, showId: string, rollback: ShowRollback | undefined) {
  if (!rollback?.previous) return;
  client.setQueryData(showQueryOptions(organisationId, showId).queryKey, rollback.previous);
}

/**
 * Reads the organisation's shows again once the last operation of this show in flight has settled (this one still
 * counts while it settles), so the answer to an earlier one never shows over a later optimistic change.
 */
async function readAgainWhenSettled(client: QueryClient, organisationId: string, showId: string) {
  if (client.isMutating({ mutationKey: showOperationMutationKey(organisationId, showId) }) > 1) return;
  await client.invalidateQueries({ queryKey: ['shows', organisationId] });
}

/** Operate a show: its layout, its own mix, or its takeover. Any member; shown at once. */
export function useUpdateShowControls(organisationId: string, showId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: showOperationMutationKey(organisationId, showId),
    mutationFn: async (controls: ShowControls) => {
      const result = await api.organisations.shows.controls.update.v1({ id: organisationId, showId, ...controls });
      if (result instanceof Error) throw result;
      return result;
    },
    onMutate: controls => changeOptimistically(client, organisationId, showId, show => controlled(show, controls)),
    onSuccess: (_result, _controls, rollback) => answered(rollback),
    onError: (_error, _controls, rollback) => {
      answered(rollback);
      rollBack(client, organisationId, showId, rollback);
    },
    onSettled: () => readAgainWhenSettled(client, organisationId, showId)
  });
}

/**
 * A show with controls changed as the API changes them: disarming ends a live takeover. How another stream armed is
 * mixed is not known until the show is read again.
 */
function controlled(show: OperatedShow, controls: ShowControls): OperatedShow {
  const next = { ...show, ...controls };
  const takeoverMix = next.takeoverMix?.streamId === next.takeoverStreamId ? next.takeoverMix : null;
  return next.takeoverStreamId === null ? { ...next, takeoverLive: false, takeoverMix } : { ...next, takeoverMix };
}

/**
 * Exchange two streams' places in the show's lineup, by ID: both on screen, or one off it, which is how a camera is
 * brought on. Any member; shown at once.
 */
export function useSwapLineup(organisationId: string, showId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: showOperationMutationKey(organisationId, showId),
    mutationFn: async ({ a, b }: LineupSwap) => {
      const result = await api.organisations.shows.lineup.swap.v1({
        id: organisationId,
        showId,
        a: { streamId: a },
        b: { streamId: b }
      });
      if (result instanceof Error) throw result;
      return result;
    },
    onMutate: ({ a, b }) =>
      changeOptimistically(client, organisationId, showId, show => ({ ...show, lineup: swapped(show.lineup, a, b) })),
    onSuccess: (_result, _swap, rollback) => answered(rollback),
    onError: (_error, _swap, rollback) => {
      answered(rollback);
      rollBack(client, organisationId, showId, rollback);
    },
    onSettled: () => readAgainWhenSettled(client, organisationId, showId)
  });
}

/** The lineup with two of its streams' positions exchanged, in position order; as it was if either is out of it. */
function swapped(lineup: LineupStream[], a: string, b: string): LineupStream[] {
  const first = lineup.find(stream => stream.streamId === a)?.position ?? null;
  const second = lineup.find(stream => stream.streamId === b)?.position ?? null;
  if (first === null || second === null) return lineup;
  const exchanged = lineup.map(stream => {
    if (stream.streamId === a) return { ...stream, position: second };
    if (stream.streamId === b) return { ...stream, position: first };
    return stream;
  });
  // Those in the lineup by position, then those out of it as they were: the order `get` answers in.
  const placed = exchanged.filter(stream => stream.position !== null);
  const absent = exchanged.filter(stream => stream.position === null);
  placed.sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
  return [...placed, ...absent];
}

/** Set how the show mixes one stream's sound: its level, or whether it is muted. Any member; shown at once. */
export function useMixShowStream(organisationId: string, showId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: showOperationMutationKey(organisationId, showId),
    mutationFn: async (mix: StreamMix) => {
      const result = await api.organisations.shows.streams.mix.v1({ id: organisationId, showId, ...mix });
      if (result instanceof Error) throw result;
      return result;
    },
    onMutate: ({ streamId, ...mix }) =>
      changeOptimistically(client, organisationId, showId, show => ({
        ...show,
        lineup: show.lineup.map(stream => (stream.streamId === streamId ? { ...stream, ...mix } : stream)),
        takeoverMix: show.takeoverMix?.streamId === streamId ? { ...show.takeoverMix, ...mix } : show.takeoverMix
      })),
    onSuccess: (_result, _mix, rollback) => answered(rollback),
    onError: (_error, _mix, rollback) => {
      answered(rollback);
      rollBack(client, organisationId, showId, rollback);
    },
    onSettled: () => readAgainWhenSettled(client, organisationId, showId)
  });
}

/** Make a show, by name. Administrators only. */
export function useCreateShow(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (show: Omit<ShowCreateParams, 'id'>) => {
      const result = await api.organisations.shows.create.v1({ id: organisationId, ...show });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** Rename a show. */
export function useUpdateShow(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<ShowUpdateParams, 'id'>) => {
      const result = await api.organisations.shows.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** Delete a show. The outputs following it follow nothing until given another, so they are read again too. */
export function useDeleteShow(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (showId: string) => {
      const result = await api.organisations.shows.delete.v1({ id: organisationId, showId });
      if (result instanceof Error) throw result;
    },
    // Not waited on: the page that deleted it leaves at once, instead of showing "not found" while its list is read.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['shows', organisationId] });
      void client.invalidateQueries({ queryKey: ['outputs', organisationId] });
    }
  });
}
