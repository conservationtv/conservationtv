import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@hey-api/openapi-ts';
import { parse } from 'yaml';
import { z } from 'zod';
import { mediamtxVersion } from '../mediamtx-version.js';
import config from '../openapi-ts.config.js';

// Rebuilds src/generated for the MediaMTX release pinned in mediamtx-version.ts, in four steps:
// 1. Fetches MediaMTX's OpenAPI spec and sample config at that tag into spec/, so a version bump shows up as a diff.
// 2. Derives spec/config.json: an OpenAPI document whose root schema, MediamtxConfig, is the shape of mediamtx.yml.
//    The API describes the global settings (GlobalConf) and a path's settings (PathConf) apart; the file is the
//    global settings, plus `pathDefaults` and the `paths` map, each a PathConf. And spec/api.json: the API itself,
//    as JSON with its 64-bit integers made plain numbers, for the client.
// 3. Generates the types, Zod schemas and API client from them with openapi-ts.config.ts.
// 4. Parses the sample config with the generated schema, so a spec that has drifted from the config file fails here.

interface Schema {
  type?: string;
  $ref?: string;
  properties?: Record<string, Schema>;
  additionalProperties?: Schema | boolean;
}

interface Components {
  schemas: Record<string, Schema>;
}

interface Document {
  components: Components;
}

const source = `https://raw.githubusercontent.com/bluenviron/mediamtx/${mediamtxVersion}/`;
const spec = new URL('../spec/', import.meta.url);
const generated = new URL('../src/generated/', import.meta.url);

/** Fetches a file from the pinned tag and keeps a copy in spec/. */
async function download(path: string): Promise<string> {
  const response = await fetch(new URL(path, source));
  if (!response.ok) throw new Error(`Fetching ${path} at ${mediamtxVersion}: HTTP ${response.status}`);
  const text = await response.text();
  await writeFile(new URL(path.split('/').at(-1)!, spec), text);
  return text;
}

const reference = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** The names of the schemas `root` refers to, directly or through the schemas it refers to. */
function referenced(root: Schema, schemas: Components['schemas']): Set<string> {
  const found = new Set<string>();
  const pending = [root];
  for (const schema of pending) {
    for (const [, name] of JSON.stringify(schema).matchAll(/"#\/components\/schemas\/(\w+)"/gu)) {
      if (found.has(name!)) continue;
      found.add(name!);
      pending.push(schemas[name!]!);
    }
  }
  return found;
}

// int64 and uint64 settings would be generated as bigints; in a config file and in the API's JSON they are plain
// numbers.
const api: Document = parse(await download('api/openapi.yaml'), (key, value) =>
  key === 'format' && (value === 'int64' || value === 'uint64') ? undefined : value
);
await writeFile(new URL('api.json', spec), `${JSON.stringify(api, null, 2)}\n`);
const sample = await download('mediamtx.yml');

const { GlobalConf, PathConf } = api.components.schemas;
if (!GlobalConf?.properties || !PathConf?.properties) {
  throw new Error(`MediaMTX ${mediamtxVersion}'s OpenAPI spec has no GlobalConf or PathConf`);
}
// The API reports each path's name in its settings; in the file it is the key in `paths`.
delete PathConf.properties.name;

const root: Schema = {
  type: 'object',
  properties: {
    ...GlobalConf.properties,
    pathDefaults: reference('PathConf'),
    paths: { type: 'object', additionalProperties: reference('PathConf') }
  }
};
const schemas = Object.fromEntries(
  [...referenced(root, api.components.schemas)].map(name => [name, api.components.schemas[name]!])
);
await writeFile(
  new URL('config.json', spec),
  `${JSON.stringify(
    {
      openapi: '3.0.0',
      info: { title: `MediaMTX ${mediamtxVersion} config`, version: mediamtxVersion },
      paths: {},
      components: { schemas: { MediamtxConfig: root, ...schemas } }
    },
    null,
    2
  )}\n`
);

await createClient(await config);

// MediaMTX rejects settings it doesn't know, so every object in the config is strict and a misspelt key is an error.
// The Zod plugin ignores `additionalProperties: false`, so its objects are made strict here.
const zod = new URL('zod.gen.ts', generated);
await writeFile(zod, (await readFile(zod, 'utf8')).replaceAll('z.object(', 'z.strictObject('));

// The sample leaves unset settings empty (`runOnInit:`), which YAML reads as null and MediaMTX as unset.
const { MediamtxConfigSchema } = await import('../src/index.js');
const result = MediamtxConfigSchema.safeParse(parse(sample, (_key, value) => (value === null ? undefined : value)));
if (!result.success) {
  throw new Error(
    `MediaMTX ${mediamtxVersion}'s sample config doesn't match the schema:\n${z.prettifyError(result.error)}`
  );
}
