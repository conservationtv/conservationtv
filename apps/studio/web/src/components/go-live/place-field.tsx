import type { ComponentProps, FC, ReactNode } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Field, FieldLabel } from '@conservationtv/ui/components/field';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { useOrganisationId } from '@/hooks/use-organisation';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';

export interface PlaceFieldProps extends Omit<ComponentProps<typeof NativeSelect>, 'children'> {
  id: string;
  /** The field's label: what is being placed, a browser or an encoder. */
  children: ReactNode;
}

/**
 * Where a publisher is (docs/shows.md, Going live), as one choice: anywhere, by the internet (the default, an empty
 * value), or on one of the organisation's sites, by the site's network ID, which sends to that site's own gateway. The
 * API cannot tell for a browser or an encoder, so its person says. Nothing at all while no site has a gateway to send
 * to.
 */
export const PlaceField: FC<PlaceFieldProps> = ({ id, children, ...props }) => {
  const organisationId = useOrganisationId();
  const [networksQuery, gatewaysQuery] = useSuspenseQueries({
    queries: [networkListQueryOptions(organisationId), gatewayListQueryOptions(organisationId)]
  });
  const served = new Set(
    gatewaysQuery.data.flatMap(gateway =>
      gateway.kind === 'mediamtx' && gateway.networkId !== null ? [gateway.networkId] : []
    )
  );
  const sites = networksQuery.data.filter(network => served.has(network.id));
  if (sites.length === 0) return null;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{children}</FieldLabel>
      <NativeSelect id={id} className="w-full" {...props}>
        <NativeSelectOption value="">Anywhere, by the internet</NativeSelectOption>
        {sites.map(network => (
          <NativeSelectOption key={network.id} value={network.id}>
            On site at {network.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
};
