import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ChatCommandCreateParams,
  ChatCommandUpdateParams,
  Standard,
  StandardUpdateParams
} from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// An organisation's chat commands (apps/studio/api/src/routes/chat-commands.ts): each the word viewers type after `!`
// in the chat of the organisation's channels, who may use it, how long it rests after it runs, and the one thing it
// does, which is to say something. Members read them and administrators manage them. Beside them are the standard
// commands every organisation has for every camera (@conservationtv/chat), which administrators can switch off, or
// change who may use and how long they rest. The agents of outputs whose chat controls them listen for both; whether
// a command runs, and what comes of it, the studio API decides each time one is used.

/** The organisation's chat commands, oldest first. */
export const chatCommandListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['chat-commands', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.chatCommands.list.v2({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.commands;
    }
  });

/** Add a command. Refused when the organisation already has one used by that word. */
export function useCreateChatCommand(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (command: Omit<ChatCommandCreateParams, 'id'>) => {
      const result = await api.organisations.chatCommands.create.v2({ id: organisationId, ...command });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['chat-commands', organisationId] })
  });
}

/** Change a command: the word it is used by, who may use it, how long it rests, what it does, or whether it is on. */
export function useUpdateChatCommand(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<ChatCommandUpdateParams, 'id'>) => {
      const result = await api.organisations.chatCommands.update.v2({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['chat-commands', organisationId] })
  });
}

/** Remove a command: chat stops answering to its word. */
export function useDeleteChatCommand(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (commandId: string) => {
      const result = await api.organisations.chatCommands.delete.v1({ id: organisationId, commandId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['chat-commands', organisationId] })
  });
}

/** A standard command, as the organisation has it. */
export type StandardChatCommand = Standard['commands'][number];

/** The standard commands, in their groups' order, each as the organisation has it: changed, or as it comes. */
export const standardChatCommandListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['chat-commands', organisationId, 'standard'] as const,
    queryFn: async () => {
      const result = await api.organisations.chatCommands.standard.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.commands;
    }
  });

/** A change to a standard command, by its name. */
export type StandardChatCommandChange = Omit<StandardUpdateParams, 'id'>;

/** Change a standard command: whether it is on, who may use it, or how long it rests. */
export function useUpdateStandardChatCommand(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (change: StandardChatCommandChange) => {
      const result = await api.organisations.chatCommands.standard.update.v1({ id: organisationId, ...change });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['chat-commands', organisationId, 'standard'] })
  });
}

/** Put a standard command back as it comes: on, for its own audience, resting its own time. */
export function useResetStandardChatCommand(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: StandardChatCommand['name']) => {
      const result = await api.organisations.chatCommands.standard.reset.v1({ id: organisationId, name });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['chat-commands', organisationId, 'standard'] })
  });
}
