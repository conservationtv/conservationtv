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

/** The schema beneath optional, default and nullable wrappers, which decides how argv must be read. */
function innermost(field: z.core.$ZodType): z.core.$ZodType {
  let base = field;
  while (base instanceof z.ZodOptional || base instanceof z.ZodDefault || base instanceof z.ZodNullable) {
    base = base.unwrap();
  }
  return base;
}

/** Incur 0.6's argv parser misses ZodNumberFormat (z.int). Coerce numeric argv, then run the exact SDK validation. */
export function cliOptions<Schema extends z.ZodObject>(schema: Schema) {
  const fields = Object.entries(schema[MEMBERS]).map(([name, field]) => [
    name,
    innermost(field) instanceof z.ZodNumber
      ? z.preprocess(value => NumericArgumentSchema.safeParse(value).data ?? value, field)
      : field
  ]);
  // SAFETY: preprocessing changes raw input only; every field retains its original output type and validation.
  return z.object(Object.fromEntries(fields) as CliMembers<Schema>);
}
