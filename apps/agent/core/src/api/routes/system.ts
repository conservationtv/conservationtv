import { operationVersion, versionMismatch } from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { useSystem } from '../../system/system.ts';

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'system.get',
      ...operationVersion(1),
      summary: "Read the agent's runtimes",
      description:
        "Each runtime's live status, and whether it has accepted its latest spec. Live, never stored: after a restart " +
        'it is rebuilt from the runtimes.',
      responses: {
        200: { description: "Every runtime's status" },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      // As it was before cameras were probed: each key named, in the order it always was.
      const { machine, streams, metrics, relayTraffic, obs, channels, show } = await system.status();
      c.header('Cache-Control', 'no-store');
      return c.json({ machine, streams, metrics, relayTraffic, obs, channels, show }, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'system.get',
      ...operationVersion(2),
      summary: "Read the agent's runtimes",
      description:
        "Each runtime's live status, and whether it has accepted its latest spec. Live, never stored: after a restart " +
        'it is rebuilt from the runtimes. From this version, with `probes`: the cameras it asks whether they are there.',
      responses: {
        200: { description: "Every runtime's status" },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      const status = await system.status();
      c.header('Cache-Control', 'no-store');
      return c.json(status, 200);
    }
  )
  .get(
    '/spec',
    describeRoute({
      operationId: 'system.spec',
      ...operationVersion(1),
      summary: "Read the agent's currently defined spec",
      responses: {
        200: { description: 'The current system specification' },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      // As it was before cameras were probed.
      const { machine, streams, metrics, relayTraffic, obs, channels, show } = system.spec();
      c.header('Cache-Control', 'no-store');

      return c.json({ machine, streams, metrics, relayTraffic, obs, channels, show }, 200);
    }
  )
  .get(
    '/spec',
    describeRoute({
      operationId: 'system.spec',
      ...operationVersion(2),
      summary: "Read the agent's currently defined spec",
      description: 'From this version, with `probes`: the cameras it asks whether they are there.',
      responses: {
        200: { description: 'The current system specification' },
        412: versionMismatch
      }
    }),
    async c => {
      const system = useSystem();
      const spec = system.spec();
      c.header('Cache-Control', 'no-store');

      return c.json(spec, 200);
    }
  );
