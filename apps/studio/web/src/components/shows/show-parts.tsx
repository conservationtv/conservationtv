import type { FC } from 'react';
import { Link } from 'react-router';
import { BroadcastIcon, CloudIcon, HardDrivesIcon, PlusIcon, TwitchLogoIcon } from '@phosphor-icons/react';
import type { Channel, Show } from '@conservationtv/studio-sdk';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@conservationtv/ui/components/dropdown-menu';
import { Switch } from '@conservationtv/ui/components/switch';

import { FormError } from '@/components/common/form-error';
import type { ListedGateway } from '@/components/gateways/gateways';
import type { ForwardPart, PreviewPart } from '@/components/shows/show-detail';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import {
  useCreateForward,
  useCreatePreview,
  useCreateShowRecorder,
  useDeleteForward,
  useDeletePreview,
  useDeleteShowRecorder,
  useUpdateForward
} from '@/queries/shows';

// What an administrator changes about where a show goes: the channels it is forwarded to, each on or off; the gateways
// it is previewed at; and whether OBS records it. Each is a control to compose into a row where the page lists them.

export interface AddForwardMenuProps {
  show: Show;
  channels: Channel[];
}

/**
 * Forwards the show to one of the organisation's channels it doesn't go to yet, on from the start; or, when there are
 * none left, says where channels are added.
 */
export const AddForwardMenu: FC<AddForwardMenuProps> = ({ show, channels }) => {
  const organisationId = useOrganisationId();
  const create = useCreateForward(organisationId);
  const available = channels.filter(channel => !show.forwards.some(forward => forward.channelId === channel.id));
  return (
    <div className="flex items-center gap-3">
      <FormError error={create.error} />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" loading={create.isPending} />}>
          <PlusIcon />
          Add channel
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              {available.length > 0 ? 'Send the programme to' : 'It goes to every channel'}
            </DropdownMenuLabel>
            {available.map(channel => (
              <DropdownMenuItem
                key={channel.id}
                onClick={() => create.mutate({ showId: show.id, channelId: channel.id })}
              >
                {channel.kind === 'twitch' ? <TwitchLogoIcon /> : <BroadcastIcon />}
                <span className="truncate">{channel.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem render={<Link to="../../channels" relative="path" />}>
              <PlusIcon />
              Add a channel to the organisation
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export interface ForwardControlProps {
  showId: string;
  part: ForwardPart;
}

/** Turns a forward on or off, showing the choice being saved until it is. Off keeps the channel the show's. */
export const ForwardSwitch: FC<ForwardControlProps> = ({ showId, part }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateForward(organisationId);
  const checked = update.isPending ? update.variables.enabled : part.forward.enabled;
  return (
    <div className="flex items-center gap-2">
      <FormError error={update.error} />
      <Switch
        aria-label={`Send the programme to ${part.name}`}
        checked={checked}
        disabled={update.isPending}
        onCheckedChange={enabled => update.mutate({ showId, forwardId: part.forward.id, enabled })}
      />
    </div>
  );
};

/** Stops forwarding the show to a channel, once confirmed. The channel stays, for other shows. */
export const RemoveForwardDialog: FC<ForwardControlProps> = ({ showId, part }) => {
  const organisationId = useOrganisationId();
  const remove = useDeleteForward(organisationId);
  const dialog = useDialog(remove);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Remove</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Stop sending it to {part.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The channel goes offline if this show was all it carried. It stays in the organisation, for other shows; to
            pause it instead, switch it off.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => dialog.mutate({ showId, partId: part.forward.id })}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export interface AddPreviewMenuProps {
  show: Show;
  gateways: ListedGateway[];
}

/** Previews the show at a gateway it isn't previewed at yet: conservation.tv, or one of the organisation's own. */
export const AddPreviewMenu: FC<AddPreviewMenuProps> = ({ show, gateways }) => {
  const organisationId = useOrganisationId();
  const create = useCreatePreview(organisationId);
  const available = gateways.filter(gateway => !show.previews.some(preview => preview.gatewayId === gateway.id));
  return (
    <div className="flex items-center gap-3">
      <FormError error={create.error} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" loading={create.isPending} disabled={available.length === 0} />}
        >
          <PlusIcon />
          Add preview
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Publish the programme to</DropdownMenuLabel>
            {available.map(gateway => (
              <DropdownMenuItem
                key={gateway.id}
                onClick={() => create.mutate({ showId: show.id, gatewayId: gateway.id })}
              >
                {gateway.networkId ? <HardDrivesIcon /> : <CloudIcon />}
                <span className="truncate">{gateway.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export interface PreviewControlProps {
  showId: string;
  part: PreviewPart;
}

/** Stops previewing the show at a gateway, once confirmed. */
export const RemovePreviewDialog: FC<PreviewControlProps> = ({ showId, part }) => {
  const organisationId = useOrganisationId();
  const remove = useDeletePreview(organisationId);
  const dialog = useDialog(remove);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Remove</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Stop previewing it at {part.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The output stops publishing the programme there, and anyone reading it there loses the picture.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => dialog.mutate({ showId, partId: part.preview.id })}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export interface RecorderSwitchProps {
  show: Show;
}

/**
 * Turns recording on, with OBS recording the programme alongside streaming it, or off, removing the recorder; shows
 * the choice being saved until it is. What OBS has recorded stays on the output agent's machine either way.
 */
export const RecorderSwitch: FC<RecorderSwitchProps> = ({ show }) => {
  const organisationId = useOrganisationId();
  const create = useCreateShowRecorder(organisationId);
  const remove = useDeleteShowRecorder(organisationId);
  const recorder = show.recorders[0];
  const pending = create.isPending || remove.isPending;
  const checked = pending ? create.isPending : recorder !== undefined;
  return (
    <div className="flex items-center gap-2">
      <FormError error={create.error ?? remove.error} />
      <Switch
        aria-label={`Record ${show.name}`}
        checked={checked}
        disabled={pending}
        onCheckedChange={on => {
          if (on) create.mutate(show.id);
          else if (recorder) remove.mutate({ showId: show.id, partId: recorder.id });
        }}
      />
    </div>
  );
};
