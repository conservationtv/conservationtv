import { errorResponse, operationVersion, validator, versionMismatch } from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { SpecConflict } from '../errors.ts';
import { type MediamtxPath, MediamtxPathSchema } from '../runtimes/mediamtx/index.ts';
import { useSpecApi, useSystem } from '../system.ts';

// A path's name may contain slashes, so callers URL-encode it.
const PathParamsSchema = MediamtxPathSchema.pick({ name: true });
export type PathParams = z.output<typeof PathParamsSchema>;
const PathBodySchema = MediamtxPathSchema.omit({ name: true });
export type PathBody = z.output<typeof PathBodySchema>;

const invalidRequest = errorResponse('The request is malformed');
const notConfigurable = errorResponse(
  'The agent is configured by the studio, so its spec is not changed over this API; or MediaMTX is not running'
);
const invalidSpec = errorResponse(
  'The change would leave the spec invalid, such as two paths delivering the same exposure and rendition'
);

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
      const spec = system.spec();
      c.header('Cache-Control', 'no-store');

      return c.json(spec, 200);
    }
  )
  .put(
    '/spec/mediamtx/paths/:name',
    describeRoute({
      operationId: 'system.paths.put',
      ...operationVersion(1),
      summary: 'Serve a MediaMTX path, or change one',
      description:
        'Direct agents only. Accepted once saved and handed to MediaMTX, not once it serves it: `system.get` says how ' +
        'far it has got.',
      responses: {
        200: { description: 'The paths MediaMTX serves' },
        400: invalidRequest,
        409: notConfigurable,
        412: versionMismatch,
        422: invalidSpec
      }
    }),
    validator('param', PathParamsSchema),
    validator('json', PathBodySchema),
    async c => {
      const { name } = c.req.valid('param');
      const body = c.req.valid('json');
      const path: MediamtxPath = { name, ...body };
      const api = useSpecApi();
      await api.update(draft => {
        const mediamtx = draft.mediamtx;
        if (mediamtx === undefined) throw new SpecConflict('MediaMTX is not running');
        const index = mediamtx.paths.findIndex(existing => existing.name === name);
        if (index === -1) mediamtx.paths.push(path);
        else mediamtx.paths[index] = path;
      });
      const spec = api.spec();
      const paths = spec.mediamtx?.paths ?? [];
      c.header('Cache-Control', 'no-store');
      return c.json({ paths }, 200);
    }
  )
  .delete(
    '/spec/mediamtx/paths/:name',
    describeRoute({
      operationId: 'system.paths.delete',
      ...operationVersion(1),
      summary: 'Stop serving a MediaMTX path',
      description: 'Direct agents only. Succeeds when there was no such path.',
      responses: {
        200: { description: 'The paths MediaMTX serves' },
        400: invalidRequest,
        409: notConfigurable,
        412: versionMismatch,
        422: invalidSpec
      }
    }),
    validator('param', PathParamsSchema),
    async c => {
      const { name } = c.req.valid('param');
      const api = useSpecApi();
      await api.update(draft => {
        const mediamtx = draft.mediamtx;
        if (mediamtx === undefined) return;
        mediamtx.paths = mediamtx.paths.filter(existing => existing.name !== name);
      });
      const spec = api.spec();
      const paths = spec.mediamtx?.paths ?? [];
      c.header('Cache-Control', 'no-store');
      return c.json({ paths }, 200);
    }
  );
