import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { builtinGateways } from '../gateways/index.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { listChannels } from '../services/channels.ts';
import { listDevices } from '../services/devices.ts';
import { listGateways } from '../services/gateways.ts';
import { listNetworks } from '../services/networks.ts';
import { getOrganisation } from '../services/organisations.ts';
import { listOutputs } from '../services/outputs.ts';
import { listShows } from '../services/shows.ts';
import { listStreams } from '../services/streams.ts';
import { listSubjectStates } from '../services/subjects.ts';
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

// An organisation's whole topology in one read: everything its lists have, as they have it, beside what each show
// places, which only the show's object knows (src/shows/host.tsx). For a view of how the signal runs from the cameras
// through the shows and outputs to the channels, read whole and refreshed together, rather than as nine lists.
// A show's object does not run under row-level security, so the organisation is first read as the caller: members of
// other organisations get `not_found`, as following a show does (src/routes/shows.ts).

/** The organisation's lists and states, read together as the caller, with what each show places. */
async function readTopology(id: string) {
  const topology = await transaction(async () => {
    const organisation = await getOrganisation(id);
    if (!organisation) throw new ApiFailure('not_found');
    const networks = await listNetworks(id);
    const devices = await listDevices(id, {});
    const gateways = await listGateways(id, {});
    const streams = await listStreams(id);
    const shows = await listShows(id);
    const outputs = await listOutputs(id);
    const channels = await listChannels(id);
    const states = await listSubjectStates(id, {});
    return {
      networks,
      devices,
      gateways: [...builtinGateways, ...gateways],
      streams,
      shows,
      outputs,
      channels,
      states
    };
  });
  // TODO: surface what a show places somewhere other than its object (a table its composing writes, say), so this
  // reads it in the transaction above, under row-level security, rather than asking each object after it.
  const environment = useEnvironment();
  const shows = await Promise.all(
    topology.shows.map(async show => {
      const broadcast = environment.broadcasts.get(show.id);
      const placed = await broadcast.placed();
      return { ...show, placed };
    })
  );
  return { ...topology, shows };
}

const DESCRIPTION =
  "Its networks, devices, gateways (the built-in ones first), streams, shows, outputs and channels, as their lists read them, each show with the exposures its composition places, in its order (`placed`, none before it is composed); and every subject's current state, as `organisations.subjects.states.list` reads them.";

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
      const topology = await readTopology(id);
      c.header('Cache-Control', 'no-store');
      return c.json(topology, 200);
    }
  );

/** The organisation's topology as its status is worked out from (src/routes/status.ts). */
export { readTopology };
