import type { FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import type { Output } from '@conservationtv/studio-sdk';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@conservationtv/ui/components/alert-dialog';
import { Button } from '@conservationtv/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@conservationtv/ui/components/empty';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { CopyButton } from '@/components/common/copy-button';
import { FormError } from '@/components/common/form-error';
import { Fact, FactLabel, Facts, FactValue } from '@/components/common/page';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { formatRelative } from '@/lib/format';
import { deviceAddressListQueryOptions } from '@/queries/devices';
import { outputControlQueryOptions, useUpdateOutput } from '@/queries/outputs';
import type { ListedShow } from '@/queries/shows';

// Who drives an output's scenes (docs/outputs.md): under `show` control, the show it follows, or nothing while it
// follows none; under `external`, something outside the studio, over obs-websocket, which may read any of the
// organisation's exposures. Choosing among the shows, switching between the two, and, for administrators, how to reach
// OBS from outside, as its agent last reported it.

export interface ShowSelectProps {
  output: Output;
  /** The organisation's shows, to choose among. */
  shows: ListedShow[];
}

/** Chooses the show the output follows, or none, under `show` control. Shows the choice being saved until it is. */
export const ShowSelect: FC<ShowSelectProps> = ({ output, shows }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateOutput(organisationId);
  const stored = output.showId ?? '';
  const value = update.isPending ? (update.variables.showId ?? '') : stored;
  return (
    <div className="flex flex-col gap-1">
      <NativeSelect
        size="sm"
        aria-label={`The show ${output.name} follows`}
        value={value}
        disabled={update.isPending}
        onChange={event => update.mutate({ outputId: output.id, showId: event.target.value || null })}
      >
        <NativeSelectOption value="">No show</NativeSelectOption>
        {shows.map(show => (
          <NativeSelectOption key={show.id} value={show.id}>
            {show.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FormError error={update.error} />
    </div>
  );
};

export interface ControlDialogProps {
  output: Output;
}

/**
 * Switches who drives the output, once confirmed: from a show to something outside the studio, which leaves the show
 * it followed, or back to following a show, none until one is chosen. Either way OBS restarts on the other scene
 * collection, so neither's scenes are lost to the other's.
 */
export const ControlDialog: FC<ControlDialogProps> = ({ output }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateOutput(organisationId);
  const dialog = useDialog(update);
  const external = output.control === 'external';
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>
        {external ? 'Follow a show' : 'Drive from outside'}
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {external ? `Have a show drive ${output.name}?` : `Drive ${output.name} from outside the studio?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {external
              ? 'OBS restarts on the studio’s own scene collection, following no show until you choose one, and its agent reads only what that show places. The external scene collection stays, for when you switch back.'
              : 'An advanced mode: OBS restarts on a scene collection of its own, for something outside the studio to drive over obs-websocket, and its agent may read any of the organisation’s streams. It stops following its show. It keeps going out to its channels, previews and recorder.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={update.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            loading={update.isPending}
            onClick={() =>
              dialog.mutate(
                external
                  ? { outputId: output.id, control: 'show' }
                  : { outputId: output.id, control: 'external', showId: null }
              )
            }
          >
            {external ? 'Follow a show' : 'Drive from outside'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export interface OutputControlDetailsProps {
  output: Output;
  /** The agent it runs on: where obs-websocket listens. */
  deviceId: string;
}

/**
 * How to reach the output's OBS from outside, as its agent last reported it, with the agent's address on its own
 * network: obs-websocket's port and password, the scene collection, and where OBS reads a stream. Administrators only;
 * says so in place until the agent has reported. Suspends once.
 */
export const OutputControlDetails: FC<OutputControlDetailsProps> = ({ output, deviceId }) => {
  const organisationId = useOrganisationId();
  const [controlQuery, addressesQuery] = useSuspenseQueries({
    queries: [
      outputControlQueryOptions(organisationId, output.id),
      deviceAddressListQueryOptions(organisationId, deviceId)
    ]
  });
  const control = controlQuery.data;
  if (!control) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Not reported yet</EmptyTitle>
          <EmptyDescription>
            Its agent reports how to reach OBS once it is running it. Check back once the agent is on.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const address = addressesQuery.data.find(candidate => candidate.preferred) ?? addressesQuery.data[0];
  return (
    <Facts>
      <Fact>
        <FactLabel>obs-websocket</FactLabel>
        <FactValue className="flex items-center gap-1 font-mono text-custom-12">
          <span>{address ? `ws://${address.address}:${control.websocketPort}` : `Port ${control.websocketPort}`}</span>
        </FactValue>
      </Fact>
      <Fact>
        <FactLabel>Password</FactLabel>
        <FactValue className="flex items-center gap-1 font-mono text-custom-12">
          <span aria-label="Hidden">••••••••••••</span>
          <CopyButton value={control.websocketPassword} label="Copy obs-websocket password" />
        </FactValue>
      </Fact>
      <Fact>
        <FactLabel>Scene collection</FactLabel>
        <FactValue>{control.sceneCollection}</FactValue>
      </Fact>
      <Fact>
        <FactLabel>Stream input</FactLabel>
        <FactValue className="flex items-center gap-1 font-mono text-custom-12">
          <span className="truncate" title={control.inputUrl}>
            {control.inputUrl}
          </span>
          <CopyButton value={control.inputUrl} label="Copy stream input URL" />
        </FactValue>
      </Fact>
      <Fact>
        <FactLabel>Reported</FactLabel>
        <FactValue>{formatRelative(control.reportedAt)}</FactValue>
      </Fact>
    </Facts>
  );
};
