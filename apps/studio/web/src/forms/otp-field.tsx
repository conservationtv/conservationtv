import type { AnyFieldApi } from '@tanstack/react-form';
import { Fragment, type ReactNode, type FC } from 'react';
import { Field, FieldDescription, FieldError, FieldLabel } from '@conservationtv/ui/components/field';
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@conservationtv/ui/components/input-otp';

export interface OtpFieldProps {
  field: AnyFieldApi;
  label: ReactNode;
  description?: ReactNode;
  /** Slots per group, e.g. `[6]` or `[4, 4]`; separators are drawn between groups. */
  groups: number[];
  /** Which characters a slot accepts, e.g. input-otp's `REGEXP_ONLY_DIGITS`. */
  pattern: string;
  /** Normalise typed and pasted text, e.g. to upper case. */
  transform?: (value: string) => string;
  /** Called once every slot is filled, e.g. to submit. */
  onComplete?: () => void;
  autoFocus?: boolean;
}

/** A TanStack Form field rendered as shadcn's OTP input inside a Field; errors show once touched or submitted. */
export const OtpField: FC<OtpFieldProps> = ({
  field,
  label,
  description,
  groups,
  pattern,
  transform,
  onComplete,
  autoFocus
}) => {
  const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
  const normalise = transform ?? ((value: string) => value);
  const starts = groups.map((_, index) => groups.slice(0, index).reduce((sum, size) => sum + size, 0));
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <InputOTP
        id={field.name}
        name={field.name}
        maxLength={groups.reduce((sum, size) => sum + size, 0)}
        pattern={pattern}
        value={field.state.value}
        onChange={value => field.handleChange(normalise(value))}
        pasteTransformer={pasted => normalise(pasted.replace(/[\s-]/g, ''))}
        onBlur={field.handleBlur}
        onComplete={onComplete}
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        aria-invalid={invalid}
      >
        {groups.map((size, group) => (
          <Fragment key={starts[group]}>
            {group > 0 && <InputOTPSeparator />}
            <InputOTPGroup>
              {Array.from({ length: size }, (_, offset) => (
                <InputOTPSlot key={offset} index={starts[group]! + offset} aria-invalid={invalid} />
              ))}
            </InputOTPGroup>
          </Fragment>
        ))}
      </InputOTP>
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError errors={field.state.meta.errors} />}
    </Field>
  );
};
