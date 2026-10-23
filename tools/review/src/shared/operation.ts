import { z } from 'zod';

// One operation version as API documentation: every reference resolved, descriptions kept. The Worker builds it from
// an API document; the app renders it, and compares the two sides of a changed operation field by field.

/** A JSON Schema, as far as documenting one goes. */
export const SchemaNodeSchema = z.object({
  /** The component it was referenced as, such as `Camera`. */
  'x-ref': z.string().optional(),
  /** Set where a schema refers back to itself, which is not expanded again. */
  'x-recursive': z.boolean().optional(),
  type: z.union([z.string(), z.array(z.string())]).optional(),
  format: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.json()).optional(),
  const: z.json().optional(),
  default: z.json().optional(),
  pattern: z.string().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minItems: z.number().optional(),
  maxItems: z.number().optional(),
  required: z.array(z.string()).optional(),
  get properties() {
    return z.record(z.string(), SchemaNodeSchema).optional();
  },
  get items() {
    return SchemaNodeSchema.optional();
  },
  get additionalProperties() {
    return z.union([z.boolean(), SchemaNodeSchema]).optional();
  },
  get oneOf() {
    return z.array(SchemaNodeSchema).optional();
  },
  get anyOf() {
    return z.array(SchemaNodeSchema).optional();
  },
  get allOf() {
    return z.array(SchemaNodeSchema).optional();
  }
});
export type SchemaNode = z.output<typeof SchemaNodeSchema>;

export const ParameterDocSchema = z.object({
  name: z.string(),
  /** `path`, `query`, `header` or `cookie`. */
  in: z.string(),
  required: z.boolean(),
  description: z.string().nullable(),
  schema: SchemaNodeSchema.nullable()
});
export type ParameterDoc = z.output<typeof ParameterDocSchema>;

export const ResponseDocSchema = z.object({
  status: z.string(),
  description: z.string(),
  schema: SchemaNodeSchema.nullable()
});
export type ResponseDoc = z.output<typeof ResponseDocSchema>;

export const OperationDocSchema = z.object({
  method: z.string(),
  path: z.string(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  parameters: z.array(ParameterDocSchema),
  requestBody: z
    .object({ required: z.boolean(), description: z.string().nullable(), schema: SchemaNodeSchema.nullable() })
    .nullable(),
  responses: z.array(ResponseDocSchema)
});
export type OperationDoc = z.output<typeof OperationDocSchema>;

/** One side of an operation: its documentation, and its contract as the checks compare it. */
export const OperationSideSchema = z.object({
  doc: OperationDocSchema,
  /** References resolved, prose left out, laid out as JSON. */
  contract: z.string()
});
export type OperationSide = z.output<typeof OperationSideSchema>;

/** An operation where the head branch left its base, and at the head; null on the side it does not exist on. */
export const OperationDocsSchema = z.object({
  before: OperationSideSchema.nullable(),
  after: OperationSideSchema.nullable()
});
export type OperationDocs = z.output<typeof OperationDocsSchema>;
