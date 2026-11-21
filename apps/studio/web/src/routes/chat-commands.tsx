import type { FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router';
import { ChatCircleTextIcon, InfoIcon, PlusIcon, VideoCameraIcon } from '@phosphor-icons/react';
import type { Camera, ChatCommand } from '@conservationtv/studio-sdk';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';

import type { Route } from './+types/chat-commands';
import {
  ChatCommandSwitch,
  DeleteChatCommandDialog,
  EditChatCommandDialog
} from '@/components/chat-commands/chat-command-dialogs';
import { chatActionWordsOf, chatAudienceLabelOf, chatCooldownWordsOf } from '@/components/chat-commands/chat-commands';
import { Page, PageActions, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { useIsAdministrator } from '@/hooks/use-organisation';
import { formatRelative } from '@/lib/format';
import { cameraListQueryOptions } from '@/queries/cameras';
import { chatCommandListQueryOptions } from '@/queries/chat-commands';

export const meta: Route.MetaFunction = () => [{ title: 'Chat commands · conservation.tv studio' }];

/**
 * What viewers can ask for in chat: each command the word typed after `!`, what it does (says something, or points a
 * camera at one of its presets), who may use it and how long it rests. Everyone reads them; administrators add,
 * change, switch off and remove them. The cameras are read with them, to name the ones commands point.
 */
const ChatCommandsRoute: FC<Route.ComponentProps> = ({ params }) => {
  const { organisationId } = params;
  const administrator = useIsAdministrator();
  const [commandsQuery, camerasQuery] = useSuspenseQueries({
    queries: [chatCommandListQueryOptions(organisationId), cameraListQueryOptions(organisationId)]
  });
  const commands = commandsQuery.data;
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Chat commands</PageTitle>
          <PageDescription>
            What viewers can ask for in the chat of the Twitch channels your outputs go out to: a reply, or a camera
            pointed at one of its presets. Someone at a camera’s controls comes first: chat waits for them.
          </PageDescription>
        </PageHeading>
        {administrator && (
          <PageActions>
            <Button nativeButton={false} render={<Link to="new" />}>
              <PlusIcon />
              Add command
            </Button>
          </PageActions>
        )}
      </PageHeader>
      <Alert>
        <InfoIcon />
        <AlertTitle>Replies need a recent Twitch connection</AlertTitle>
        <AlertDescription>
          Saying something in chat takes a permission that Twitch channels connected before chat commands don’t have.
          Commands still run on those, silently: to have replies there,{' '}
          <Link to="../channels" relative="path" className="text-foreground underline underline-offset-2">
            connect the channel again under Channels
          </Link>
          .
        </AlertDescription>
      </Alert>
      {commands.length > 0 ? (
        <ItemGroup className="gap-2">
          {commands.map(command => (
            <ChatCommandRow key={command.id} command={command} cameras={camerasQuery.data} />
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChatCircleTextIcon />
            </EmptyMedia>
            <EmptyTitle>No chat commands yet</EmptyTitle>
            <EmptyDescription>
              {administrator
                ? 'Add one to let chat point a camera at its presets, or to answer what viewers often ask.'
                : 'An administrator adds them.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {/* A dialog routed over the page: adding a command at `new`. */}
      <Outlet />
    </Page>
  );
};

export default ChatCommandsRoute;

interface ChatCommandRowProps {
  command: ChatCommand;
  /** The organisation's cameras, to name the one the command points. */
  cameras: Camera[];
}

/**
 * A command: the word it is used by, what it does, who may use it, how long it rests and when it last ran; and, for
 * administrators, switching it on or off, changing it and removing it.
 */
const ChatCommandRow: FC<ChatCommandRowProps> = ({ command, cameras }) => {
  const administrator = useIsAdministrator();
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        {command.action.kind === 'reply' ? <ChatCircleTextIcon /> : <VideoCameraIcon />}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          <span className="font-mono">!{command.name}</span>
          {!command.enabled && <Badge variant="outline">Off</Badge>}
        </ItemTitle>
        <ItemDescription>{chatActionWordsOf(command.action, cameras)}</ItemDescription>
        <ItemDescription>
          {chatAudienceLabelOf(command.audience)} · {chatCooldownWordsOf(command.cooldownSeconds)} ·{' '}
          {command.triggeredAt ? `Last used ${formatRelative(command.triggeredAt)}` : 'Never used'}
        </ItemDescription>
      </ItemContent>
      {administrator && (
        <ItemActions>
          <ChatCommandSwitch command={command} />
          <EditChatCommandDialog command={command} />
          <DeleteChatCommandDialog command={command} />
        </ItemActions>
      )}
    </Item>
  );
};
