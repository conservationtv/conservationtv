import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { ChatAudience } from '@conservationtv/chat';
import type { ChatCommandAction } from '../chat/commands.ts';
import { chatCommands } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { unchanged } from '../topology/transaction.ts';

// An organisation's chat commands (src/db/schemas/chat-commands.ts), in the principal's request session: members read
// them, administrators manage them. What an output's agent listens for, and what happens when a command is used, is
// read by trusted code, since a device principal reads none of the topology: only after this API has checked the
// device is the agent of an output that goes out to the channel (src/routes/chat-commands.ts).

/** What is listed of a command. */
const listed = {
  id: chatCommands.id,
  name: chatCommands.name,
  action: chatCommands.action,
  audience: chatCommands.audience,
  cooldownSeconds: chatCommands.cooldownSeconds,
  enabled: chatCommands.enabled,
  triggeredAt: chatCommands.triggeredAt,
  createdAt: chatCommands.createdAt
};

export interface NewChatCommand {
  name: string;
  action: ChatCommandAction;
  audience: ChatAudience;
  cooldownSeconds: number;
  enabled: boolean;
}

export type ChatCommandChanges = Partial<NewChatCommand>;

/** The organisation's commands, oldest first. */
export function listChatCommands(organisationId: string) {
  const db = useDB();
  return db
    .select(listed)
    .from(chatCommands)
    .where(eq(chatCommands.organisationId, organisationId))
    .orderBy(chatCommands.id);
}

/** The command, if it is visible. */
export async function getChatCommand(organisationId: string, commandId: string) {
  const db = useDB();
  const [row] = await db
    .select(listed)
    .from(chatCommands)
    .where(and(eq(chatCommands.organisationId, organisationId), eq(chatCommands.id, commandId)));
  return row;
}

/** Add a command: `conflict` if the organisation has one used by that word. */
export async function createChatCommand(organisationId: string, payload: NewChatCommand) {
  const db = useDB();
  const [row] = await db
    .insert(chatCommands)
    .values({ organisationId, ...payload })
    .returning(listed);
  return row!;
}

/** Change the command: `forbidden` or `not_found` when the write reaches no row. */
export async function updateChatCommand(organisationId: string, commandId: string, changes: ChatCommandChanges) {
  const db = useDB();
  const [row] = await db
    .update(chatCommands)
    .set({
      name: changes.name,
      action: changes.action,
      audience: changes.audience,
      cooldownSeconds: changes.cooldownSeconds,
      enabled: changes.enabled
    })
    .where(and(eq(chatCommands.organisationId, organisationId), eq(chatCommands.id, commandId)))
    .returning(listed);
  if (!row) throw await unchanged(chatCommands.id, commandId);
  return row;
}

/** Remove the command: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteChatCommand(organisationId: string, commandId: string) {
  const db = useDB();
  const deleted = await db
    .delete(chatCommands)
    .where(and(eq(chatCommands.organisationId, organisationId), eq(chatCommands.id, commandId)))
    .returning({ id: chatCommands.id });
  if (deleted.length === 0) throw await unchanged(chatCommands.id, commandId);
}

/** The commands an agent listens for: the organisation's enabled ones, by word. Trusted code. */
export function selectListenedCommands(organisationId: string) {
  const db = useDB({ trusted: true });
  return db
    .select({
      id: chatCommands.id,
      name: chatCommands.name,
      audience: chatCommands.audience,
      cooldownSeconds: chatCommands.cooldownSeconds
    })
    .from(chatCommands)
    .where(and(eq(chatCommands.organisationId, organisationId), eq(chatCommands.enabled, true)))
    .orderBy(chatCommands.id);
}

/**
 * The command as it is used: what it does, for whom, and when it last ran and how long it rests after, if it is there
 * and enabled. Trusted code.
 */
export async function selectUsedCommand(organisationId: string, commandId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({
      id: chatCommands.id,
      action: chatCommands.action,
      audience: chatCommands.audience,
      cooldownSeconds: chatCommands.cooldownSeconds,
      triggeredAt: chatCommands.triggeredAt
    })
    .from(chatCommands)
    .where(
      and(
        eq(chatCommands.organisationId, organisationId),
        eq(chatCommands.id, commandId),
        eq(chatCommands.enabled, true)
      )
    );
  return row;
}

/** A command's turn, taken: when it was taken, and when the command last ran before, to give it back to. */
export interface Claim {
  claimedAt: Date;
  previous: Date | null;
}

/** A turn just taken, with how long the command rests from it. */
export interface ClaimedTurn extends Claim {
  cooldownSeconds: number;
}

/**
 * Take the command's turn: mark it used now, unless it was used within its cooldown, in one statement, so two uses at
 * once cannot both take it. Undefined while it rests. The statement returns what it replaced (Postgres 18's `old`), so
 * the turn can be given back exactly as it was, even when another use took the one before it a moment ago. Trusted
 * code.
 */
export async function claimChatCommand(commandId: string, now: Date) {
  const db = useDB({ trusted: true });
  const rested = sql`${now.toISOString()}::timestamp - make_interval(secs => ${chatCommands.cooldownSeconds})`;
  const [row] = await db
    .update(chatCommands)
    .set({ triggeredAt: now })
    .where(
      and(eq(chatCommands.id, commandId), or(isNull(chatCommands.triggeredAt), lte(chatCommands.triggeredAt, rested)))
    )
    .returning({
      previous: sql<Date | null>`old.triggered_at`.mapWith(chatCommands.triggeredAt),
      cooldownSeconds: chatCommands.cooldownSeconds
    });
  if (row === undefined) return undefined;
  const claim: ClaimedTurn = { claimedAt: now, ...row };
  return claim;
}

/**
 * Give a command's turn back, when what it was taken for didn't happen: it last ran when it did before, so "last used"
 * stays true and the command doesn't rest for nothing. Only while the turn is still this claim's, in one statement: a
 * later use that took it since keeps it. Whether it was given back. Trusted code.
 */
export async function giveBackChatCommand(commandId: string, claim: Claim) {
  const db = useDB({ trusted: true });
  const given = await db
    .update(chatCommands)
    .set({ triggeredAt: claim.previous })
    .where(and(eq(chatCommands.id, commandId), eq(chatCommands.triggeredAt, claim.claimedAt)))
    .returning({ id: chatCommands.id });
  return given.length > 0;
}

/** When the command last ran, and how long it rests after: none for a command that is gone. Trusted code. */
export async function selectCommandRest(commandId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({ cooldownSeconds: chatCommands.cooldownSeconds, triggeredAt: chatCommands.triggeredAt })
    .from(chatCommands)
    .where(eq(chatCommands.id, commandId));
  return row;
}

/** The organisation's cameras as chat finds them: each with its name, aliases, state and presets. Trusted code. */
export async function selectNamedCameras(organisationId: string) {
  const db = useDB({ trusted: true });
  const rows = await db.query.cameras.findMany({
    columns: { id: true, aliases: true, state: true },
    with: {
      device: { columns: { name: true } },
      presets: { columns: { name: true, position: true }, orderBy: { id: 'asc' } }
    },
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
  return rows.map(({ device, ...camera }) => ({ ...camera, name: device?.name ?? '' }));
}
