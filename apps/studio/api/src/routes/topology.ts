import { placedStreams } from '@conservationtv/shows';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { builtinGateways } from '../gateways/index.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { listChannels } from '../services/channels.ts';
import { listDevices } from '../services/devices.ts';
import { listGateways } from '../services/gateways.ts';
import { listNetworks } from '../services/networks.ts';
import { getOrganisation } from '../services/organisations.ts';
import { listOutputs, withoutInputGateway } from '../services/outputs.ts';
import { listShows, withoutControls } from '../services/shows.ts';
import { listStreams, withoutCode } from '../services/streams.ts';
import { withStreamRenditions } from '../topology/renditions.ts';
import { listSubjectStates } from '../services/subjects.ts';
import { resolveOrganisationShows } from '../shows/lineup.ts';
import { listedStateV1 } from './subjects.ts';
import {
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;

// An organisation's whole topology in one read: everything its lists have, as they had it before shows had controls,
// streams short codes and exposures one picture (src/topology/renditions.ts), beside what each show places, resolved
// from the database as its object composes it (src/shows/resolve.ts). For a view of how the signal runs from the
// cameras through the shows and outputs to the channels, read whole and refreshed together, rather than as nine
// lists, all in one transaction as the caller.
//
// A show places streams, and each reader reads whichever delivery suits it (src/gateways/delivery.ts), so what a show
// `placed` is, as these versions say it in exposures, is every exposure of each stream it places, in its order.

/**
 * The organisation's lists and states, read together as the caller, with what each show places: `placed`, the
 * exposures, for the topology, and `placedStreams`, by show ID, for the status (src/routes/status.ts).
 */
async function readTopology(id: string) {
  const topology = await transaction(async () => {
    const organisation = await getOrganisation(id);
    if (!organisation) throw new ApiFailure('not_found');
    const networks = await listNetworks(id);
    const devices = await listDevices(id, {});
    const gateways = await listGateways(id, {});
    const streams = await listStreams(id);
    const shows = await listShows(id);
    const resolved = await resolveOrganisationShows(id);
    const outputs = await listOutputs(id);
    const channels = await listChannels(id);
    const states = await listSubjectStates(id, {});
    return { networks, devices, gateways, streams, shows, resolved, outputs, channels, states };
  });
  const { streams, resolved, ...lists } = topology;
  const placed = new Map([...resolved].map(([showId, state]): [string, string[]] => [showId, placedStreams(state)]));
  const shows = topology.shows.map(show => {
    const placedIds = placed.get(show.id) ?? [];
    const exposureIds = placedIds.flatMap(streamId =>
      (streams.find(stream => stream.id === streamId)?.exposures ?? []).map(exposure => exposure.id)
    );
    return { ...withoutControls(show), placed: exposureIds };
  });
  return {
    ...lists,
    outputs: topology.outputs.map(withoutInputGateway),
    gateways: [...builtinGateways, ...topology.gateways],
    streams: streams.map(stream => withStreamRenditions(withoutCode(stream))),
    shows,
    placedStreams: placed
  };
}

const DESCRIPTION =
  "Its networks, devices, gateways (the built-in ones first), streams, shows, outputs and channels, as their first versions list them, each show with the exposures of the streams it places, in its order (`placed`: every exposure of each, since each reader reads whichever suits it); and every subject's current state, as `organisations.subjects.states.list` reads them.";

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.topology.get',
      ...operationVersion(1),
      summary: "Read an organisation's whole topology",
      description: DESCRIPTION,
      responses: {
        200: { description: 'The topology' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const topology = await readTopology(id);
      const { networks, devices, gateways, streams, shows, outputs, channels } = topology;
      // As they were before activity was kept.
      const states = topology.states.map(listedStateV1);
      c.header('Cache-Control', 'no-store');
      return c.json({ shows, networks, devices, gateways, streams, outputs, channels, states }, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.topology.get',
      ...operationVersion(2),
      summary: "Read an organisation's whole topology",
      description: `${DESCRIPTION} Each state has its \`activity\`: only an \`active\` subject is judged. What the states add up to is \`organisations.status.get\`.`,
      responses: {
        200: { description: 'The topology' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const { placedStreams: _placedStreams, ...topology } = await readTopology(id);
      c.header('Cache-Control', 'no-store');
      return c.json(topology, 200);
    }
  );

/** The organisation's topology as its status is worked out from (src/routes/status.ts). */
export { readTopology };
