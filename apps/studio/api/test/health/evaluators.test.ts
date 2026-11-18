import {
  channelMetrics,
  forwardMetrics,
  machineMetrics,
  pathMetrics,
  programMetrics,
  relayMetrics
} from '@conservationtv/reports';
import { describe, expect, it } from 'vitest';
import { evaluators } from '../../src/health/evaluators.ts';
import { findingOf, report, reportSamples, reporter } from './harness.ts';

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

describe('exposure', () => {
  it('is healthy while every rendition delivers', async () => {
    const agent = reporter(evaluators.exposure, { context: null });
    const opinion = await agent.minute(...deliveringExposure());
    expect(opinion.health).toBe('healthy');
  });

  it('is judged by its worst rendition, and says which', async () => {
    const agent = reporter(evaluators.exposure, { context: null });
    const opinion = await agent.minute(...deliveringExposure(0.4));
    expect(opinion.health).toBe('unhealthy');
    expect(findingOf(opinion, pathMetrics.ready.name)).toMatchObject({
      health: 'unhealthy',
      summary: 'Ready 40% of the last 2 min',
      evidence: [{ dimensions: { rendition: 'quality' }, value: expect.closeTo(0.4) }]
    });
  });

  it('worsens at once, and recovers only once the better verdict has held for a minute', async () => {
    const agent = reporter(evaluators.exposure, { context: null });
    await agent.minute(...deliveringExposure());
    // The window is two minutes, so the first minute down is half the window: degraded at once, then unhealthy.
    expect((await agent.minute(...deliveringExposure(0))).health).toBe('degraded');
    expect((await agent.minute(...deliveringExposure(0))).health).toBe('unhealthy');

    const recovering = await agent.minute(...deliveringExposure());
    expect(recovering.health).toBe('unhealthy');
    expect(recovering.state.pending).toMatchObject({ health: 'degraded' });

    expect((await agent.minute(...deliveringExposure())).health).toBe('healthy');
  });

  it("doesn't count what it can't judge, such as a relay it isn't published to", async () => {
    const agent = reporter(evaluators.exposure, { context: null });
    const opinion = await agent.minute(...deliveringExposure().slice(0, -1));
    expect(opinion.health).toBe('healthy');
    expect(findingOf(opinion, relayMetrics.ingestBitrate.name)?.health).toBe('unknown');
  });
});

describe('program', () => {
  const show = { fps: 30 };

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

  it('is healthy at the frame rate the show encodes at', async () => {
    const output = reporter(evaluators.program, { context: show });
    expect((await output.minute(...publishing(30))).health).toBe('healthy');
  });

  it("is degraded below the show's frame rate", async () => {
    const output = reporter(evaluators.program, { context: show });
    const opinion = await output.minute(...publishing(20));
    expect(opinion.health).toBe('degraded');
    expect(findingOf(opinion, programMetrics.fps.name)?.health).toBe('degraded');
  });

  it('is unhealthy for any reconnection in the window, however brief', async () => {
    const output = reporter(evaluators.program, { context: show });
    const blip = reportSamples(programMetrics.reconnecting, { min: 0, max: 1, avg: 0.1, last: 0 });
    const opinion = await output.minute(...publishing(30).slice(0, -1), blip);
    expect(opinion.health).toBe('unhealthy');
  });

  it("is degraded on the offline segment, and doesn't judge OBS by stats it isn't sending", async () => {
    const output = reporter(evaluators.program, { context: show });
    const opinion = await output.minute(report(programMetrics.ready, 1), report(programMetrics.fallback, 1));
    expect(opinion.health).toBe('degraded');
    expect(findingOf(opinion, programMetrics.fallback.name)?.summary).toBe(
      'On the offline segment 100% of the last 2 min'
    );
    expect(output.reads).not.toContain(programMetrics.fps.name);
  });

  it('is unknown once its show is gone', async () => {
    const output = reporter(evaluators.program, { context: undefined });
    expect((await output.minute(...publishing(30))).health).toBe('unknown');
  });
});

describe('forward', () => {
  it('is unhealthy while switched on and not connected', async () => {
    const output = reporter(evaluators.forward, { context: { enabled: true } });
    const opinion = await output.minute(report(forwardMetrics.connected, 0), report(forwardMetrics.egressBitrate, 0));
    expect(opinion.health).toBe('unhealthy');
  });

  it('is healthy while switched off, whatever it reports', async () => {
    const output = reporter(evaluators.forward, { context: { enabled: false } });
    const opinion = await output.minute(report(forwardMetrics.connected, 0), report(forwardMetrics.egressBitrate, 0));
    expect(opinion.health).toBe('healthy');
    expect(findingOf(opinion, 'enabled')?.summary).toBe('Switched off');
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

  it('is healthy offline when nothing forwards to it', async () => {
    const output = reporter(evaluators.channel, { context: { forwarded: false } });
    expect((await output.minute(report(channelMetrics.live, 0))).health).toBe('healthy');
  });
});

describe('device', () => {
  it('is unhealthy when its disk is nearly full, and says how full', async () => {
    const agent = reporter(evaluators.device, { context: null });
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
});
