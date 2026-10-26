import { contractsOf, type ReleaseDocument } from '@conservationtv/versioned-api/contracts/compare';
import { z } from 'zod';
import {
  OperationDocSchema,
  SchemaNodeSchema,
  type OperationDoc,
  type OperationDocs,
  type OperationSide,
  type SchemaNode
} from '../shared/operation.ts';
import { documentOrEmpty, locate, pretty, type Located } from './contracts.ts';
import { CompareSchema, PullDetailSchema, useGitHub } from './github.ts';

type Json = z.output<ReturnType<typeof z.json>>;
const JsonObjectSchema = z.record(z.string(), z.json());
type JsonObject = z.output<typeof JsonObjectSchema>;

function lookup(document: ReleaseDocument, pointer: string): Json | undefined {
  // A local JSON Pointer, `#/components/schemas/Camera`, with its `~1` and `~0` escapes.
  let node: Json | undefined = document;
  for (const part of pointer.slice(2).split('/')) {
    const object = JsonObjectSchema.safeParse(node);
    node = object.success ? object.data[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  return node;
}

/**
 * Every local reference replaced by what it refers to, named by it in `x-ref`, keeping descriptions. A reference to
 * a schema already being expanded is left as a named marker, so recursive schemas end.
 */
function resolve(value: Json, document: ReleaseDocument, trail: readonly string[]): Json {
  if (Array.isArray(value)) return value.map(item => resolve(item, document, trail));
  const object = JsonObjectSchema.safeParse(value);
  if (!object.success) return value;
  const { $ref: reference, ...siblings } = object.data;
  const pointer = z.string().startsWith('#/').safeParse(reference);
  const resolvedSiblings = Object.fromEntries(
    Object.entries(siblings).map(([key, child]) => [key, resolve(child, document, trail)])
  );
  if (!pointer.success) return reference === undefined ? resolvedSiblings : { ...resolvedSiblings, $ref: reference };
  const name = pointer.data.split('/').at(-1) ?? pointer.data;
  if (trail.includes(pointer.data)) return { 'x-ref': name, 'x-recursive': true };
  const target = JsonObjectSchema.safeParse(
    resolve(lookup(document, pointer.data) ?? {}, document, [...trail, pointer.data])
  );
  const resolved: JsonObject = target.success ? target.data : {};
  return { 'x-ref': name, ...resolved, ...resolvedSiblings };
}

const ContentSchema = z.record(z.string(), z.object({ schema: z.json().optional() })).optional();
type Content = z.output<typeof ContentSchema>;
const RawParameterSchema = z.object({
  name: z.string(),
  in: z.string(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  schema: z.json().optional()
});
export type RawParameter = z.output<typeof RawParameterSchema>;
const RawParametersSchema = z.object({ parameters: z.array(RawParameterSchema).optional() });
export type RawParameters = z.output<typeof RawParametersSchema>;
const RawOperationSchema = RawParametersSchema.extend({
  requestBody: z
    .object({ required: z.boolean().optional(), description: z.string().optional(), content: ContentSchema })
    .optional(),
  responses: z.record(z.string(), z.object({ description: z.string().optional(), content: ContentSchema })).optional()
});
export type RawOperation = z.output<typeof RawOperationSchema>;

/** A body's JSON schema, or its first media type's. Schemas this view cannot read are left out rather than failing. */
function schemaOf(value: Json | undefined): SchemaNode | null {
  if (value === undefined) return null;
  return SchemaNodeSchema.safeParse(value).data ?? null;
}

/** A body's schema: its JSON one, else its first media type's, else none. */
function contentSchema(content: Content): SchemaNode | null {
  const media = content?.['application/json'] ?? Object.values(content ?? {})[0];
  return schemaOf(media?.schema);
}

/** An operation as documentation: its own parameters over its path's, its body, and its responses by status. */
function describe(located: Located): OperationDoc {
  const { document } = located;
  const operation = RawOperationSchema.parse(resolve(located.raw, document, []));
  const shared = RawParametersSchema.parse(resolve(located.item, document, [])).parameters ?? [];
  const own = operation.parameters ?? [];
  const parameters = [...shared.filter(p => !own.some(o => o.in === p.in && o.name === p.name)), ...own];
  const body = operation.requestBody;
  return OperationDocSchema.parse({
    method: located.method,
    path: located.path,
    summary: located.operation.summary ?? null,
    description: located.operation.description ?? null,
    parameters: parameters.map(parameter => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required ?? false,
      description: parameter.description ?? null,
      schema: schemaOf(parameter.schema)
    })),
    requestBody: body
      ? { required: body.required ?? false, description: body.description ?? null, schema: contentSchema(body.content) }
      : null,
    responses: Object.entries(operation.responses ?? {})
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([status, response]) => ({
        status,
        description: response.description ?? '',
        schema: contentSchema(response.content)
      }))
  });
}

function side(document: ReleaseDocument, operation: string): OperationSide | null {
  const contract = contractsOf(document).get(operation);
  const located = locate([document], operation);
  if (!contract || !located) return null;
  return { doc: describe(located), contract: pretty(contract) };
}

/** One operation of one API document, where the pull request's head branch left its base and at its head. */
export async function operationDocs(number: number, document: string, operation: string): Promise<OperationDocs> {
  const github = useGitHub();
  const pull = await github.api(`pulls/${number}`, PullDetailSchema, 'live');
  const compare = await github.api(`compare/${pull.base.sha}...${pull.head.sha}`, CompareSchema, 'immutable');
  const [previous, current] = await Promise.all([
    documentOrEmpty(compare.merge_base_commit.sha, document),
    documentOrEmpty(pull.head.sha, document)
  ]);
  return { before: side(previous, operation), after: side(current, operation) };
}
