import type { FC } from 'react';

import type { Route } from './+types/chat-command-new';
import { AddChatCommandDialog } from '@/components/chat-commands/chat-command-dialogs';

export const meta: Route.MetaFunction = () => [{ title: 'Add a chat command · conservation.tv studio' }];

/**
 * Adding a chat command, as a dialog over the chat commands page at `chat-commands/new`, closing back to the list
 * once it is made.
 */
const ChatCommandNewRoute: FC = () => {
  return <AddChatCommandDialog />;
};

export default ChatCommandNewRoute;
