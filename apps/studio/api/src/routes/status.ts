import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { organisationStatus } from '../health/status.ts';
import { transaction } from '../db/transaction.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { listAgents } from '../services/agents.ts';
import {
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';
import { readTopology } from './topology.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;

// What an organisation's subjects' states add up to (src/health/status.ts), worked out from its topology as
// `organisations.topology.get` reads it: one answer to whether it is working, and what is wrong if not, for the studio
// and the CLI alike, rather than each working it out from the states.
export default new Hono().get(
  '/',
  describeRoute({
    operationId: 'organisations.status.get',
    ...operationVersion(1),
    summary: "Read an organisation's status",
    description:
      "Whether the organisation is working, and what is wrong if not. Each subject's own status is from its state (`failing` is reporting unhealthy, or gone quiet; `idle` and `off` aren't judged, since nothing asks for it or it is switched off; `unknown` has reported nothing to judge by); failures then flow along the signal's path, from a camera through its stream's deliveries, and from an output's agent through its programme to its forwards, previews, recorders and channels, so what a failing subject feeds is `affected` (`causedBy` what) rather than a problem of its own. A subject nothing is set to report about (an output with no agent's parts, a delivery no agent delivers, a camera no agent probes) is `off`, whatever was last said of it, and says why. `streams`, `shows` (the exposures each places), `outputs` and `channels` sum their parts up, each in a sentence, and `status` and `summary` the whole. `problems` are only the root causes: each subject failing or degraded itself, why (`reasons`, its state's findings in words), and what that affects.",
    responses: {
      200: { description: 'The status' },
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
    // Which agent is set to report about what: a subject nothing is set to report about isn't failing for being quiet.
    const agents = await transaction(() => listAgents(id, {}));
    const status = organisationStatus({ ...topology, agents });
    c.header('Cache-Control', 'no-store');
    return c.json(status, 200);
  }
);
