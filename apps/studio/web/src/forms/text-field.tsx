import type { AnyFieldApi } from '@tanstack/react-form';
import type { ComponentProps, ReactNode, FC } from 'react';
import { Field, FieldDescription, FieldError, FieldLabel } from '@conservationtv/ui/components/field';
import { Input } from '@conservationtv/ui/components/input';

type InputProps = Omit<ComponentProps<typeof Input>, 'id' | 'name' | 'value' | 'onBlur' | 'onChange'>;

export interface TextFieldProps extends InputProps {
  field: AnyFieldApi;
  label: ReactNode;
  description?: ReactNode;
}

/** A TanStack Form field rendered as a shadcn Field: errors show once the field is touched or the form submitted. */
export const TextField: FC<TextFieldProps> = ({ field, label, description, ...input }) => {
  const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        {...input}
        id={field.name}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={event => field.handleChange(event.target.value)}
        aria-invalid={invalid}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError errors={field.state.meta.errors} />}
    </Field>
  );
};
