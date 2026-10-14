// Fills in the spec's responses from the routes' inferred types: the same types a Hono RPC client sees. Routes only
// describe their responses; what a handler passes to `c.json` is the source of truth for the body.
import { STATUS_CODES } from 'node:http';
import type { generateSpecs } from 'hono-openapi';
import pluralize from 'pluralize';
import ts from 'typescript-api';
import { z } from 'zod';
import type { ContractsProject } from './config.js';

/** The subset of JSON Schema this script writes. */
interface JsonSchema {
  $ref?: string;
  type?: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  const?: string | number | boolean;
  enum?: string[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema;
}

interface MediaType {
  schema: JsonSchema;
}

interface OpenApiResponse {
  description: string;
  content?: Record<string, MediaType>;
}

interface Operation {
  operationId?: string;
  'x-operation-version'?: number;
  responses?: Record<string, OpenApiResponse>;
}

const methods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
type Method = (typeof methods)[number];
type PathItem = Partial<Record<Method, Operation>>;

interface Components {
  schemas?: Record<string, JsonSchema>;
}

/** The parts of the generated document this script reads and writes. */
interface Spec {
  paths?: Record<string, PathItem | undefined>;
  components?: Components;
}

/** What one `c.json`, `c.text` or `c.body` call in a handler responds with. */
interface RouteOutput {
  format: string;
  output: ts.Type;
}

/** A JSON response body, kept so resources can be named once every operation's body is known. */
interface JsonBody {
  operationId: string;
  media: MediaType;
}

type Project = Pick<ContractsProject, 'tsconfig' | 'source' | 'schemas'>;

function entrySource(project: Project): string {
  // Schemas with a `meta({ id })` name the same types wherever they appear in a response.
  const named = Object.entries(project.schemas).flatMap(([key, value]) => {
    const id = value instanceof z.ZodType ? z.globalRegistry.get(value)?.id : undefined;
    return id ? [`  ${JSON.stringify(id)}: JSONParsed<z.output<typeof schemas.${key}>>;`] : [];
  });
  return `
import type { ExtractSchema } from 'hono/types';
import type { JSONParsed } from 'hono/utils/types';
import type { z } from 'zod';
import type app from '${project.source.app}';
import type * as schemas from '${project.source.schemas}';
export type Routes = ExtractSchema<typeof app>;
export type Named = {
${named.join('\n')}
};
`;
}

function createChecker(project: Project) {
  const entry = `${project.source.dir}__responses__.ts`;
  const source = entrySource(project);
  const config = ts.getParsedCommandLineOfConfigFile(
    project.tsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      }
    }
  );
  if (!config) throw new Error(`Could not read ${project.tsconfig}`);

  const host = ts.createCompilerHost(config.options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = file => file === entry || fileExists(file);
  host.readFile = file => (file === entry ? source : readFile(file));
  host.getSourceFile = (file, language, ...rest) =>
    file === entry ? ts.createSourceFile(file, source, language) : getSourceFile(file, language, ...rest);

  // The config's own files bring the Worker's ambient types.
  const program = ts.createProgram([...config.fileNames, entry], config.options, host);
  // A type error anywhere in the app can widen a route's types, so refuse to describe them.
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    throw new Error(ts.formatDiagnostics(diagnostics, { ...host, getNewLine: () => '\n' }));
  }

  const checker = program.getTypeChecker();
  const file = program.getSourceFile(entry)!;
  const alias = (name: string) => {
    const declaration = file.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === name
    )!;
    return checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(declaration.name)!);
  };
  return { checker, program, routes: alias('Routes'), named: alias('Named') };
}

const property = (checker: ts.TypeChecker, type: ts.Type, name: string) =>
  checker.getTypeOfSymbol(checker.getPropertyOfType(type, name)!);
const stringLiterals = (types: ts.Type[]) =>
  types.filter((type): type is ts.StringLiteralType => type.isStringLiteral());
const enumKey = (literals: ts.StringLiteralType[]) => JSON.stringify(literals.map(literal => literal.value).sort());
const isMethod = (name: string): name is Method => methods.some(method => method === name);

const primitives: [ts.TypeFlags, JsonSchema][] = [
  [ts.TypeFlags.Any | ts.TypeFlags.Unknown, {}],
  [ts.TypeFlags.Null, { type: 'null' }],
  [ts.TypeFlags.Boolean, { type: 'boolean' }],
  [ts.TypeFlags.String, { type: 'string' }],
  [ts.TypeFlags.Number, { type: 'number' }]
];

function leafSchema(checker: ts.TypeChecker, type: ts.Type): JsonSchema | undefined {
  // Primitives and literals. Hono's recursive JSONValue, like `unknown`, stands for any JSON.
  if (type.aliasSymbol?.name === 'JSONValue') return {};
  const primitive = primitives.find(([flags]) => type.flags & flags);
  if (primitive) return { ...primitive[1] };
  if (type.isStringLiteral()) return { type: 'string', const: type.value };
  if (type.isNumberLiteral()) return { type: 'number', const: type.value };
  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return { type: 'boolean', const: checker.typeToString(type) === 'true' };
  return undefined;
}

function isOptional(symbol: ts.Symbol, type: ts.Type): boolean {
  if (symbol.flags & ts.SymbolFlags.Optional) return true;
  return type.isUnion() && type.types.some(member => member.flags & ts.TypeFlags.Undefined);
}

/** Converts JSON-shaped types (Hono has already applied `JSONParsed`) to JSON Schema. */
function createConverter(checker: ts.TypeChecker, named: ts.Type) {
  // Named object types keep their identity through `JSONParsed`; literal unions don't, so match those by value.
  const names = new Map<ts.Type, string>();
  const enums = new Map<string, string>();
  for (const symbol of checker.getPropertiesOfType(named)) {
    const type = checker.getTypeOfSymbol(symbol);
    names.set(type, symbol.name);
    const literals = type.isUnion() ? stringLiterals(type.types) : [];
    if (type.isUnion() && literals.length === type.types.length) enums.set(enumKey(literals), symbol.name);
  }

  const components = new Map<string, JsonSchema>();
  const ref = (name: string, build: () => JsonSchema): JsonSchema => {
    if (!components.has(name)) {
      // Claim the name first so a recursive type refers to itself.
      components.set(name, {});
      components.set(name, build());
    }
    return { $ref: `#/components/schemas/${name}` };
  };

  const enumSchema = (literals: ts.StringLiteralType[]): JsonSchema => {
    const values = literals.map(literal => literal.value);
    const name = enums.get(enumKey(literals));
    return name ? ref(name, () => ({ type: 'string', enum: values })) : { type: 'string', enum: values };
  };

  function convert(type: ts.Type): JsonSchema {
    const name = names.get(type);
    return name ? ref(name, () => body(type)) : body(type);
  }

  function body(type: ts.Type): JsonSchema {
    // Leaves first, then the containers, which recurse through `convert` so named types become references.
    const leaf = leafSchema(checker, type);
    if (leaf) return leaf;
    if (type.isUnion()) return unionSchema(type);
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const item = type.getNumberIndexType();
      return { type: 'array', items: item ? convert(item) : {} };
    }
    if (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) return objectSchema(type);
    throw new Error(`Can't describe \`${checker.typeToString(type)}\` as JSON Schema`);
  }

  function unionSchema(type: ts.UnionType): JsonSchema {
    // `undefined` only marks an optional property. String literals collapse into one enum and `true | false` into
    // boolean; null goes last to read as `T | null`, whatever order the checker keeps.
    const members = type.types.filter(member => !(member.flags & ts.TypeFlags.Undefined));
    const literals = stringLiterals(members);
    const booleans = members.filter(member => member.flags & ts.TypeFlags.BooleanLiteral);
    const merged = new Set<ts.Type>([...literals, ...(booleans.length === 2 ? booleans : [])]);
    const variants = members.filter(member => !merged.has(member) && !(member.flags & ts.TypeFlags.Null)).map(convert);
    if (literals.length) variants.unshift(enumSchema(literals));
    if (booleans.length === 2) variants.push({ type: 'boolean' });
    if (members.some(member => member.flags & ts.TypeFlags.Null)) variants.push({ type: 'null' });
    return variants.length === 1 ? variants[0]! : { anyOf: variants };
  }

  function objectSchema(type: ts.Type): JsonSchema {
    // Symbol keys and methods never reach the JSON. A string index signature allows any other keys.
    const schema: JsonSchema = { type: 'object' };
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const symbol of checker.getPropertiesOfType(type)) {
      const propertyType = checker.getTypeOfSymbol(symbol);
      if (symbol.name.startsWith('__@') || propertyType.getCallSignatures().length) continue;
      properties[symbol.name] = convert(propertyType);
      if (!isOptional(symbol, propertyType)) required.push(symbol.name);
    }
    if (Object.keys(properties).length) schema.properties = properties;
    if (required.length) schema.required = required;
    const index = checker.getIndexInfosOfType(type).find(info => info.keyType.flags & ts.TypeFlags.String);
    if (index) schema.additionalProperties = convert(index.type);
    return schema;
  }

  return { convert, components };
}

function outputsByStatus(
  checker: ts.TypeChecker,
  label: string,
  endpoint: ts.Type,
  typedResponse = false
): Map<number, RouteOutput[]> {
  // Hono types an endpoint as one variant per response a handler can make; group them by status.
  const byStatus = new Map<number, RouteOutput[]>();
  for (const variant of endpoint.isUnion() ? endpoint.types : [endpoint]) {
    // The type source determines Hono's field names; both forms carry the same status, format and body.
    const status = property(checker, variant, typedResponse ? '_status' : 'status');
    if (!status.isNumberLiteral()) {
      throw new Error(`${label} responds with status \`${checker.typeToString(status)}\`: pass one explicitly`);
    }
    const format = property(checker, variant, typedResponse ? '_format' : 'outputFormat');
    const output = {
      format: format.isStringLiteral() ? format.value : '',
      output: property(checker, variant, typedResponse ? '_data' : 'output')
    };
    byStatus.set(status.value, [...(byStatus.get(status.value) ?? []), output]);
  }
  return byStatus;
}

function respond(
  operation: Operation,
  status: number,
  outputs: RouteOutput[],
  convert: (type: ts.Type) => JsonSchema
): MediaType | undefined {
  // JSON bodies are described from their types, text is a string, and `c.body(null)` has no content. The route's own
  // description is kept; a status it didn't declare gets the standard reason phrase.
  if (operation.responses == null) operation.responses = {};
  const responses = operation.responses;
  if (responses[status] == null) responses[status] = { description: STATUS_CODES[status] ?? String(status) };
  const response = responses[status];
  const json = outputs.filter(output => output.format === 'json').map(output => convert(output.output));
  if (json.length) {
    const media = { schema: json.length === 1 ? json[0]! : { anyOf: json } };
    response.content = { 'application/json': media };
    return media;
  }
  if (outputs.some(output => output.format === 'text')) {
    response.content = { 'text/plain': { schema: { type: 'string' } } };
  } else if (outputs.every(output => output.format === 'body')) {
    delete response.content;
  }
  return undefined;
}

/** What describing a route needs: the spec to write into, the types to read from, and how to convert them. */
interface Describer {
  spec: Spec;
  checker: ts.TypeChecker;
  convert: (type: ts.Type) => JsonSchema;
}

function describeEndpoint({ spec, checker, convert }: Describer, route: string, method: ts.Symbol): JsonBody[] {
  // `$get` on `/notes/:id` is the spec's `get` on `/notes/{id}`. Routes left out of the spec stay out.
  const name = method.name.slice(1);
  const operation = isMethod(name) ? spec.paths?.[route.replace(/:(\w+)/g, '{$1}')]?.[name] : undefined;
  if (!operation || operation['x-operation-version'] !== undefined) return [];
  const bodies: JsonBody[] = [];
  const label = `${name.toUpperCase()} ${route}`;
  for (const [status, outputs] of outputsByStatus(checker, label, checker.getTypeOfSymbol(method))) {
    const media = respond(operation, status, outputs, convert);
    if (media && operation.operationId) bodies.push({ operationId: operation.operationId, media });
  }
  return bodies;
}

function describeRoutes(describer: Describer, routes: ts.Type): JsonBody[] {
  const { checker } = describer;
  return checker
    .getPropertiesOfType(routes)
    .flatMap(route =>
      checker
        .getPropertiesOfType(checker.getTypeOfSymbol(route))
        .flatMap(method => describeEndpoint(describer, route.name, method))
    );
}

/** `notes.get` → `Note`, matching the operation names the SDK generator derives. */
function resourceName(operationId: string): string {
  const resource = operationId.split('.').at(-2) ?? operationId;
  return pluralize
    .singular(resource)
    .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
    .filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

const itemOf = (schema: JsonSchema) => (schema.type === 'array' && schema.items ? schema.items : schema);
const sameSchema = (a: JsonSchema, b: JsonSchema) => JSON.stringify(a) === JSON.stringify(b);

/** Each resource's object: what its `get` operation returns, or failing that its first operation. */
function chooseResources(bodies: JsonBody[]): Map<string, JsonSchema> {
  const resources = new Map<string, JsonSchema>();
  for (const { operationId, media } of bodies) {
    const item = itemOf(media.schema);
    const name = resourceName(operationId);
    if (item.type === 'object' && (!resources.has(name) || operationId.endsWith('.get'))) resources.set(name, item);
  }
  return resources;
}

function nameResources(bodies: JsonBody[], components: Map<string, JsonSchema>): void {
  // Register each resource's object, then point every body that returns it, or a list of it, at the component.
  const resources = chooseResources(bodies);
  for (const [name, schema] of resources) {
    if (components.has(name)) throw new Error(`${name} is both a resource and a named schema`);
    components.set(name, schema);
  }
  for (const { operationId, media } of bodies) {
    const name = resourceName(operationId);
    const resource = resources.get(name);
    if (!resource || !sameSchema(itemOf(media.schema), resource)) continue;
    const $ref = `#/components/schemas/${name}`;
    media.schema = media.schema.type === 'array' ? { type: 'array', items: { $ref } } : { $ref };
  }
}

interface RouteIdentity {
  id?: string;
  version?: number;
}

/** Read literal metadata separately from the handler's contextual return type. */
function routeIdentity(checker: ts.TypeChecker, options: ts.ObjectLiteralExpression): RouteIdentity {
  const identity: RouteIdentity = {};
  for (const prop of options.properties) {
    // Named operation IDs and version spreads are the two supported pieces of declaration metadata.
    if (ts.isPropertyAssignment(prop) && prop.name.getText().replace(/['"]/g, '') === 'operationId') {
      const type = checker.getTypeAtLocation(prop.initializer);
      if (type.isStringLiteral()) identity.id = type.value;
    }
    if (!ts.isSpreadAssignment(prop) || !ts.isCallExpression(prop.expression)) continue;
    if (prop.expression.expression.getText() !== 'operationVersion') continue;
    const type = checker.getTypeAtLocation(prop.expression.arguments[0]!);
    if (!type.isNumberLiteral()) throw new Error('operationVersion must use a literal version for response inference');
    identity.version = type.value;
  }
  return identity;
}

/** Find a route's first describeRoute call without treating arbitrary source calls as declarations. */
function routeOptions(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  if (!isMethod(node.expression.name.text)) return undefined;
  const description = node.arguments.find(
    arg => ts.isCallExpression(arg) && arg.expression.getText() === 'describeRoute'
  );
  if (!description || !ts.isCallExpression(description)) return undefined;
  const options = description.arguments[0];
  return options && ts.isObjectLiteralExpression(options) ? options : undefined;
}

/** Collect versioned handler return types independently, avoiding Hono's duplicate-path schema intersection. */
function versionedHandlers(program: ts.Program, checker: ts.TypeChecker, src: string): Map<string, ts.Type> {
  const handlers = new Map<string, ts.Type>();
  const visit = (node: ts.Node) => {
    // Only versioned declarations need separate handler types; continue walking all source children.
    const options = routeOptions(node);
    if (options && ts.isCallExpression(node)) {
      const { id, version } = routeIdentity(checker, options);
      if (id && version !== undefined) {
        const handler = node.arguments.at(-1)!;
        const signature = checker.getTypeAtLocation(handler).getCallSignatures()[0];
        if (!signature) throw new Error(`${id}@${version}: cannot infer handler`);
        handlers.set(`${id}@${version}`, checker.getAwaitedType(checker.getReturnTypeOfSignature(signature))!);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of program.getSourceFiles()) {
    if (file.fileName.startsWith(src) && !file.isDeclarationFile) visit(file);
  }
  return handlers;
}

/** Fill one isolated versioned operation from its own handler, never another version at the same path. */
function describeVersion(operation: Operation, handlers: Map<string, ts.Type>, describer: Describer): JsonBody[] {
  const key = `${operation.operationId}@${operation['x-operation-version']}`;
  const handler = handlers.get(key);
  if (!handler) throw new Error(`${key}: no separately inferred handler; use describeRoute and operationVersion`);
  const bodies: JsonBody[] = [];
  for (const [status, outputs] of outputsByStatus(describer.checker, key, handler, true)) {
    const media = respond(operation, status, outputs, describer.convert);
    if (media && operation.operationId) bodies.push({ operationId: operation.operationId, media });
  }
  return bodies;
}

function responseComponents(spec: Spec): Record<string, JsonSchema> {
  if (spec.components == null) spec.components = {};
  if (spec.components.schemas == null) spec.components.schemas = {};
  return spec.components.schemas;
}

export type GeneratedDocument = Awaited<ReturnType<typeof generateSpecs>>;

/** Build one checker for all documents; duplicate method/path versions must never infer a union of their outputs. */
export function createResponseInferrer(project: Project) {
  const { checker, program, routes, named } = createChecker(project);
  const handlers = versionedHandlers(program, checker, project.source.dir);
  // Unversioned routes use the accumulated Hono schema; versioned routes use their individual handler types.
  return (document: GeneratedDocument) => {
    // SAFETY: generateSpecs returns OpenAPI objects; Spec narrows the fields response inference reads and writes.
    const spec = document as Spec;
    const { convert, components } = createConverter(checker, named);
    const describer = { spec, checker, convert };
    const bodies = describeRoutes(describer, routes);
    for (const item of Object.values(spec.paths ?? {})) {
      // Each projection includes only one version of a method/path.
      for (const operation of Object.values(item ?? {})) {
        if (operation?.['x-operation-version'] !== undefined)
          bodies.push(...describeVersion(operation, handlers, describer));
      }
    }
    nameResources(bodies, components);
    const registered = responseComponents(spec);
    for (const [name, schema] of components) {
      if (registered[name] == null) registered[name] = schema;
    }
  };
}
