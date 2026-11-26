import type { FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router';
import {
  ChatCircleTextIcon,
  InfoIcon,
  PlusIcon,
  SpeakerHighIcon,
  SquaresFourIcon,
  VideoCameraIcon,
  type Icon
} from '@phosphor-icons/react';
import type { StandardGroup } from '@conservationtv/chat';
import type { ChatCommand } from '@conservationtv/studio-sdk';
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
  EditChatCommandDialog,
  EditStandardChatCommandDialog,
  ResetStandardChatCommandDialog,
  StandardChatCommandSwitch
} from '@/components/chat-commands/chat-command-dialogs';
import {
  chatAudienceLabelOf,
  chatCooldownWordsOf,
  STANDARD_CHAT_GROUPS
} from '@/components/chat-commands/chat-commands';
import {
  Page,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle
} from '@/components/common/page';
import { useIsAdministrator } from '@/hooks/use-organisation';
import { formatRelative } from '@/lib/format';
import {
  chatCommandListQueryOptions,
  standardChatCommandListQueryOptions,
  type StandardChatCommand
} from '@/queries/chat-commands';

export const meta: Route.MetaFunction = () => [{ title: 'Chat commands · conservation.tv studio' }];

/**
 * What viewers can ask for in chat: first the standard commands every organisation has for every camera, by group,
 * then the organisation's own, each a word typed after `!` that says something. Each says who may use it and how long
 * it rests. Everyone reads them; administrators switch the standard ones off, change who may use them and how long
 * they rest, and put them back as they come, and add, change, switch off and remove their own.
 */
const ChatCommandsRoute: FC<Route.ComponentProps> = ({ params }) => {
  const { organisationId } = params;
  const administrator = useIsAdministrator();
  const [standardQuery, commandsQuery] = useSuspenseQueries({
    queries: [standardChatCommandListQueryOptions(organisationId), chatCommandListQueryOptions(organisationId)]
  });
  const standard = standardQuery.data;
  const commands = commandsQuery.data;
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Chat commands</PageTitle>
          <PageDescription>
            What viewers can ask for in the chat of the Twitch channels that control your outputs: the standard camera,
            layout and audio commands, and your own replies. Someone at a camera’s controls comes first: chat waits for
            them.
          </PageDescription>
        </PageHeading>
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
      {STANDARD_CHAT_GROUPS.map(group => (
        <Section key={group.group}>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>{group.title} commands</SectionTitle>
              <SectionDescription>{group.description}</SectionDescription>
            </SectionHeading>
          </SectionHeader>
          <ItemGroup className="gap-2">
            {standard
              .filter(command => command.group === group.group)
              .map(command => (
                <StandardChatCommandRow key={command.name} command={command} />
              ))}
          </ItemGroup>
        </Section>
      ))}
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Your commands</SectionTitle>
            <SectionDescription>
              Words of your own that say something in chat, such as when the feeder is filled. None can be a word a
              standard command is used by.
            </SectionDescription>
          </SectionHeading>
          {administrator && (
            <Button variant="outline" size="sm" nativeButton={false} render={<Link to="new" />}>
              <PlusIcon />
              Add command
            </Button>
          )}
        </SectionHeader>
        {commands.length > 0 ? (
          <ItemGroup className="gap-2">
            {commands.map(command => (
              <ChatCommandRow key={command.id} command={command} />
            ))}
          </ItemGroup>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ChatCircleTextIcon />
              </EmptyMedia>
              <EmptyTitle>No commands of your own yet</EmptyTitle>
              <EmptyDescription>
                {administrator ? 'Add one to answer what viewers often ask.' : 'An administrator adds them.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </Section>
      {/* A dialog routed over the page: adding a command at `new`. */}
      <Outlet />
    </Page>
  );
};

export default ChatCommandsRoute;

/** The icon a group of standard commands is shown with. */
const STANDARD_GROUP_ICONS = {
  camera: VideoCameraIcon,
  layout: SquaresFourIcon,
  audio: SpeakerHighIcon
} as const satisfies Record<StandardGroup, Icon>;

interface StandardChatCommandRowProps {
  command: StandardChatCommand;
}

/**
 * A standard command: the word it is used by and its aliases, how it is typed, what it does, who may use it and how
 * long it rests; and, for administrators, switching it on or off, changing it, and resetting it once it is changed.
 */
const StandardChatCommandRow: FC<StandardChatCommandRowProps> = ({ command }) => {
  const administrator = useIsAdministrator();
  const GroupIcon = STANDARD_GROUP_ICONS[command.group];
  const changed = command.changedAt !== null;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <GroupIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          <span className="font-mono">!{command.name}</span>
          {command.aliases.length > 0 && (
            <span className="font-mono font-normal text-muted-foreground">
              {command.aliases.map(alias => `!${alias}`).join(' ')}
            </span>
          )}
          {!command.enabled && <Badge variant="outline">Off</Badge>}
          {changed && <Badge variant="secondary">Changed</Badge>}
        </ItemTitle>
        <ItemDescription>
          <StandardDescription text={command.description} />
        </ItemDescription>
        <ItemDescription>
          <code className="font-mono text-foreground">!{command.usage}</code>
        </ItemDescription>
        <ItemDescription>
          {chatAudienceLabelOf(command.audience)} · {chatCooldownWordsOf(command.cooldownSeconds)}
          {command.target === 'camera' ? ' of that camera' : ' in that show'}
        </ItemDescription>
      </ItemContent>
      {administrator && (
        <ItemActions>
          <StandardChatCommandSwitch command={command} />
          <EditStandardChatCommandDialog command={command} />
          {changed && <ResetStandardChatCommandDialog command={command} />}
        </ItemActions>
      )}
    </Item>
  );
};

interface StandardDescriptionProps {
  text: string;
}

/** What a standard command does, as the catalogue says it, with the words it quotes in backticks set as code. */
const StandardDescription: FC<StandardDescriptionProps> = ({ text }) => {
  // Split on backticks, every other piece is quoted.
  const pieces = text.split('`');
  return pieces.map((piece, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono text-foreground">
        {piece}
      </code>
    ) : (
      piece
    )
  );
};

interface ChatCommandRowProps {
  command: ChatCommand;
}

/**
 * One of the organisation's own commands: the word it is used by, what it says, who may use it, how long it rests and
 * when it last ran; and, for administrators, switching it on or off, changing it and removing it.
 */
const ChatCommandRow: FC<ChatCommandRowProps> = ({ command }) => {
  const administrator = useIsAdministrator();
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <ChatCircleTextIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          <span className="font-mono">!{command.name}</span>
          {!command.enabled && <Badge variant="outline">Off</Badge>}
        </ItemTitle>
        <ItemDescription>Says “{command.action.text}”</ItemDescription>
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
