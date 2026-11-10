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

import type { Route } from './+types/agent-new';
import { FormError } from '@/components/common/form-error';
import { NewAgentSchema, type NewAgentInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateAgent } from '@/queries/agents';
import { networkListQueryOptions } from '@/queries/networks';

export const meta: Route.MetaFunction = () => [{ title: 'Add an agent · conservation.tv studio' }];

/**
 * Adding an agent to a network, as a dialog over the agents page at `agents/new`. Once it is made, its page opens in
 * the dialog's place, where its key is: the agent is only a record until a machine is started with it.
 */
const AgentNewRoute: FC = () => {
  const organisationId = useOrganisationId();
  const { data: networks } = useSuspenseQuery(networkListQueryOptions(organisationId));
  const navigate = useNavigate();
  const create = useCreateAgent(organisationId);
  const defaultValues: NewAgentInput = { name: '', networkId: networks[0]?.id ?? '', priority: '0' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NewAgentSchema },
    onSubmit: ({ value }) =>
      // Not dialog.mutate: closing first would step back once the animation ends, which can overtake the navigation
      // to the agent while its page's module loads. The dialog stays open until that page replaces it.
      create.mutate(NewAgentSchema.parse(value), {
        onSuccess: agent => navigate(`../${agent.id}`, { relative: 'path', replace: true })
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
            <DialogTitle>Add an agent</DialogTitle>
            <DialogDescription>
              It gets an identity of its own. Its page then shows the key to start it with on a machine at the site.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Hide agent" autoComplete="off" />}
            </form.Field>
            <form.Field name="networkId">
              {field => (
                <SelectField field={field} label="Network">
                  {networks.map(network => (
                    <NativeSelectOption key={network.id} value={network.id}>
                      {network.name}
                    </NativeSelectOption>
                  ))}
                </SelectField>
              )}
            </form.Field>
            <form.Field name="priority">
              {field => (
                <TextField
                  field={field}
                  label="Priority"
                  description="Among a network’s agents, the highest is preferred as the active one."
                  inputMode="numeric"
                  autoComplete="off"
                />
              )}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default AgentNewRoute;
