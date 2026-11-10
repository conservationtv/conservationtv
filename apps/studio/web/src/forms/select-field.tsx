import type { AnyFieldApi } from '@tanstack/react-form';
import type { ComponentProps, ReactNode, FC } from 'react';
import { Field, FieldDescription, FieldError, FieldLabel } from '@conservationtv/ui/components/field';
import { NativeSelect } from '@conservationtv/ui/components/native-select';

type SelectProps = Omit<ComponentProps<typeof NativeSelect>, 'id' | 'name' | 'value' | 'onBlur' | 'onChange'>;

export interface SelectFieldProps extends SelectProps {
  field: AnyFieldApi;
  label: ReactNode;
  description?: ReactNode;
  /** The choices, as NativeSelectOption elements. A choice of nothing is an option whose value is the empty string. */
  children: ReactNode;
}

/**
 * A TanStack Form field rendered as a select inside a shadcn Field: errors show once the field is touched or the form
 * submitted. Its value is a string; the form's schema turns the empty string into "none" where a choice is optional.
 */
export const SelectField: FC<SelectFieldProps> = ({ field, label, description, children, ...select }) => {
  const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <NativeSelect
        className="w-full"
        {...select}
        id={field.name}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={event => field.handleChange(event.target.value)}
        aria-invalid={invalid}
      >
        {children}
      </NativeSelect>
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError errors={field.state.meta.errors} />}
    </Field>
  );
};
