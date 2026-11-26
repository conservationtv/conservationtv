// Which delivery of a stream a reader reads (docs/shows.md, Delivery): what delivers a stream is never a show's
// business, so each reader asks for the stream (`organisations.streams.connect`) by the protocols it can play, and is
// given one of its exposures. Pure: from the stream's exposures and their gateways and health, read first
// (src/gateways/connect.ts).
//
//   1. Candidates: the exposures on gateways the caller reaches. A gateway on no network is on the internet, reached by
//      everyone; one on a network is reached by a device on that network, and by nobody else.
//   2. Of those, the ones read by a protocol the caller named: each by the first of them its gateway speaks.
//   3. An output's input gateway, when it names one, leaves only that gateway.
//   4. Preferred in this order: on the caller's own network, then conservation.tv, then any other internet gateway;
//      those whose health is failing last, and after them any its gateway says is not live (asked only for a pushed
//      stream); then by the caller's order of protocols, then the oldest exposure.

/** The built-in gateway the internet prefers after the caller's own network. */
const PREFERRED_INTERNET_GATEWAY = 'conservationtv';

/** One exposure of the stream, with what its gateway is and how it is doing. */
export interface DeliveryCandidate {
  exposureId: string;
  gatewayId: string;
  /** The gateway's network: null on the internet. */
  networkId: string | null;
  /** The protocols the gateway is read by. */
  egress: readonly string[];
  /** Whether the exposure is failing by its own state. */
  failing: boolean;
  /**
   * Whether its gateway says it is live now, where that was asked: only for a pushed stream, whose chains stand whether
   * or not anyone publishes them, so one of its several may be live and the rest not. Null where the gateway cannot say.
   */
  live?: boolean | null;
}

/** Who is reading, and how. */
export interface DeliveryReader {
  /** The caller's network: null for a member's browser, or a device on none, which reach the internet only. */
  networkId: string | null;
  /** The one gateway the caller's output reads from, when it names one. */
  inputGatewayId: string | null;
  /** The protocols the caller can play, in its order of preference. */
  protocols: readonly string[];
}

/** A gateway a publisher could deliver a pushed stream to, with what it is. */
export interface IngestCandidate {
  gatewayId: string;
  /** The gateway's network: null on the internet. */
  networkId: string | null;
  /** The protocols the gateway is published to. */
  ingest: readonly string[];
}

/** Who is publishing, and how. */
export interface IngestPublisher {
  /**
   * The network the publisher is on, as the person going live says ("on site"): null for the internet. The API cannot
   * tell for a browser or an encoder, so it is theirs to say.
   */
  networkId: string | null;
  /** The protocols the publisher can send, in its order of preference. */
  protocols: readonly string[];
}

/** The gateway a publisher publishes to, and the protocol it publishes by. */
export interface ChosenIngest {
  candidate: IngestCandidate;
  protocol: string;
}

/**
 * The gateway a pushed stream is published to, mirroring a reader's choice (docs/shows.md, Going live): the gateways
 * the publisher reaches (the internet, and its own network) published to by a protocol it named, the one on its own
 * network first, then conservation.tv, then any other internet gateway; then by its order of protocols, then the
 * order given (oldest first). Undefined when none is.
 */
export function chooseIngest(
  candidates: readonly IngestCandidate[],
  publisher: IngestPublisher
): ChosenIngest | undefined {
  const reachable = candidates.flatMap((candidate, order) => {
    if (candidate.networkId !== null && candidate.networkId !== publisher.networkId) return [];
    const preference = publisher.protocols.findIndex(protocol => candidate.ingest.includes(protocol));
    if (preference === -1) return [];
    return [{ candidate, protocol: publisher.protocols[preference]!, preference, order }];
  });
  const ranked = reachable.sort(
    (a, b) =>
      ingestNearness(a.candidate) - ingestNearness(b.candidate) || a.preference - b.preference || a.order - b.order
  );
  const [chosen] = ranked;
  return chosen === undefined ? undefined : { candidate: chosen.candidate, protocol: chosen.protocol };
}

/** How near a gateway is to a publisher that reaches it: as `nearness` is to a reader. */
function ingestNearness(candidate: IngestCandidate): number {
  if (candidate.networkId !== null) return 0;
  return candidate.gatewayId === PREFERRED_INTERNET_GATEWAY ? 1 : 2;
}

/** The exposure a reader reads, and the protocol it reads it by. */
export interface ChosenDelivery {
  candidate: DeliveryCandidate;
  protocol: string;
}

/**
 * How near a reachable gateway is: the caller's own network (the only network one it reaches), then conservation.tv,
 * then the rest of the internet.
 */
function nearness(candidate: DeliveryCandidate): number {
  if (candidate.networkId !== null) return 0;
  return candidate.gatewayId === PREFERRED_INTERNET_GATEWAY ? 1 : 2;
}

/**
 * Whether the reader reaches the candidate's gateway, and may read it there: as a stream's reader is chosen a
 * delivery, and as a device asking for one exposure is admitted to it (src/gateways/connect.ts).
 */
export function reachable(
  candidate: Pick<DeliveryCandidate, 'gatewayId' | 'networkId'>,
  reader: Pick<DeliveryReader, 'networkId' | 'inputGatewayId'>
): boolean {
  if (reader.inputGatewayId !== null && candidate.gatewayId !== reader.inputGatewayId) return false;
  return candidate.networkId === null || candidate.networkId === reader.networkId;
}

/** The delivery the reader reads, in the order above; undefined when none is reachable by a protocol it named. */
export function chooseDelivery(
  candidates: readonly DeliveryCandidate[],
  reader: DeliveryReader
): ChosenDelivery | undefined {
  const readable = candidates.flatMap((candidate, order) => {
    if (!reachable(candidate, reader)) return [];
    const preference = reader.protocols.findIndex(protocol => candidate.egress.includes(protocol));
    if (preference === -1) return [];
    return [{ candidate, protocol: reader.protocols[preference]!, preference, order }];
  });
  const ranked = readable.sort(
    // Each criterion in turn, in the order above, until one tells the two apart.
    (a, b) =>
      Number(a.candidate.live === false) - Number(b.candidate.live === false) ||
      Number(a.candidate.failing) - Number(b.candidate.failing) ||
      nearness(a.candidate) - nearness(b.candidate) ||
      a.preference - b.preference ||
      a.order - b.order
  );
  const [chosen] = ranked;
  return chosen === undefined ? undefined : { candidate: chosen.candidate, protocol: chosen.protocol };
}
