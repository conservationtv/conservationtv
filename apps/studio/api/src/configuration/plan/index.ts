import { useEnvironment } from '../../env/env.ts';
import type { AuthenticatedDevice } from '../../middleware/device.ts';
import { trustedTransaction } from '../../db/transaction.ts';
import { type ExposureRow, planPublished, planServed, selectExposures, selectLocalGateway } from './helpers.ts';
import type { PlannedConfiguration } from './types.ts';

export type * from './types.ts';

// A device's configuration: what it should be doing, derived from the topology whenever it asks, never stored. Only
// agents have one so far. The network's active agent runs the MediaMTX gateway on its network, so it:
//
//   serves  each exposure of that gateway, pulling every rendition from the stream's camera as the camera's driver
//           says; and
//   publishes each exposure pinned to it on another gateway, by MoQ, from an exposure it serves.
//
// Each exposure says exactly what the agent runs for it, so the agent decides nothing itself. Planning reads the
// agent's part of the topology, then decides from it alone. What it cannot plan yet (transcoding, upstream chains,
// publishing by other protocols) is left out, with a diagnostic saying why.

/** The signing device's configuration, read by trusted code: a device principal cannot read the topology. */
export function planConfiguration(device: AuthenticatedDevice): Promise<PlannedConfiguration> {
  return trustedTransaction(async () => {
    if (device.kind !== 'agent') {
      throw new Error('Currently planning configuration is only supported for agents.');
    }
    const gatewayId = await selectLocalGateway(device);
    const rows = await selectExposures(device.id, gatewayId);
    return planAgent(device.organisationId, gatewayId, rows);
  });
}

/** The agent's configuration: its MediaMTX, if it runs one, the exposures that serves, then those it publishes. */
function planAgent(organisationId: string, gatewayId: string | undefined, rows: ExposureRow[]): PlannedConfiguration {
  const planned: PlannedConfiguration = { organisationId, mediamtx: null, exposures: {}, diagnostics: [] };
  const diagnose = (subject: string, message: string) => planned.diagnostics.push({ subject, message });
  if (gatewayId !== undefined) {
    const environment = useEnvironment();
    if (environment.gatewayKeys === undefined)
      diagnose(`gateway:${gatewayId}`, 'GATEWAY_SIGNING_KEYS is unset, so no reader or publisher can be admitted');
    // How src/gateways/mediamtx.ts signs its tokens.
    const issuer = environment.variables.APP_URL;
    const auth = { jwks: new URL('/gateway-keys', issuer).href, issuer, audience: gatewayId };
    planned.mediamtx = { gatewayId, auth };
  }
  // Served first, so the exposures published from them find them planned.
  for (const row of rows.filter(row => row.gatewayId === gatewayId)) {
    const served = planServed(row, message => diagnose(`exposure:${row.id}`, message));
    if (served !== undefined) planned.exposures[row.id] = served;
  }
  for (const row of rows.filter(row => row.gatewayId !== gatewayId)) {
    const published = planPublished(row, planned.exposures, message => diagnose(`exposure:${row.id}`, message));
    if (published !== undefined) planned.exposures[row.id] = published;
  }
  return planned;
}
