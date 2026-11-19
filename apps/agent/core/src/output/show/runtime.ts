import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import type { Snapshot, Target, TargetPhase } from '@strangecyan/vignette';
import { obsTarget } from '@strangecyan/vignette/obs';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import type { ObsRuntime } from '../obs/runtime.ts';
import { ctvStreamObs } from './ctv-stream.ts';
import { showStream } from './show-stream.ts';

/**
 * The show to drive OBS with: the one the output follows, at `url` (src/configuration in the studio API). Present only
 * while the output follows a show under `show` control; without it, nothing in the agent touches OBS's scenes.
 */
export const ShowSpecSchema = z.object({ id: z.string(), url: z.url() });
export type ShowSpec = z.output<typeof ShowSpecSchema>;

export interface ShowStatus {
  /** The show being followed, and how far OBS has caught up with it. */
  show: string | null;
  phase: TargetPhase | null;
}

const STOPPED: ShowStatus = { show: null, phase: null };

/** The target following one show, and how to stop it following. */
interface Following {
  show: ShowSpec;
  target: Target;
  stop: () => void;
  watching: () => void;
}

/**
 * The `show` key: vignette's OBS target, converging the `obs` runtime's OBS to the show the spec names, following the
 * show's stream as the agent's device; the `ctv-stream` plugin plays the exposures it places from the `obs` runtime's
 * relays. It tells the `obs` runtime which scene the show is on, for its watchdog to restore after a crash.
 *
 * The target touches only what it made (`vignette/<show>/…` scenes and inputs), so anything an operator adds in OBS
 * stays. It reconnects to OBS by itself whenever OBS restarts, so it needs no more of the `obs` key than where OBS is.
 */
export class ShowRuntime {
  readonly status$ = new BehaviorSubject<ShowStatus>(STOPPED);
  private following: Following | undefined = undefined;

  constructor(
    private readonly obs: ObsRuntime,
    private readonly identity: DeviceIdentity
  ) {}

  /** Follow the spec's show: the same target while it is the same show, another for another. */
  async execute(spec: ShowSpec): Promise<void> {
    if (this.following?.show.id === spec.id && this.following.show.url === spec.url) return;
    this.unfollow();
    const { url, password } = await this.obs.websocket();
    const target = obsTarget({
      url,
      password,
      dir: this.obs.vignetteDirectory,
      sources: [ctvStreamObs(this.obs.inputs)]
    });
    const stream = showStream(spec.url, this.identity, snapshot => {
      const scene = programSceneOf(snapshot);
      this.obs.driveProgram(() => scene);
    });
    const stop = target.follow(stream);
    const watching = target.subscribe(() => this.update({ phase: target.status.phase }));
    this.following = { show: spec, target, stop, watching };
    this.update({ show: spec.id, phase: target.status.phase });
  }

  /** The key is absent: stop following, leaving OBS's scenes to whatever drives it now. */
  async finalize(): Promise<void> {
    this.unfollow();
  }

  dispose(): void {
    this.unfollow();
  }

  private unfollow(): void {
    const following = this.following;
    this.following = undefined;
    if (following === undefined) return;
    following.watching();
    following.stop();
    void following.target.dispose();
    this.obs.driveProgram(undefined);
    this.update(STOPPED);
  }

  private update(changes: Partial<ShowStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}

/**
 * The OBS scene a snapshot goes out on: its active scene, or its first when it names none, by vignette's name for it
 * (`vignette/<show>/<scene>`, which `@strangecyan/vignette/obs` doesn't export). Undefined for a show with no scenes.
 */
function programSceneOf(snapshot: Snapshot): string | undefined {
  const scene = snapshot.activeScene ?? snapshot.scenes[0]?.id;
  return scene === undefined ? undefined : `vignette/${snapshot.id}/${scene}`;
}
