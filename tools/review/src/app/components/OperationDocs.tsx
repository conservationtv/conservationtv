import { useState, type FC } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { OperationDoc, OperationDocs, ParameterDoc, ResponseDoc, SchemaNode } from '../../shared/operation.ts';
import type { ContractChange } from '../../shared/review.ts';
import { constraints, fieldsOf, markOf, objectVariants, signature, typeLabel, type Mark } from '../schemas.ts';

/** Both sides of whatever is being compared; one is missing where it was added or removed. */
type Pair<T> = [before: T | undefined, after: T | undefined];

/** Every key on either side: the current order first, then what was removed. */
function union<T>(before: readonly T[], after: readonly T[], key: (item: T) => string): [string, Pair<T>][] {
  const old = new Map(before.map(item => [key(item), item]));
  const current = after.map((item): [string, Pair<T>] => [key(item), [old.get(key(item)), item]]);
  const gone = before
    .filter(item => !after.some(other => key(other) === key(item)))
    .map((item): [string, Pair<T>] => [key(item), [item, undefined]]);
  return [...current, ...gone];
}

/** What there is now, or what there was. */
function either<T>([before, after]: Pair<T>): T | undefined {
  return after ?? before;
}

function differs<T>([before, after]: Pair<T>): boolean {
  return signature(before) !== signature(after);
}

/** How the docs are read: a changed operation is compared, and can show only what changed. */
interface Reading {
  compare: boolean;
  onlyChanges: boolean;
}

/** Whether a row is shown: always, unless only changes are, and it did not change. */
function shown<T>(pair: Pair<T>, reading: Reading): boolean {
  return !reading.onlyChanges || differs(pair);
}

/** New or gone, where things are compared; a thing on both sides is marked by what it holds instead. */
function presence<T>([before, after]: Pair<T>, reading: Reading): Mark {
  if (!reading.compare) return null;
  if (!before) return 'added';
  return after ? null : 'removed';
}

/** What is inside something new or gone is new or gone with it, so it is not marked again. */
function within(reading: Reading, mark: Mark): Reading {
  return { ...reading, compare: reading.compare && (mark === null || mark === 'changed') };
}

const markLabels = { added: 'New', removed: 'Removed', changed: 'Changed' } satisfies Record<NonNullable<Mark>, string>;

interface ProseProps {
  text: string | null | undefined;
}

const Prose: FC<ProseProps> = ({ text }) =>
  text ? (
    <div className="prose">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  ) : null;

interface MarkBadgeProps {
  mark: Mark;
}

const MarkBadge: FC<MarkBadgeProps> = ({ mark }) =>
  mark ? <span className={`field-mark mark-${mark}`}>{markLabels[mark]}</span> : null;

interface FieldProps {
  name: string;
  pair: Pair<SchemaNode>;
  required: [boolean, boolean];
  /** A parameter's own description, which says more than its schema's. */
  description?: string | null;
  reading: Reading;
  depth: number;
}

/** What a changed field was: its type, whether it was required, and its limits. */
const FieldWas: FC<FieldProps> = ({ pair: [before], required }) => {
  if (!before) return null;
  const limits = constraints(before);
  let requirement = '';
  if (required[0] !== required[1]) requirement = required[0] ? ', required' : ', optional';
  return (
    <div className="field-was">
      Was <code>{typeLabel(before)}</code>
      {requirement}
      {limits.length ? `, ${limits.join(', ')}` : null}
    </div>
  );
};

interface FieldPartProps extends FieldProps {
  node: SchemaNode;
  mark: Mark;
}

/** A field's name, whether it is required, its type, how it changed, and what it was. */
const FieldHead: FC<FieldPartProps> = props => {
  const { name, pair, required, node, mark } = props;
  const isRequired = pair[1] ? required[1] : required[0];
  return (
    <>
      <div className="field-head">
        <code className="field-name">{name}</code>
        {isRequired ? <span className="field-required">required</span> : null}
        <code className="field-type">{typeLabel(node)}</code>
        <MarkBadge mark={mark} />
      </div>
      {mark === 'changed' ? <FieldWas {...props} /> : null}
    </>
  );
};

/** A field's description and limits. */
const FieldBody: FC<FieldPartProps> = ({ node, description }) => {
  const limits = constraints(node);
  return (
    <>
      <Prose text={description ?? node.description} />
      {limits.length ? <div className="field-limits">{limits.join(' · ')}</div> : null}
    </>
  );
};

interface NestedProps {
  pair: Pair<SchemaNode>;
  reading: Reading;
  depth: number;
}

/** The fields of the object a field is or holds, open near the top or where something inside changed. */
const FieldNested: FC<NestedProps> = ({ pair: [before, after], reading, depth }) => {
  const inner: Pair<SchemaNode> = [fieldsOf(before), fieldsOf(after)];
  const nested = either(inner);
  if (!nested?.properties) return null;
  const changedInside = reading.compare && differs(inner);
  return (
    <details className="field-nested" open={depth < 1 || changedInside}>
      <summary>
        {nested['x-ref'] ?? 'Fields'}: {Object.keys(nested.properties).length} fields
      </summary>
      <Fields pair={inner} reading={reading} depth={depth + 1} />
    </details>
  );
};

/** One field: its name, whether it is required, its type and limits, its description, and its own fields. */
const Field: FC<FieldProps> = props => {
  const { pair, required, reading, depth } = props;
  const node = either(pair);
  if (!node) return null;
  const mark = reading.compare ? markOf(pair[0], pair[1], required) : null;
  const inner = within(reading, mark);
  return (
    <div className={mark ? `field field-${mark}` : 'field'}>
      <FieldHead {...props} node={node} mark={mark} />
      <FieldBody {...props} node={node} mark={mark} />
      <Variants pair={pair} reading={inner} depth={depth} />
      <FieldNested pair={pair} reading={inner} depth={depth} />
    </div>
  );
};

interface VariantProps {
  label: string;
  pair: Pair<SchemaNode>;
  reading: Reading;
  depth: number;
}

const Variant: FC<VariantProps> = ({ label, pair, reading, depth }) => {
  const mark = presence(pair, reading);
  return (
    <div className="variant">
      <div className="field-head">
        <code className="field-type">{label}</code>
        <MarkBadge mark={mark} />
      </div>
      <Fields pair={pair} reading={within(reading, mark)} depth={depth + 1} />
    </div>
  );
};

/**
 * A value that is one of several objects, such as camera settings by driver: each variant and its fields, matched to
 * the same variant before by its label, so a variant that changed is compared with what it was.
 */
const Variants: FC<NestedProps> = ({ pair: [before, after], reading, depth }) => {
  const count = objectVariants(after ?? before).length;
  const choices = union(objectVariants(before), objectVariants(after), typeLabel).filter(([, variant]) =>
    shown(variant, reading)
  );
  if (count < 2 || !choices.length) return null;
  return (
    <details className="field-nested" open={depth < 1 || reading.compare}>
      <summary>One of {count}</summary>
      {choices.map(([label, variant]) => (
        <Variant key={label} label={label} pair={variant} reading={reading} depth={depth} />
      ))}
    </details>
  );
};

/** A field on both sides, and whether it was and is required. */
type FieldRow = [name: string, pair: Pair<SchemaNode>, required: [boolean, boolean]];

/** Every field on either side, with its schema and whether it is required on each. */
function fieldRows([before, after]: Pair<SchemaNode>): FieldRow[] {
  const names = union(Object.keys(before?.properties ?? {}), Object.keys(after?.properties ?? {}), name => name);
  return names.map(([name]) => [
    // Missing on the side the field was added to or removed from.
    name,
    [before?.properties?.[name], after?.properties?.[name]],
    [Boolean(before?.required?.includes(name)), Boolean(after?.required?.includes(name))]
  ]);
}

/** An object's fields, as they are and as they were; only those that changed, when that is all that is shown. */
const Fields: FC<NestedProps> = ({ pair, reading, depth }) => {
  const rows = fieldRows(pair).filter(([, fields, required]) => shown(fields, reading) || required[0] !== required[1]);
  if (!rows.length) return null;
  return (
    <div className="fields">
      {rows.map(([name, fields, required]) => (
        <Field key={name} name={name} pair={fields} required={required} reading={reading} depth={depth} />
      ))}
    </div>
  );
};

interface SchemaBlockProps {
  pair: Pair<SchemaNode | null>;
  reading: Reading;
}

/** A body: its type, and the fields of whatever object it is or holds. */
const SchemaBlock: FC<SchemaBlockProps> = ({ pair: [before, after], reading }) => {
  const node = after ?? before;
  if (!node) return <p className="muted small">No body.</p>;
  return (
    <>
      <p className="schema-type">
        <code className="field-type">{typeLabel(node)}</code>
      </p>
      <Prose text={node.description} />
      <Fields pair={[fieldsOf(before ?? undefined), fieldsOf(after ?? undefined)]} reading={reading} depth={0} />
    </>
  );
};

interface SectionProps {
  pair: Pair<OperationDoc>;
  reading: Reading;
}

const locations = [
  ['path', 'Path'],
  ['query', 'Query'],
  ['header', 'Headers'],
  ['cookie', 'Cookies']
] as const;

/** A parameter's schema on each side it is on; one without a schema is still a value. */
function parameterSchemas([was, is]: Pair<ParameterDoc>): Pair<SchemaNode> {
  return [was && (was.schema ?? {}), is && (is.schema ?? {})];
}

interface ParameterFieldProps {
  pair: Pair<ParameterDoc>;
  reading: Reading;
}

const ParameterField: FC<ParameterFieldProps> = ({ pair, reading }) => {
  const parameter = either(pair);
  if (!parameter) return null;
  return (
    <Field
      name={parameter.name}
      pair={parameterSchemas(pair)}
      required={[Boolean(pair[0]?.required), Boolean(pair[1]?.required)]}
      description={parameter.description}
      reading={reading}
      depth={1}
    />
  );
};

/** Path, query and header parameters, each with its type, limits and description. */
const Parameters: FC<SectionProps> = ({ pair: [before, after], reading }) => {
  const rows = union(before?.parameters ?? [], after?.parameters ?? [], p => `${p.in}:${p.name}`)
    .map(([, pair]) => pair)
    .filter(pair => shown(pair, reading));
  if (!rows.length) return null;
  const byLocation = Map.groupBy(rows, pair => either(pair)?.in);
  return (
    <section className="docs-section">
      <h3>Parameters</h3>
      {locations
        .filter(([location]) => byLocation.has(location))
        .map(([location, label]) => (
          <div key={location}>
            <h4>{label}</h4>
            <div className="fields">
              {byLocation.get(location)?.map(pair => (
                <ParameterField key={either(pair)?.name} pair={pair} reading={reading} />
              ))}
            </div>
          </div>
        ))}
    </section>
  );
};

/** The request body, when the operation takes one. */
const RequestBody: FC<SectionProps> = ({ pair: [before, after], reading }) => {
  const bodies: Pair<NonNullable<OperationDoc['requestBody']>> = [
    before?.requestBody ?? undefined,
    after?.requestBody ?? undefined
  ];
  const body = either(bodies);
  if (!body || !shown(bodies, reading)) return null;
  return (
    <section className="docs-section">
      <h3>Request body {body.required ? <span className="field-required">required</span> : null}</h3>
      <Prose text={body.description} />
      <SchemaBlock pair={[bodies[0]?.schema, bodies[1]?.schema]} reading={reading} />
    </section>
  );
};

interface ResponseItemProps {
  pair: Pair<ResponseDoc>;
  reading: Reading;
}

/** One status: what it means and what it returns; successes open, errors folded. */
const ResponseItem: FC<ResponseItemProps> = ({ pair, reading }) => {
  const response = either(pair);
  if (!response) return null;
  const mark = presence(pair, reading);
  return (
    <details className="response" open={response.status.startsWith('2')}>
      <summary>
        <span className={`status-code status-${response.status[0]}xx`}>{response.status}</span>
        <span className="response-description">{response.description}</span>
        {response.schema ? <code className="field-type">{typeLabel(response.schema)}</code> : null}
        <MarkBadge mark={mark} />
      </summary>
      <SchemaBlock pair={[pair[0]?.schema, pair[1]?.schema]} reading={within(reading, mark)} />
    </details>
  );
};

/** Every status on either side, by status; only those that changed, when that is all that is shown. */
const Responses: FC<SectionProps> = ({ pair: [before, after], reading }) => {
  const rows = union(before?.responses ?? [], after?.responses ?? [], response => response.status)
    .map(([, pair]) => pair)
    .filter(pair => shown(pair, reading));
  if (!rows.length) return null;
  return (
    <section className="docs-section">
      <h3>Responses</h3>
      {rows.map(pair => (
        <ResponseItem key={either(pair)?.status} pair={pair} reading={reading} />
      ))}
    </section>
  );
};

interface OperationDocsViewProps {
  docs: OperationDocs;
  kind: ContractChange['kind'];
}

/** An operation as API reference; for a changed one, what changed, field by field, unless everything is asked for. */
export const OperationDocsView: FC<OperationDocsViewProps> = ({ docs, kind }) => {
  const compare = kind === 'changed';
  const [onlyChanges, setOnlyChanges] = useState(compare);
  const pair: Pair<OperationDoc> = [docs.before?.doc, docs.after?.doc];
  const reading = { compare, onlyChanges };
  const unchanged = compare && !differs(pair);
  return (
    <div className="api-docs">
      {compare ? (
        <div className="docs-toolbar">
          <div className="segmented" role="group" aria-label="What the docs show">
            <button type="button" aria-pressed={onlyChanges} onClick={() => setOnlyChanges(true)}>
              What changed
            </button>
            <button type="button" aria-pressed={!onlyChanges} onClick={() => setOnlyChanges(false)}>
              Everything
            </button>
          </div>
        </div>
      ) : null}
      {unchanged && onlyChanges ? (
        <p className="muted">
          No parameter, body or response field differs: the change is elsewhere in the contract, such as its version
          header or security. Its diff is below.
        </p>
      ) : null}
      <Parameters pair={pair} reading={reading} />
      <RequestBody pair={pair} reading={reading} />
      <Responses pair={pair} reading={reading} />
    </div>
  );
};
