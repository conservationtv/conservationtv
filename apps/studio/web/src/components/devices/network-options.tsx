import type { FC } from 'react';
import type { Network } from '@conservationtv/studio-sdk';
import { NativeSelectOption } from '@conservationtv/ui/components/native-select';

export interface NetworkOptionsProps {
  networks: Network[];
}

/**
 * The choices of where something is: the internet, as the empty choice (`null` to the API), then each of the
 * organisation's networks. For a SelectField whose schema reads the empty choice as the internet.
 */
export const NetworkOptions: FC<NetworkOptionsProps> = ({ networks }) => {
  return (
    <>
      <NativeSelectOption value="">Internet</NativeSelectOption>
      {networks.map(network => (
        <NativeSelectOption key={network.id} value={network.id}>
          {network.name}
        </NativeSelectOption>
      ))}
    </>
  );
};
