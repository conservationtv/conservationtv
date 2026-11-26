import type { FC } from 'react';
import { Field, FieldDescription, FieldError, FieldLabel } from '@conservationtv/ui/components/field';
import { Input } from '@conservationtv/ui/components/input';
import { cn } from '@conservationtv/ui/lib/utils';

import type { TextFieldProps } from '@/forms/text-field';

/**
 * A TextField for a short code kept in capitals, such as a stream's: what is typed is put in capitals as it is typed,
 * so the field shows the code as it will be kept.
 */
export const CodeField: FC<TextFieldProps> = ({ field, label, description, className, ...input }) => {
  const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        {...input}
        className={cn('font-mono uppercase', className)}
        id={field.name}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={event => field.handleChange(event.target.value.toUpperCase())}
        aria-invalid={invalid}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError errors={field.state.meta.errors} />}
    </Field>
  );
};
