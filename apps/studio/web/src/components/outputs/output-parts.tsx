import type { FC } from 'react';
import { Link } from 'react-router';
import { BroadcastIcon, CloudIcon, HardDrivesIcon, PlusIcon, TwitchLogoIcon } from '@phosphor-icons/react';
import type { Channel, Output } from '@conservationtv/studio-sdk';
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
import type { ForwardPart, PreviewPart } from '@/components/outputs/output-detail';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import {
  useCreateControlChannel,
  useCreateForward,
  useCreateOutputRecorder,
  useCreatePreview,
  useDeleteControlChannel,
  useDeleteForward,
  useDeleteOutputRecorder,
  useDeletePreview,
  useUpdateForward
} from '@/queries/outputs';

// What an administrator changes about where an output goes: the channels it is forwarded to, each on or off; the
// channels whose chat controls it; the gateways it is previewed at; and whether OBS records it. Each is a control to
// compose into a row where the page lists them.

export interface AddForwardMenuProps {
  output: Output;
  channels: Channel[];
}

/**
 * Forwards the output to one of the organisation's channels it doesn't go to yet, on from the start; or, when there
 * are none left, says where channels are added.
 */
export const AddForwardMenu: FC<AddForwardMenuProps> = ({ output, channels }) => {
  const organisationId = useOrganisationId();
  const create = useCreateForward(organisationId);
  const available = channels.filter(channel => !output.forwards.some(forward => forward.channelId === channel.id));
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
                onClick={() => create.mutate({ outputId: output.id, channelId: channel.id })}
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
  outputId: string;
  part: ForwardPart;
}

/** Turns a forward on or off, showing the choice being saved until it is. Off keeps the channel the output's. */
export const ForwardSwitch: FC<ForwardControlProps> = ({ outputId, part }) => {
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
        onCheckedChange={enabled => update.mutate({ outputId, forwardId: part.forward.id, enabled })}
      />
    </div>
  );
};

/** Stops forwarding the output to a channel, once confirmed. The channel stays, for other outputs. */
export const RemoveForwardDialog: FC<ForwardControlProps> = ({ outputId, part }) => {
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
            The channel goes offline if this output was all it carried. It stays in the organisation, for other outputs;
            to pause it instead, switch it off.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => dialog.mutate({ outputId, partId: part.forward.id })}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export interface AddControlChannelMenuProps {
  output: Output;
  channels: Channel[];
}

/**
 * Has the chat of one of the organisation's Twitch channels control the output: those with a login (chat is found by
 * it) that don't control it already. When there are none left, says where channels are added.
 */
export const AddControlChannelMenu: FC<AddControlChannelMenuProps> = ({ output, channels }) => {
  const organisationId = useOrganisationId();
  const create = useCreateControlChannel(organisationId);
  const available = channels.filter(
    channel =>
      channel.kind === 'twitch' &&
      channel.externalLogin !== null &&
      !output.controlChannels.some(control => control.channelId === channel.id)
  );
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
              {available.length > 0 ? 'Take commands from the chat of' : 'Every Twitch channel controls it'}
            </DropdownMenuLabel>
            {available.map(channel => (
              <DropdownMenuItem
                key={channel.id}
                onClick={() => create.mutate({ outputId: output.id, channelId: channel.id })}
              >
                <TwitchLogoIcon />
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

export interface RemoveControlChannelDialogProps {
  outputId: string;
  channelId: string;
  /** The channel's name, or a note when it has gone. */
  name: string;
}

/** Stops a channel's chat controlling the output, once confirmed. The channel stays, for other outputs. */
export const RemoveControlChannelDialog: FC<RemoveControlChannelDialogProps> = ({ outputId, channelId, name }) => {
  const organisationId = useOrganisationId();
  const remove = useDeleteControlChannel(organisationId);
  const dialog = useDialog(remove);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Remove</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Stop taking commands from {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its chat stops controlling this output, unless the output is forwarded to it. The channel stays in the
            organisation.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => dialog.mutate({ outputId, channelId })}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export interface AddPreviewMenuProps {
  output: Output;
  gateways: ListedGateway[];
}

/** Previews the output at a gateway it isn't previewed at yet: conservation.tv, or one of the organisation's own. */
export const AddPreviewMenu: FC<AddPreviewMenuProps> = ({ output, gateways }) => {
  const organisationId = useOrganisationId();
  const create = useCreatePreview(organisationId);
  const available = gateways.filter(gateway => !output.previews.some(preview => preview.gatewayId === gateway.id));
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
                onClick={() => create.mutate({ outputId: output.id, gatewayId: gateway.id })}
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
  outputId: string;
  part: PreviewPart;
}

/** Stops previewing the output at a gateway, once confirmed. */
export const RemovePreviewDialog: FC<PreviewControlProps> = ({ outputId, part }) => {
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
            onClick={() => dialog.mutate({ outputId, partId: part.preview.id })}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export interface RecorderSwitchProps {
  output: Output;
}

/**
 * Turns recording on, with OBS recording the programme alongside streaming it, or off, removing the recorder; shows
 * the choice being saved until it is. What OBS has recorded stays on the agent's machine either way.
 */
export const RecorderSwitch: FC<RecorderSwitchProps> = ({ output }) => {
  const organisationId = useOrganisationId();
  const create = useCreateOutputRecorder(organisationId);
  const remove = useDeleteOutputRecorder(organisationId);
  const recorder = output.recorders[0];
  const pending = create.isPending || remove.isPending;
  const checked = pending ? create.isPending : recorder !== undefined;
  return (
    <div className="flex items-center gap-2">
      <FormError error={create.error ?? remove.error} />
      <Switch
        aria-label={`Record ${output.name}`}
        checked={checked}
        disabled={pending}
        onCheckedChange={on => {
          if (on) create.mutate(output.id);
          else if (recorder) remove.mutate({ outputId: output.id, partId: recorder.id });
        }}
      />
    </div>
  );
};
