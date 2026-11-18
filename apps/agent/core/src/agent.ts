import { Client, DeviceIdentity, deviceSignature } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import type { IrohHttpServer } from '@strangecyan/iroh-http-node';
import type { AgentConfiguration, ConservationTvConfiguration } from './config.ts';
import { gatewaySetup, withMediamtxClient, type GatewaySetup } from './gateway/index.ts';
import { serveOverIroh } from './iroh/serve.ts';
import { MetricReporter, withMetricReporter } from './reporting/reporter.ts';
import { withStudio } from './studio.ts';
import { startSystem, type AgentSystem } from './system/system.ts';

// The agent, as the runner starts and stops it:
//
//   1. its identity, and the studio API signed as it (studio.ts);
//   2. the services every runtime shares, in scope from then on: the studio API, the gateway MediaMTX's control API
//      (gateway/), and one metric reporter (reporting/);
//   3. its system, converging each key's runtime to what the studio configuration says (system/);
//   4. the agent API (api/), served over iroh (iroh/).
//
// Stopping undoes it in reverse, withdrawing the gateway's endpoints while the server closes.

const logger = getLogger(['agent']);

/** The agent: the app, served as HTTP over iroh on an endpoint whose identity is the configured secret key. */
export class Agent {
  private server: IrohHttpServer | undefined = undefined;
  private system: AgentSystem | undefined = undefined;
  private gateway: GatewaySetup | undefined = undefined;

  constructor(readonly config: AgentConfiguration) {}

  /** Start the runtimes and an iroh session, and serve on its endpoint. Resolves once requests are being accepted. */
  async start() {
    if (this.system !== undefined) throw new Error('The agent is already started');
    const config = this.config;
    if (!config) throw new Error('There is no config available.');

    logger.info('Starting {name} as a {type} agent', { name: config.name, type: config.type });
    if (config.type === 'direct') {
      throw new Error('Agents cannot currently be started in direct mode.');
    }

    const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
    const studio = new Client({ baseUrl: config.studioUrl, auth: deviceSignature(identity) });
    const gateway = gatewaySetup(config.mediamtx, studio);
    this.gateway = gateway;
    // One reporter for every monitor, so the studio API is asked who the device is once.
    const reporter = new MetricReporter(config);
    await withStudio(studio, () =>
      withMediamtxClient(gateway.mediamtx, () =>
        withMetricReporter(reporter, () => this.serve(config, identity, gateway))
      )
    );
  }

  /**
   * Converge the runtimes and serve on the endpoint, with the studio and MediaMTX APIs, and the agent's reporter, in
   * scope for both.
   */
  private async serve(config: ConservationTvConfiguration, identity: DeviceIdentity, gateway: GatewaySetup) {
    this.system = await startSystem({ config, identity, gateway });
    try {
      this.server = await serveOverIroh(config, this.system);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /**
   * Stop accepting, close connections, wait for in-flight requests to settle, and close the endpoint, while withdrawing
   * the gateway's endpoints so readers are no longer sent here, for as long as that may take
   * (gateway/streams/endpoints.ts). Then stop the runtimes.
   */
  async stop() {
    const registration = this.gateway?.registration;
    this.gateway = undefined;
    const server = this.server;
    this.server = undefined;
    await Promise.all([registration?.close(), server?.[Symbol.asyncDispose]()]);
    const system = this.system;
    this.system = undefined;
    await system?.stop();
  }
}
