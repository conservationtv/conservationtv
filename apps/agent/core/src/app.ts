import { OperationRouter, PUBLISHED_DOCUMENT_PATH, servePublishedDocument } from '@conservationtv/versioned-api/server';
import { Client, DeviceIdentity, deviceSignature } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { serve, type Admission, type IncomingPeer, type IrohHttpServer } from '@strangecyan/iroh-http-node';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import document from '../contracts/openapi.json' with { type: 'json' };
import { type AgentConfiguration, type ConservationTvConfiguration } from './config.ts';
import { decide } from './admission.ts';
import { connectWithEndpoint, createEndpoint } from './iroh.ts';
import { handleError, handleNotFound } from './middleware/errors.ts';
import status from './routes/status.ts';
import system from './routes/system.ts';
import { withStudio } from './studio.ts';
import { withSystem, type AgentSystem } from './system.ts';

import { join } from 'node:path';
import { controller, converge } from '@conservationtv/converge';
import { MachineRuntime, MachineSpecSchema } from './runtimes/machine.ts';
import {
  DEFAULT_MEDIAMTX_PORTS,
  EndpointRegistration,
  MEDIAMTX_MANIFEST,
  MOQ_MANIFEST,
  MediamtxMetricsRuntime,
  MediamtxRuntime,
  MetricsSpecSchema,
  StreamsSpecSchema,
  createMediamtxClient,
  loopback,
  withMediamtxClient
} from './runtimes/mediamtx/index.ts';
import { watchStudioConfiguration } from './studio-configuration.ts';

export { PeersSchema, type Peer, type Peers } from './admission.ts';
export {
  useConfig,
  type AgentConfiguration,
  type ConservationTvConfiguration,
  type DirectConfiguration
} from './config.ts';
export {
  MediamtxPathsSchema,
  MediamtxPortsSchema,
  type MediamtxPath,
  type MediamtxPaths,
  type MediamtxPorts
} from './runtimes/mediamtx/index.ts';

/** Every request arrives over iroh, from a peer the QUIC handshake authenticated: `peer` is its endpoint id. */
export interface AgentBindings {
  peer: string;
}

export interface AgentEnv {
  Bindings: AgentBindings;
}

export const operationRouter = new OperationRouter();

const app = new Hono<AgentEnv>({ router: operationRouter })
  .route('/status', status)
  .route('/system', system)
  .get(PUBLISHED_DOCUMENT_PATH, describeRoute({ hide: true }), servePublishedDocument(document))
  .notFound(handleNotFound)
  .onError(handleError);

const logger = getLogger(['agent']);

/** The agent's runtimes, by the key of the spec each converges to. */
function controllers(
  config: ConservationTvConfiguration,
  identity: DeviceIdentity,
  registration: EndpointRegistration
) {
  const machine = new MachineRuntime(config);
  const ports = config.mediamtxPorts ?? DEFAULT_MEDIAMTX_PORTS;
  // The streams and their metrics, both fulfilled by MediaMTX.
  const streams = new MediamtxRuntime({
    directory: join(config.directory, 'mediamtx'),
    binary: MEDIAMTX_MANIFEST,
    moq: MOQ_MANIFEST,
    identity,
    ports,
    registration
  });
  const metrics = new MediamtxMetricsRuntime(config, loopback(ports.metrics));

  // const control = new ControlRuntime(config);

  return {
    machine: controller({
      spec: MachineSpecSchema,
      status: machine.status$,
      execute: spec => machine.apply(spec),
      finalize: () => machine.teardown(),
      dispose: () => machine.dispose()
    }),
    streams: controller({
      spec: StreamsSpecSchema,
      status: streams.status$,
      execute: (spec, signal) => streams.execute(spec, signal),
      finalize: () => streams.finalize(),
      dispose: () => streams.dispose()
    }),
    metrics: controller({
      spec: MetricsSpecSchema,
      status: metrics.status$,
      execute: spec => metrics.apply(spec),
      finalize: () => metrics.teardown(),
      dispose: () => metrics.dispose()
    })
  };
}

/** The agent's runtimes, by key: what its system's spec and status are made of. */
export type AgentControllers = ReturnType<typeof controllers>;

/** The agent: the app, served as HTTP over iroh on an endpoint whose identity is the configured secret key. */
export class Agent {
  private server: IrohHttpServer | undefined = undefined;
  private system: AgentSystem | undefined = undefined;
  private registration: EndpointRegistration | undefined = undefined;

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
    const ports = config.mediamtxPorts ?? DEFAULT_MEDIAMTX_PORTS;
    const mediamtx = createMediamtxClient(loopback(ports.api));
    const registration = new EndpointRegistration(studio);
    this.registration = registration;
    await withStudio(studio, () => withMediamtxClient(mediamtx, () => this.serve(config, identity, registration)));
  }

  /** Converge the runtimes and serve on the endpoint, with the studio and MediaMTX APIs in scope for both. */
  private async serve(
    config: ConservationTvConfiguration,
    identity: DeviceIdentity,
    registration: EndpointRegistration
  ) {
    this.system = await converge({
      controllers: controllers(config, identity, registration),
      restore: async () => {
        const spec = {
          machine: { intervalMs: 60_000 },
          streams: { paths: [], publishers: [] },
          metrics: { intervalMs: 60_000, paths: [] }
        };
        return spec;
      },
      mutator: context =>
        watchStudioConfiguration(context.signal, specs =>
          context.update(draft => {
            if (specs === undefined) {
              delete draft.streams;
              delete draft.metrics;
            } else {
              draft.streams = specs.streams;
              draft.metrics = specs.metrics;
            }
          })
        )
    });
    const system = this.system;

    try {
      const endpoint = await createEndpoint(config);
      await connectWithEndpoint(endpoint);

      this.server = serve(
        endpoint,
        (request, peer) => {
          // if (!listed(peer.endpointId)) return new Response(null, { status: 403 });
          return withSystem(system, () => app.fetch(request, { peer: peer.endpointId }));
        },
        {
          admit: (peer: IncomingPeer): Admission => {
            const admission = decide(undefined, peer);
            logger.info('Admitted {endpointId} over {kind} as {admission}', {
              kind: peer.kind,
              endpointId: peer.endpointId,
              admission
            });
            return admission;
          }
        }
      );
      const endpointId = endpoint.id();
      logger.info('Started {name} on {endpointId}', { name: this.config.name, endpointId: endpointId.toString() });
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /**
   * Withdraw the gateway's endpoints, so readers are no longer sent here. Stop accepting, close connections, wait for
   * in-flight requests to settle, and close the endpoint. Then stop the runtimes.
   */
  async stop() {
    const registration = this.registration;
    this.registration = undefined;
    await registration?.close();
    const server = this.server;
    this.server = undefined;
    await server?.[Symbol.asyncDispose]();
    const system = this.system;
    this.system = undefined;
    await system?.stop();
  }
}

export default app;
