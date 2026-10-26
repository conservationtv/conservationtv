import { z } from 'zod';

/** Zod's name for an object schema's member map. Its API, not a name chosen here. */
const MEMBERS = 'shape';

type Members<Schema extends z.ZodObject> = Schema[typeof MEMBERS];
type CliMembers<Schema extends z.ZodObject> = {
  [Key in keyof Members<Schema>]: z.ZodType<z.output<Members<Schema>[Key]>, unknown>;
};

/** A decimal or scientific-notation argv string, read as the number it spells. */
const NumericArgumentSchema = z
  .string()
  .regex(/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i)
  .transform(Number);
export type NumericArgument = z.output<typeof NumericArgumentSchema>;

/** A JSON object argv string, such as `--settings '{"driver":"axis"}'`, read as the object it spells. */
const ObjectArgumentSchema = z
  .string()
  .transform((text, context) => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'Expected a JSON object' });
      return z.NEVER;
    }
  })
  .pipe(z.looseObject({}));
export type ObjectArgument = z.output<typeof ObjectArgumentSchema>;

/** Whether a schema only wraps another, adding nothing to how argv must be read. */
function wraps(base: z.core.$ZodType): base is z.ZodOptional | z.ZodDefault | z.ZodNullable | z.ZodNonOptional {
  return (
    base instanceof z.ZodOptional ||
    base instanceof z.ZodDefault ||
    base instanceof z.ZodNullable ||
    base instanceof z.ZodNonOptional
  );
}

/** The schema beneath optional, default, nullable and required wrappers, which decides how argv must be read. */
function innermost(field: z.core.$ZodType): z.core.$ZodType {
  let base = field;
  while (wraps(base)) {
    base = base.unwrap();
  }
  return base;
}

/** Whether a field takes an object, so argv must spell it as JSON: incur 0.6 passes such an option on as a string. */
function takesObject(base: z.core.$ZodType): boolean {
  return base instanceof z.ZodObject || base instanceof z.ZodRecord || base instanceof z.ZodUnion;
}

/**
 * A field read from argv as incur 0.6 can't: numeric argv as a number (its parser misses ZodNumberFormat, z.int), and
 * a JSON object as that object. Anything else is left for the field's own validation, as is argv neither reads as.
 */
function argument(field: z.core.$ZodType): z.core.$ZodType {
  const base = innermost(field);
  if (base instanceof z.ZodNumber) {
    return z.preprocess(value => NumericArgumentSchema.safeParse(value).data ?? value, field);
  }
  if (takesObject(base)) return z.preprocess(value => ObjectArgumentSchema.safeParse(value).data ?? value, field);
  return field;
}

/** The SDK's options, read from argv as `argument` reads each, then run through the exact SDK validation. */
export function cliOptions<Schema extends z.ZodObject>(schema: Schema) {
  const fields = Object.entries(schema[MEMBERS]).map(([name, field]) => [name, argument(field)]);
  // SAFETY: preprocessing changes raw input only; every field retains its original output type and validation.
  return z.object(Object.fromEntries(fields) as CliMembers<Schema>);
}
