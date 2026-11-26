import type { OperatedShow } from '@/queries/shows';

// Which outputs following a show cannot reach one of its streams, as the API says (`unreachable` on
// `organisations.shows.get`), by name: for the show's controls to warn where the stream is placed.

/** An output following the show that cannot reach a stream: what it is called, and the one gateway it reads from. */
export interface UnreachingOutput {
  outputId: string;
  name: string;
  inputGatewayId: string | null;
}

/** The outputs following the show that cannot reach the stream, as the API says, oldest first. */
export function unreachingOutputsOf(show: OperatedShow, streamId: string): UnreachingOutput[] {
  const unreaching = show.unreachable.filter(reach => reach.streamIds.includes(streamId));
  return unreaching.map(({ outputId, inputGatewayId }) => {
    const output = show.outputs.find(candidate => candidate.id === outputId);
    return { outputId, name: output?.name ?? 'An output', inputGatewayId };
  });
}
