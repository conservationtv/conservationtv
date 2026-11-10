import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQuery } from '@tanstack/react-query';
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

import type { Route } from './+types/gateway-new';
import { FormError } from '@/components/common/form-error';
import { NetworkOptions } from '@/components/devices/network-options';
import { GatewayUrlFields } from '@/components/gateways/gateway-dialogs';
import { EMPTY_URLS, GATEWAY_PROTOCOLS } from '@/components/gateways/gateways';
import { GatewaySchema, type GatewayInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateGateway } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';

export const meta: Route.MetaFunction = () => [{ title: 'Add a gateway · conservation.tv studio' }];

/**
 * Adding a MediaMTX gateway on a network, as a dialog over the gateways page at `gateways/new`, closing back to the
 * list once it is made.
 */
const GatewayNewRoute: FC = () => {
  const organisationId = useOrganisationId();
  const { data: networks } = useSuspenseQuery(networkListQueryOptions(organisationId));
  const create = useCreateGateway(organisationId);
  const defaultValues: GatewayInput = { name: '', networkId: networks[0]?.id ?? '', urls: EMPTY_URLS };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: GatewaySchema },
    onSubmit: ({ value }) => dialog.mutate({ kind: 'mediamtx', ...GatewaySchema.parse(value) })
  });
  const dialog = useDialog(create, { closeTo: '..' });
  return (
    <Dialog {...dialog.props}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a MediaMTX gateway</DialogTitle>
            <DialogDescription>
              A MediaMTX server on one of your networks, run by that network’s active agent. Streams delivered to it can
              be watched there without leaving the network.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Hide MediaMTX" autoComplete="off" />}
            </form.Field>
            <form.Field name="networkId">
              {field => (
                <SelectField field={field} label="Network">
                  <NetworkOptions networks={networks} />
                </SelectField>
              )}
            </form.Field>
            <GatewayUrlFields>
              {GATEWAY_PROTOCOLS.map(({ protocol, label }) => (
                <form.Field key={protocol} name={`urls.${protocol}`}>
                  {field => <TextField field={field} label={label} autoComplete="off" spellCheck={false} />}
                </form.Field>
              ))}
            </GatewayUrlFields>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add gateway
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default GatewayNewRoute;
