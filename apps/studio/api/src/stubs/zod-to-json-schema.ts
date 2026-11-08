// Bundled in place of `zod-to-json-schema` (see vite.config.ts), which hono-openapi's schema conversion loads for zod
// v3 schemas, pulling zod's v3 layer in with it. Ours are zod v4 schemas, converted natively, and only when generating
// the OpenAPI document, which runs in Node rather than in this Worker.

export const zodToJsonSchema = (): never => {
  throw new Error('zod-to-json-schema is not bundled in the studio API Worker');
};

export default zodToJsonSchema;
