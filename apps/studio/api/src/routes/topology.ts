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
import { listShows } from '../services/shows.ts';
import { listStreams } from '../services/streams.ts';
import { listSubjectStates } from '../services/subjects.ts';
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

// An organisation's whole topology in one read: everything its lists have, as they have it, beside what its broadcast
// places, which only the broadcast's object knows (src/shows/host.tsx). For a view of how the signal runs from the
// cameras through the broadcast to the channels, read whole and refreshed together, rather than as eight lists.
// The broadcast's object does not run under row-level security, so the organisation is first read as the caller:
// members of other organisations get `not_found`, as following the broadcast does (src/routes/broadcast.ts).

export default new Hono().get(
  '/',
  describeRoute({
    operationId: 'organisations.topology.get',
    ...operationVersion(1),
    summary: "Read an organisation's whole topology",
    description:
      "Its networks, devices, gateways (the built-in ones first), streams, shows and channels, as their lists read them; every subject's current state, as `organisations.subjects.states.list` reads them; and the exposures its broadcast's composition places, in its order (none before it is composed), which every show follows for now.",
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
    const topology = await transaction(async () => {
      const organisation = await getOrganisation(id);
      if (!organisation) throw new ApiFailure('not_found');
      const networks = await listNetworks(id);
      const devices = await listDevices(id, {});
      const gateways = await listGateways(id, {});
      const streams = await listStreams(id);
      const shows = await listShows(id);
      const channels = await listChannels(id);
      const states = await listSubjectStates(id, {});
      return { networks, devices, gateways: [...builtinGateways, ...gateways], streams, shows, channels, states };
    });
    // TODO: surface what the broadcast places somewhere other than its object (a table its composing writes, say), so
    // this reads it in the transaction above, under row-level security, rather than asking the object after it.
    const environment = useEnvironment();
    const broadcast = environment.broadcasts.get(id);
    const placed = await broadcast.placed();
    c.header('Cache-Control', 'no-store');
    return c.json({ ...topology, broadcast: { placed } }, 200);
  }
);
