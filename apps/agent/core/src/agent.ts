import { Client, DeviceIdentity, deviceSignature } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import type { IrohHttpServer } from '@strangecyan/iroh-http-node';
import { CameraControl } from './cameras/index.ts';
import type { AgentConfiguration, ConservationTvConfiguration } from './config.ts';
import { AgentDialler } from './iroh/dial.ts';
import { PeerList } from './iroh/peers.ts';
import { gatewaySetup, withMediamtxClient, type GatewaySetup } from './gateway/index.ts';
import { serveOverIroh } from './iroh/serve.ts';
import type { Sink } from '@logtape/logtape';
import type { SystemStatus } from '@conservationtv/converge';
import { BehaviorSubject, catchError, map, of, switchMap, type Observable, type Subscription } from 'rxjs';
import { journalSystem } from './reporting/events.ts';
import { Journal, withJournal } from './reporting/journal.ts';
import { MetricReporter, withMetricReporter } from './reporting/reporter.ts';
import { withStudio } from './studio.ts';
import { startSystem, type AgentControllers, type AgentSystem } from './system/system.ts';

// The agent, as the runner starts and stops it:
//
//   1. its identity, and the studio API signed as it (studio.ts);
//   2. the services every runtime shares, in scope from then on: the studio API, the gateway MediaMTX's control API
//      (gateway/), one metric reporter, and the journal of what the agent does and says (reporting/);
//   3. its system, converging each key's runtime to what the studio configuration says (system/);
//   4. the agent API (api/), served over iroh (iroh/).
//
// Stopping undoes it in reverse, withdrawing the gateway's endpoints while the server closes.

const logger = getLogger(['agent']);

/** Where the agent is in starting and stopping. */
export type AgentState = 'stopped' | 'starting' | 'running' | 'stopping';

/** What a host can show of the agent: where it is in starting and stopping, and its runtimes' status while it runs. */
export interface AgentStatus {
  state: AgentState;
  /** Each runtime's status, once the system has started and every key has one; `null` otherwise. */
  system: SystemStatus<AgentControllers> | null;
  /** Why the system's status stopped, when a runtime's status errored; the system's own stop reports it too. */
  error: string | null;
}

interface Lifecycle {
  state: AgentState;
  system: AgentSystem | undefined;
}

/** The agent: the app, served as HTTP over iroh on an endpoint whose identity is the configured secret key. */
export class Agent {
  private server: IrohHttpServer | undefined = undefined;
  private system: AgentSystem | undefined = undefined;
  private gateway: GatewaySetup | undefined = undefined;
  private journal: Journal | undefined = undefined;
  private journalled: Subscription | undefined = undefined;
  private dialler: AgentDialler | undefined = undefined;

  private readonly lifecycle$ = new BehaviorSubject<Lifecycle>({ state: 'stopped', system: undefined });

  constructor(readonly config: AgentConfiguration) {}

  /**
   * The agent's status, for a host to show: its state as it starts and stops, with the system's status while it runs.
   * Replays the latest to each subscriber, and never errors.
   */
  readonly status$: Observable<AgentStatus> = this.lifecycle$.pipe(
    switchMap(({ state, system }) => {
      if (system === undefined) return of<AgentStatus>({ state, system: null, error: null });
      return system.status$.pipe(
        map((status): AgentStatus => ({ state, system: status, error: null })),
        catchError(error => {
          const message = error instanceof Error ? error.message : String(error);
          return of<AgentStatus>({ state, system: null, error: message });
        })
      );
    })
  );

  private moveTo(state: AgentState) {
    this.lifecycle$.next({ state, system: this.system });
  }

  /**
   * A logtape sink for the host to log through: the agent's warnings and errors go to the studio API with its events,
   * once it has started. Before that, and after it has stopped, records are dropped.
   */
  readonly logSink: Sink = record => this.journal?.sink(record);

  /** Start the runtimes and an iroh session, and serve on its endpoint. Resolves once requests are being accepted. */
  async start() {
    if (this.lifecycle$.value.state !== 'stopped') throw new Error('The agent is already started');
    const config = this.config;
    if (!config) throw new Error('There is no config available.');

    logger.info('Starting {name} as a {type} agent', { name: config.name, type: config.type });
    if (config.type === 'direct') {
      throw new Error('Agents cannot currently be started in direct mode.');
    }

    this.moveTo('starting');
    try {
      await this.startServing(config);
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.moveTo('running');
  }

  private async startServing(config: ConservationTvConfiguration) {
    const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
    const studio = new Client({ baseUrl: config.studioUrl, auth: deviceSignature(identity) });
    const gateway = gatewaySetup(config.mediamtx, studio);
    this.gateway = gateway;
    // One reporter for every monitor, so the studio API is asked who the device is once.
    const reporter = new MetricReporter(config);
    const journal = new Journal(reporter);
    this.journal = journal;
    await withStudio(studio, () =>
      withMediamtxClient(gateway.mediamtx, () =>
        withMetricReporter(reporter, () => withJournal(journal, () => this.serve(config, identity, gateway)))
      )
    );
  }

  /**
   * Converge the runtimes and serve on the endpoint, with the studio and MediaMTX APIs, and the agent's reporter, in
   * scope for both.
   */
  private async serve(config: ConservationTvConfiguration, identity: DeviceIdentity, gateway: GatewaySetup) {
    const journal = this.journal;
    journal?.start();
    journal?.event('agent.started', { name: config.name });
    const cameras = new CameraControl();
    const peers = new PeerList();
    const dialler = new AgentDialler();
    this.dialler = dialler;
    this.system = await startSystem({ config, identity, gateway, cameras, peers, dialler });
    this.moveTo('starting');
    if (journal !== undefined) this.journalled = journalSystem(this.system.status$, journal);
    // A failure from here is stopped by `start`, which undoes all of this.
    this.server = await serveOverIroh(config, { system: this.system, identity, cameras, peers, dialler });
  }

  /**
   * Stop accepting, close connections, wait for in-flight requests to settle, and close the endpoint, while withdrawing
   * the gateway's endpoints so readers are no longer sent here, for as long as that may take
   * (gateway/streams/endpoints.ts). Then stop the runtimes.
   */
  async stop() {
    if (this.lifecycle$.value.state === 'stopped' || this.lifecycle$.value.state === 'stopping') return;
    this.moveTo('stopping');
    try {
      await this.release();
    } finally {
      this.moveTo('stopped');
    }
  }

  private async release() {
    const registration = this.gateway?.registration;
    this.gateway = undefined;
    const server = this.server;
    this.server = undefined;
    this.dialler?.detach();
    this.dialler = undefined;
    await Promise.all([registration?.close(), server?.[Symbol.asyncDispose]()]);
    const system = this.system;
    this.system = undefined;
    // What stopping the runtimes does to them isn't news: the agent stopping is.
    this.journalled?.unsubscribe();
    this.journalled = undefined;
    await system?.stop();
    const journal = this.journal;
    this.journal = undefined;
    journal?.event('agent.stopped', { name: this.config.name });
    await journal?.stop();
  }
}
