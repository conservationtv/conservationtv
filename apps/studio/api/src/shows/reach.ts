import { reachable, type DeliveryReader } from '../gateways/delivery.ts';
import { neededStreams, type ShowFacts } from './resolve.ts';

// Which of the streams a show needs each output following it cannot read (docs/shows.md, Decisions: "A cam an output
// cannot reach"). The output's agent still places such a stream, so its card shows there; this is what the show's
// controls warn of. Pure, from the show's facts and where each output's agent reads from, read first
// (src/services/shows.ts), by the rule its reads are chosen and admitted by (`reachable`, src/gateways/delivery.ts).
// Protocols are left out: which an agent asks with is its own, so this says only whether any delivery is where it reads.

/** An output following the show that has an agent, as a reader: its agent's network, and its input gateway. */
export interface OutputReader extends Pick<DeliveryReader, 'networkId' | 'inputGatewayId'> {
  outputId: string;
}

/** The streams the show needs that one output's agent reaches no delivery of. */
export interface OutputReach {
  outputId: string;
  /** The one gateway the output reads from, as it names one: null when each stream's read chooses. */
  inputGatewayId: string | null;
  streamIds: string[];
}

/**
 * For each reader, the streams the show needs (`neededStreams`) that have deliveries but none at a gateway it reaches,
 * in the order the show places them. A stream with no delivery at all is out of the lineup or shows its card
 * everywhere, so it is not this. `networks` is each gateway's network (null on the internet), built in or the
 * organisation's; a delivery whose gateway is not there is read by nobody.
 */
export function unreachableStreams(
  facts: ShowFacts,
  networks: ReadonlyMap<string, string | null>,
  readers: readonly OutputReader[]
): OutputReach[] {
  const placed = neededStreams(facts);
  const needed = placed.flatMap(streamId => facts.streams.filter(stream => stream.id === streamId));
  const delivered = needed.filter(stream => stream.exposures.length > 0);
  return readers.map(reader => {
    const reaches = (gatewayId: string) => {
      const networkId = networks.get(gatewayId);
      return networkId !== undefined && reachable({ gatewayId, networkId }, reader);
    };
    const unreached = delivered.filter(stream => !stream.exposures.some(exposure => reaches(exposure.gatewayId)));
    const streamIds = unreached.map(stream => stream.id);
    const { outputId, inputGatewayId } = reader;
    return { outputId, inputGatewayId, streamIds };
  });
}
