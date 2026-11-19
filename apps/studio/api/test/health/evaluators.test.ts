import {
  cameraMetrics,
  channelMetrics,
  forwardMetrics,
  machineMetrics,
  pathMetrics,
  programMetrics,
  programSubject,
  relayMetrics
} from '@conservationtv/reports';
import { describe, expect, it } from 'vitest';
import { evaluators } from '../../src/health/evaluators.ts';
import type { ExposureContext } from '../../src/health/exposure.ts';
import { about, findingOf, report, reportSamples, reporter } from './harness.ts';

const GB = 1024 ** 3;

/** A minute of an exposure delivering cleanly, at both renditions, and reaching the relay. */
function deliveringExposure(qualityReady = 1) {
  return [
    report(pathMetrics.ready, 1, { rendition: 'default' }),
    report(pathMetrics.ready, qualityReady, { rendition: 'quality' }),
    report(pathMetrics.ingestBitrate, 2_400_000, { rendition: 'default' }),
    report(pathMetrics.ingestFrameErrors, 0, { rendition: 'default' }),
    report(relayMetrics.ingestBitrate, 2_400_000)
  ];
}

/** An exposure with both renditions, that nothing is published from: as the topology holds it. */
const served: ExposureContext = {
  renditions: ['default', 'quality'],
  published: [],
  upstreamExposureId: null,
  sourceOff: false
};

/** An exposure published to a relay from another the same agent serves. */
const relayed: ExposureContext = {
  renditions: ['default'],
  published: [],
  upstreamExposureId: '0199e8b2-0000-7000-8000-00000000000c',
  sourceOff: false
};

describe('exposure', () => {
  it('is healthy while every rendition delivers', async () => {
    const agent = reporter(evaluators.exposure, { context: served });
    const opinion = await agent.minute(...deliveringExposure());
    expect(opinion.health).toBe('healthy');
  });

  it('is judged by its worst rendition, and says which', async () => {
    const agent = reporter(evaluators.exposure, { context: served });
    const opinion = await agent.minute(...deliveringExposure(0.4));
    expect(opinion.health).toBe('unhealthy');
    expect(findingOf(opinion, pathMetrics.ready.name)).toMatchObject({
      health: 'unhealthy',
      summary: 'Ready 40% of the last 2 min',
      evidence: [{ dimensions: { rendition: 'quality' }, value: expect.closeTo(0.4) }]
    });
  });

  it('worsens at once, and recovers as soon as it has been well for the recovery window', async () => {
    const agent = reporter(evaluators.exposure, { context: served });
    await agent.minute(...deliveringExposure());
    // The window is two minutes, so the first minute down is half the window: degraded at once, then unhealthy.
    expect((await agent.minute(...deliveringExposure(0))).health).toBe('degraded');
    expect((await agent.minute(...deliveringExposure(0))).health).toBe('unhealthy');

    // A minute well is longer than the recovery window, whatever the two minutes before it hold.
    const recovered = await agent.minute(...deliveringExposure());
    expect(recovered.health).toBe('healthy');
    expect(recovered.state.pending).toBeNull();
    expect(findingOf(recovered, pathMetrics.ready.name)?.summary).toBe('Ready 100% of the last 45 sec');

    // Once taken as recovered, the outage it recovered from isn't judged again, though it is still within two minutes.
    expect((await agent.minute(...deliveringExposure())).health).toBe('healthy');
  });

  it("doesn't count what it can't judge, such as a relay it isn't published to", async () => {
    const agent = reporter(evaluators.exposure, { context: served });
    const opinion = await agent.minute(...deliveringExposure().slice(0, -1));
    expect(opinion.health).toBe('healthy');
    expect(findingOf(opinion, relayMetrics.ingestBitrate.name)).toBeUndefined();
  });

  it('judges only the renditions that are read, and is idle when none is', async () => {
    const agent = reporter(evaluators.exposure, { context: served });
    const unread = (rendition: string) => [
      report(pathMetrics.ready, 0, { rendition }),
      report(pathMetrics.read, 0, { rendition }),
      report(pathMetrics.ingestBitrate, 0, { rendition })
    ];
    const read = [
      report(pathMetrics.ready, 1, { rendition: 'default' }),
      report(pathMetrics.read, 1, { rendition: 'default' }),
      report(pathMetrics.ingestBitrate, 2_400_000, { rendition: 'default' })
    ];
    const partly = await agent.minute(...read, ...unread('quality'));
    expect(partly).toMatchObject({ health: 'healthy', activity: 'active' });

    const idle = await agent.minutes(3, ...unread('default'), ...unread('quality'));
    expect(idle).toMatchObject({ health: 'unknown', activity: 'idle' });
    expect(findingOf(idle, 'demand')?.summary).toBe('Idle: nothing is reading it');
  });

  it('expects a rendition a publisher is planned to read, whether or not the publisher is there', async () => {
    const agent = reporter(evaluators.exposure, { context: { ...served, published: ['default'] } });
    const opinion = await agent.minute(
      report(pathMetrics.ready, 0, { rendition: 'default' }),
      report(pathMetrics.read, 0, { rendition: 'default' }),
      report(pathMetrics.ingestBitrate, 0, { rendition: 'default' })
    );
    expect(opinion).toMatchObject({ health: 'unhealthy', activity: 'active' });
  });

  it('is unhealthy when its publisher reads little of what the path receives', async () => {
    const agent = reporter(evaluators.exposure, { context: { ...served, published: ['default'] } });
    const opinion = await agent.minute(
      report(pathMetrics.ready, 1, { rendition: 'default' }),
      report(pathMetrics.ingestBitrate, 2_000_000, { rendition: 'default' }),
      report(pathMetrics.publisherEgressBitrate, 100_000, { rendition: 'default' })
    );
    expect(findingOf(opinion, pathMetrics.publisherEgressBitrate.name)).toMatchObject({
      health: 'unhealthy',
      summary: 'Its publisher read 5% of what the path received in the last 2 min'
    });
  });

  it('judges the relay by whether it has the rendition, whoever is watching', async () => {
    const agent = reporter(evaluators.exposure, { context: relayed });
    const unwatched = [report(relayMetrics.ingestBitrate, 884), report(relayMetrics.viewers, 1)];
    const there = await agent.minute(report(relayMetrics.announced, 1, { rendition: 'default' }), ...unwatched);
    expect(there).toMatchObject({ health: 'healthy', activity: 'active' });

    const gone = await agent.minutes(2, report(relayMetrics.announced, 0, { rendition: 'default' }), ...unwatched);
    expect(gone).toMatchObject({ health: 'unhealthy', activity: 'active' });
    expect(findingOf(gone, relayMetrics.announced.name)?.summary).toBe('On the relay 0% of the last 105 sec');
  });

  it("doesn't judge the relay by what it carries, from an agent that says nothing else of it", async () => {
    const agent = reporter(evaluators.exposure, { context: relayed });
    const opinion = await agent.minute(report(relayMetrics.ingestBitrate, 0), report(relayMetrics.viewers, 2));
    expect(opinion).toMatchObject({ health: 'unknown', activity: 'active' });
    expect(findingOf(opinion, relayMetrics.announced.name)?.summary).toBe(
      "Its agent doesn't say whether the relay has it"
    );
  });

  it('is off while its camera is switched off', async () => {
    const agent = reporter(evaluators.exposure, { context: { ...served, sourceOff: true } });
    const opinion = await agent.minute(...deliveringExposure(0));
    expect(opinion).toMatchObject({ health: 'unknown', activity: 'off' });
  });
});

describe('program', () => {
  const encoding = { fps: 30 };

  /** A minute of OBS publishing the programme at `fps`. */
  function publishing(fps: number) {
    return [
      report(programMetrics.ready, 1),
      report(programMetrics.fallback, 0),
      report(programMetrics.fps, fps),
      report(programMetrics.renderSkipped, 0),
      report(programMetrics.outputSkipped, 0),
      report(programMetrics.congestion, 0),
      report(programMetrics.reconnecting, 0)
    ];
  }

  it('is healthy at the frame rate the output encodes at', async () => {
    const output = reporter(evaluators.program, { context: encoding });
    expect((await output.minute(...publishing(30))).health).toBe('healthy');
  });

  it("is degraded below the output's frame rate", async () => {
    const output = reporter(evaluators.program, { context: encoding });
    const opinion = await output.minute(...publishing(20));
    expect(opinion.health).toBe('degraded');
    expect(findingOf(opinion, programMetrics.fps.name)?.health).toBe('degraded');
  });

  it('is unhealthy for any reconnection in the window, however brief', async () => {
    const output = reporter(evaluators.program, { context: encoding });
    const blip = reportSamples(programMetrics.reconnecting, { min: 0, max: 1, avg: 0.1, last: 0 });
    const opinion = await output.minute(...publishing(30).slice(0, -1), blip);
    expect(opinion.health).toBe('unhealthy');
  });

  it("is degraded on the offline segment, and doesn't judge OBS by stats it isn't sending", async () => {
    const output = reporter(evaluators.program, { context: encoding });
    const opinion = await output.minute(report(programMetrics.ready, 1), report(programMetrics.fallback, 1));
    expect(opinion.health).toBe('degraded');
    expect(findingOf(opinion, programMetrics.fallback.name)?.summary).toBe(
      'On the offline segment 100% of the last 2 min'
    );
    expect(output.reads).not.toContain(programMetrics.fps.name);
  });

  it('is unknown once its output is gone', async () => {
    const output = reporter(evaluators.program, { context: undefined });
    expect((await output.minute(...publishing(30))).health).toBe('unknown');
  });
});

const OUTPUT = '0199e8b2-0000-7000-8000-00000000000d';

describe('forward', () => {
  it('is unhealthy while switched on and not connected', async () => {
    const output = reporter(evaluators.forward, { context: { enabled: true, outputId: OUTPUT } });
    const opinion = await output.minute(report(forwardMetrics.connected, 0), report(forwardMetrics.egressBitrate, 0));
    expect(opinion.health).toBe('unhealthy');
  });

  it("isn't judged while switched off, whatever it reports", async () => {
    const output = reporter(evaluators.forward, { context: { enabled: false, outputId: OUTPUT } });
    const opinion = await output.minute(report(forwardMetrics.connected, 0), report(forwardMetrics.egressBitrate, 0));
    expect(opinion).toMatchObject({ health: 'unknown', activity: 'off' });
    expect(findingOf(opinion, 'enabled')?.summary).toBe('Switched off');
  });

  it('is unhealthy when it sends little of what the programme receives', async () => {
    const output = reporter(evaluators.forward, { context: { enabled: true, outputId: OUTPUT } });
    const opinion = await output.minute(
      report(forwardMetrics.connected, 1),
      report(forwardMetrics.egressBitrate, 300_000),
      about(programSubject(OUTPUT), report(programMetrics.ingestBitrate, 6_000_000))
    );
    expect(findingOf(opinion, forwardMetrics.egressBitrate.name)).toMatchObject({
      health: 'unhealthy',
      summary: 'The forward sent 5% of what the programme received in the last 2 min'
    });
  });
});

describe('channel', () => {
  it('gives the platform two minutes to notice a stream before going unhealthy', async () => {
    const output = reporter(evaluators.channel, { context: { forwarded: true } });
    await output.minutes(3, report(channelMetrics.live, 1));
    const offline = report(channelMetrics.live, 0);
    expect((await output.minute(offline)).health).toBe('healthy');
    expect((await output.minute(offline)).health).toBe('healthy');
    expect((await output.minute(offline)).health).toBe('unhealthy');
  });

  it("isn't judged offline when nothing forwards to it", async () => {
    const output = reporter(evaluators.channel, { context: { forwarded: false } });
    expect(await output.minute(report(channelMetrics.live, 0))).toMatchObject({ health: 'unknown', activity: 'off' });
  });
});

describe('device', () => {
  it('is unhealthy when its disk is nearly full, and says how full', async () => {
    const agent = reporter(evaluators.device, { context: { kind: 'agent', cameraState: null } });
    const opinion = await agent.minute(
      report(machineMetrics.cpuUtilisation, 40),
      report(machineMetrics.memoryTotal, 8 * GB),
      report(machineMetrics.memoryAvailable, 4 * GB),
      report(machineMetrics.diskTotal, 100 * GB),
      report(machineMetrics.diskFree, 2 * GB)
    );
    expect(opinion.health).toBe('unhealthy');
    expect(findingOf(opinion, machineMetrics.diskFree.name)?.summary).toBe('Disk 2% free');
    expect(findingOf(opinion, machineMetrics.memoryAvailable.name)?.health).toBe('healthy');
  });

  it('judges a camera by whether it answers the probe, unless it is switched off', async () => {
    const camera = reporter(evaluators.device, { context: { kind: 'camera', cameraState: 'enabled' } });
    expect((await camera.minute(report(cameraMetrics.reachable, 1))).health).toBe('healthy');
    const unreachable = await camera.minutes(2, report(cameraMetrics.reachable, 0));
    expect(unreachable.health).toBe('unhealthy');
    expect(findingOf(unreachable, cameraMetrics.reachable.name)?.summary).toBe('Reachable 0% of the last 105 sec');

    camera.context = { kind: 'camera', cameraState: 'disabled' };
    expect(await camera.minute(report(cameraMetrics.reachable, 0))).toMatchObject({
      health: 'unknown',
      activity: 'off'
    });
  });
});
