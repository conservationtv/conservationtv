import type { FC } from 'react';
import type { ChatCommand } from '@conservationtv/studio-sdk';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@conservationtv/ui/components/dialog';
import { Switch } from '@conservationtv/ui/components/switch';

import { ChatCommandForm, StandardChatCommandForm } from '@/components/chat-commands/chat-command-form';
import {
  chatCommandInputOf,
  NEW_CHAT_COMMAND,
  standardChatCommandInputOf
} from '@/components/chat-commands/chat-commands';
import { FormError } from '@/components/common/form-error';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { conflictAs } from '@/lib/conflict';
import {
  useCreateChatCommand,
  useDeleteChatCommand,
  useResetStandardChatCommand,
  useUpdateChatCommand,
  useUpdateStandardChatCommand,
  type StandardChatCommand
} from '@/queries/chat-commands';

/** What a failed save says when the organisation already has a command used by the word. */
const COMMAND_NAME_TAKEN = 'Another command is already used by that word.';

/**
 * Adds a chat command. It is a route's dialog: open from the start, and closing back to the page beneath it, once the
 * command is made or the dialog is dismissed.
 */
export const AddChatCommandDialog: FC = () => {
  const organisationId = useOrganisationId();
  const create = useCreateChatCommand(organisationId);
  const dialog = useDialog(create, { closeTo: '..' });
  return (
    <Dialog {...dialog.props}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a chat command</DialogTitle>
          <DialogDescription>
            Viewers use it in the chat of the channels that control your outputs, from the next time those outputs’
            agents are configured.
          </DialogDescription>
        </DialogHeader>
        <ChatCommandForm defaultValues={NEW_CHAT_COMMAND} onSubmit={command => dialog.mutate(command)}>
          <FormError error={conflictAs(create.error, COMMAND_NAME_TAKEN)} />
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add command
            </Button>
          </DialogFooter>
        </ChatCommandForm>
      </DialogContent>
    </Dialog>
  );
};

export interface ChatCommandDialogProps {
  command: ChatCommand;
}

/** Changes a chat command. The form starts from what is stored each time it opens. */
export const EditChatCommandDialog: FC<ChatCommandDialogProps> = ({ command }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateChatCommand(organisationId);
  const dialog = useDialog(update);
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">Change !{command.name}</DialogTitle>
          <DialogDescription>
            Chat picks the change up the next time the outputs’ agents are configured.
          </DialogDescription>
        </DialogHeader>
        {/* The dialog's contents are only there while it is open, so the form starts again from the command each time. */}
        <ChatCommandForm
          defaultValues={chatCommandInputOf(command)}
          onSubmit={changes => dialog.mutate({ commandId: command.id, ...changes })}
        >
          <FormError error={conflictAs(update.error, COMMAND_NAME_TAKEN)} />
          <DialogFooter>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </ChatCommandForm>
      </DialogContent>
    </Dialog>
  );
};

/** Turns a command on or off, showing the choice being saved until it is. Off, chat doesn't answer to it. */
export const ChatCommandSwitch: FC<ChatCommandDialogProps> = ({ command }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateChatCommand(organisationId);
  const checked = update.isPending ? (update.variables.enabled ?? command.enabled) : command.enabled;
  return (
    <div className="flex items-center gap-2">
      <FormError error={update.error} />
      <Switch
        aria-label={`Answer to !${command.name} in chat`}
        checked={checked}
        disabled={update.isPending}
        onCheckedChange={enabled => update.mutate({ commandId: command.id, enabled })}
      />
    </div>
  );
};

/** Removes a command, once confirmed. */
export const DeleteChatCommandDialog: FC<ChatCommandDialogProps> = ({ command }) => {
  const organisationId = useOrganisationId();
  const remove = useDeleteChatCommand(organisationId);
  const dialog = useDialog(remove);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Delete</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="truncate">Delete !{command.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Chat stops answering to it. To keep it for later, turn it off instead.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" loading={remove.isPending} onClick={() => dialog.mutate(command.id)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export interface StandardChatCommandDialogProps {
  command: StandardChatCommand;
}

/** Turns a standard command on or off, showing the choice being saved until it is. Off, chat doesn't answer to it. */
export const StandardChatCommandSwitch: FC<StandardChatCommandDialogProps> = ({ command }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateStandardChatCommand(organisationId);
  const checked = update.isPending ? (update.variables.enabled ?? command.enabled) : command.enabled;
  return (
    <div className="flex items-center gap-2">
      <FormError error={update.error} />
      <Switch
        aria-label={`Answer to !${command.name} in chat`}
        checked={checked}
        disabled={update.isPending}
        onCheckedChange={enabled => update.mutate({ name: command.name, enabled })}
      />
    </div>
  );
};

/** Changes who may use a standard command and how long it rests. The form starts from what it is each time it opens. */
export const EditStandardChatCommandDialog: FC<StandardChatCommandDialogProps> = ({ command }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateStandardChatCommand(organisationId);
  const dialog = useDialog(update);
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">Change !{command.name}</DialogTitle>
          <DialogDescription>
            What it does stays the standard’s. Chat picks the change up the next time the outputs’ agents are
            configured.
          </DialogDescription>
        </DialogHeader>
        {/* The dialog's contents are only there while it is open, so the form starts again from the command each time. */}
        <StandardChatCommandForm
          defaultValues={standardChatCommandInputOf(command)}
          onSubmit={changes => dialog.mutate({ name: command.name, ...changes })}
        >
          <FormError error={update.error} />
          <DialogFooter>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </StandardChatCommandForm>
      </DialogContent>
    </Dialog>
  );
};

/** Puts a changed standard command back as it comes, once confirmed. */
export const ResetStandardChatCommandDialog: FC<StandardChatCommandDialogProps> = ({ command }) => {
  const organisationId = useOrganisationId();
  const reset = useResetStandardChatCommand(organisationId);
  const dialog = useDialog(reset);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Reset</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="truncate">Reset !{command.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It goes back to how it comes: on, for its standard audience, resting its standard time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={reset.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction loading={reset.isPending} onClick={() => dialog.mutate(command.name)}>
            Reset
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
