import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@conservationtv/ui/components/dialog';
import { FieldGroup } from '@conservationtv/ui/components/field';
import { NativeSelectOption } from '@conservationtv/ui/components/native-select';

import type { Route } from './+types/output-new';
import { FormError } from '@/components/common/form-error';
import { EXTERNAL_DRIVER, NewOutputSchema, type NewOutputInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateOutput } from '@/queries/outputs';
import { showListQueryOptions } from '@/queries/shows';

export const meta: Route.MetaFunction = () => [{ title: 'New output · conservation.tv studio' }];

/**
 * Making an output by name, with what drives its scenes (one of the organisation's shows, none yet, or something
 * outside the studio), its programme at the default encoding, as a dialog over the outputs page at `outputs/new`. Once
 * it is made, its page opens in the dialog's place.
 */
const OutputNewRoute: FC = () => {
  const organisationId = useOrganisationId();
  const { data: shows } = useSuspenseQuery(showListQueryOptions(organisationId));
  const navigate = useNavigate();
  const create = useCreateOutput(organisationId);
  const defaultValues: NewOutputInput = { name: '', driver: shows[0]?.id ?? '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NewOutputSchema },
    onSubmit: ({ value }) =>
      // Not dialog.mutate: closing first would step back once the animation ends, which can overtake the navigation
      // to the output while its page's module loads. The dialog stays open until that page replaces it.
      create.mutate(NewOutputSchema.parse(value), {
        onSuccess: output => navigate(`../${output.id}`, { relative: 'path', replace: true })
      })
  });
  const dialog = useDialog(create, { closeTo: '..' });
  return (
    <Dialog {...dialog.props}>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New output</DialogTitle>
            <DialogDescription>
              It goes out at 1080p and 30 frames a second until you change it. Choose the agent it runs on, and the
              channels it goes to, on its page.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Waterhole, evenings" autoComplete="off" />}
            </form.Field>
            <form.Field name="driver">
              {field => (
                <SelectField
                  field={field}
                  label="Scenes"
                  description="Driven from outside is an advanced mode: something outside the studio drives OBS over obs-websocket."
                >
                  {shows.map(show => (
                    <NativeSelectOption key={show.id} value={show.id}>
                      Follow {show.name}
                    </NativeSelectOption>
                  ))}
                  <NativeSelectOption value="">No show yet</NativeSelectOption>
                  <NativeSelectOption value={EXTERNAL_DRIVER}>Driven from outside the studio</NativeSelectOption>
                </SelectField>
              )}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Create output
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default OutputNewRoute;
