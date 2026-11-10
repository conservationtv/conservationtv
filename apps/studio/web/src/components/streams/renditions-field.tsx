import type { AnyFieldApi } from '@tanstack/react-form';
import type { FC, ReactNode } from 'react';
import type { Rendition } from '@conservationtv/studio-sdk';
import { Checkbox } from '@conservationtv/ui/components/checkbox';
import { FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@conservationtv/ui/components/field';

import { renditionLabels } from '@/components/streams/renditions';

export interface RenditionsFieldProps {
  field: AnyFieldApi;
  label: ReactNode;
  description?: ReactNode;
  /** The renditions it may offer, in order. */
  choices: Rendition[];
}

/**
 * A TanStack Form field holding the renditions an exposure offers, as a row of checkboxes, one per rendition it may
 * offer: errors show once it is touched or the form submitted.
 */
export const RenditionsField: FC<RenditionsFieldProps> = ({ field, label, description, choices }) => {
  const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
  const offered: Rendition[] = field.state.value;
  return (
    <FieldSet data-invalid={invalid} className="gap-2">
      <FieldLegend variant="label" className="mb-1">
        {label}
      </FieldLegend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {choices.map(rendition => (
          <FieldLabel key={rendition} className="items-center font-normal has-data-checked:bg-transparent">
            <Checkbox
              name={field.name}
              value={rendition}
              checked={offered.includes(rendition)}
              onBlur={field.handleBlur}
              onCheckedChange={checked => field.handleChange(toggled(offered, rendition, checked))}
              aria-invalid={invalid}
            />
            {renditionLabels[rendition]}
          </FieldLabel>
        ))}
      </div>
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError errors={field.state.meta.errors} />}
    </FieldSet>
  );
};

/** The renditions with one added or taken away. */
function toggled(renditions: Rendition[], rendition: Rendition, on: boolean): Rendition[] {
  const others = renditions.filter(candidate => candidate !== rendition);
  return on ? [...others, rendition] : others;
}
