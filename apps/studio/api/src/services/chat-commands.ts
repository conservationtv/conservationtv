import type { Principal } from '@conservationtv/umbrella';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { type ChatAudience, STANDARD_COMMANDS, type StandardCommandName } from '@conservationtv/chat';
import type { ChatCommandAction } from '../chat/commands.ts';
import type { StandardTurn } from '../chat/decide.ts';
import { chatCommands, chatCommandSettings, chatCommandTurns } from '../db/schema.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { unchanged } from '../topology/transaction.ts';
import { organisationScope } from './organisations.ts';

// An organisation's chat commands (src/db/schemas/chat-commands.ts), in the principal's request session: members read
// them, administrators manage them: its own, and how it has the standard ones (`@conservationtv/chat`). What an
// output's agent listens for, and what happens when a command is used, is read by trusted code, since a device
// principal reads none of the topology: only after this API has checked the device is the agent of an output that goes
// out to the channel (src/routes/chat-commands.ts).

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

/**
 * The organisation's own command used by this word, as `selectUsedCommand` reads it, if it is enabled. Trusted code.
 */
export async function selectUsedCommandByName(organisationId: string, name: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({ id: chatCommands.id })
    .from(chatCommands)
    .where(
      and(eq(chatCommands.organisationId, organisationId), eq(chatCommands.name, name), eq(chatCommands.enabled, true))
    );
  return row === undefined ? undefined : selectUsedCommand(organisationId, row.id);
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

/** What is set of a standard command: whether it is on, who may use it, and how long it rests. */
export interface StandardSetting {
  enabled: boolean;
  audience: ChatAudience;
  cooldownSeconds: number;
}

/** What is set of a standard command, and when it was. */
interface StoredSetting extends StandardSetting {
  updatedAt: Date;
}

/** A command of the catalogue's. */
type CatalogueCommand = (typeof STANDARD_COMMANDS)[number];

/** A standard command as the organisation has it: the catalogue's, with what it has set over it. */
function asSet(command: CatalogueCommand, setting: StoredSetting | undefined) {
  return {
    name: command.name,
    aliases: [...command.aliases],
    group: command.group,
    target: command.target,
    usage: command.usage,
    description: command.description,
    enabled: setting?.enabled ?? true,
    audience: setting?.audience ?? command.audience,
    cooldownSeconds: setting?.cooldownSeconds ?? command.cooldownSeconds,
    /** When the organisation last changed it; null while it is as the catalogue has it. */
    changedAt: setting?.updatedAt ?? null
  };
}
export type SetStandardCommand = ReturnType<typeof asSet>;

const SETTING = {
  command: chatCommandSettings.command,
  enabled: chatCommandSettings.enabled,
  audience: chatCommandSettings.audience,
  cooldownSeconds: chatCommandSettings.cooldownSeconds,
  updatedAt: chatCommandSettings.updatedAt
};

/** The standard commands, as the organisation has them, in the catalogue's order. */
async function standardCommandsFor(organisationId: string, trusted: boolean) {
  const db = useDB({ trusted });
  const rows = await db
    .select(SETTING)
    .from(chatCommandSettings)
    .where(eq(chatCommandSettings.organisationId, organisationId));
  const settings = new Map(rows.map(row => [row.command, row]));
  return STANDARD_COMMANDS.map(command => asSet(command, settings.get(command.name)));
}

/**
 * The standard commands, as the organisation has them: none set for an organisation the principal is not a member of.
 */
export async function listStandardCommands(organisationId: string) {
  return standardCommandsFor(organisationId, false);
}

/**
 * Set a standard command for the organisation, over what it had: `forbidden` for one who may not (an administrator
 * alone writes them). Returns it as the organisation has it now.
 */
export async function setStandardCommand(
  organisationId: string,
  name: StandardCommandName,
  changes: Partial<StandardSetting>
) {
  const db = useDB();
  const all = await standardCommandsFor(organisationId, false);
  const current = all.find(command => command.name === name)!;
  const setting: StandardSetting = {
    enabled: changes.enabled ?? current.enabled,
    audience: changes.audience ?? current.audience,
    cooldownSeconds: changes.cooldownSeconds ?? current.cooldownSeconds
  };
  const updatedAt = new Date();
  const [row] = await db
    .insert(chatCommandSettings)
    .values({ organisationId, command: name, ...setting, updatedAt })
    .onConflictDoUpdate({
      target: [chatCommandSettings.organisationId, chatCommandSettings.command],
      set: { ...setting, updatedAt }
    })
    .returning(SETTING);
  const command = STANDARD_COMMANDS.find(candidate => candidate.name === name)!;
  return asSet(command, row);
}

/**
 * Put a standard command back as the catalogue has it, for the organisation, once umbrella says the principal may
 * (an administrator): `not_found` for one who cannot see the organisation's commands, `forbidden` for one who may not
 * change them. Returns it so.
 */
export async function resetStandardCommand(principal: Principal, organisationId: string, name: StandardCommandName) {
  const db = useDB();
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal, resource: chatCommandSettings, scope });
  if (!decision.permissions.read?.allowed) throw new ApiFailure('not_found');
  if (!decision.permissions.remove?.allowed) throw new ApiFailure('forbidden');
  await db
    .delete(chatCommandSettings)
    .where(and(eq(chatCommandSettings.organisationId, organisationId), eq(chatCommandSettings.command, name)));
  const command = STANDARD_COMMANDS.find(candidate => candidate.name === name)!;
  return asSet(command, undefined);
}

/**
 * The standard commands an agent listens for: those the organisation has on, each by every word it is used by. Trusted
 * code.
 */
export async function selectListenedStandardCommands(organisationId: string) {
  const commands = await standardCommandsFor(organisationId, true);
  return commands
    .filter(command => command.enabled)
    .map(({ name, aliases, audience, cooldownSeconds, target }) => ({
      name,
      words: [name, ...aliases],
      audience,
      cooldownSeconds,
      target
    }));
}

/**
 * A standard command as it is used, if the organisation has it on: who may use it, how long it rests, and when it last
 * ran on each camera or show it has run on. Trusted code.
 */
export async function selectStandardUse(organisationId: string, name: StandardCommandName) {
  const db = useDB({ trusted: true });
  const all = await standardCommandsFor(organisationId, true);
  const command = all.find(candidate => candidate.name === name)!;
  if (!command.enabled) return undefined;
  const rows = await db
    .select({ targetId: chatCommandTurns.targetId, triggeredAt: chatCommandTurns.triggeredAt })
    .from(chatCommandTurns)
    .where(and(eq(chatCommandTurns.organisationId, organisationId), eq(chatCommandTurns.command, name)));
  const turns = new Map(rows.map(row => [row.targetId, row.triggeredAt]));
  return { name, target: command.target, audience: command.audience, cooldownSeconds: command.cooldownSeconds, turns };
}

/**
 * Take a standard command's turn on its target: mark it used now there, unless it was used there within its cooldown,
 * in one statement, as `claimChatCommand` does for an own command. Undefined while it rests there. Trusted code.
 */
export async function claimStandardTurn(
  organisationId: string,
  turn: StandardTurn,
  cooldownSeconds: number,
  now: Date
) {
  const db = useDB({ trusted: true });
  const rested = sql`${now.toISOString()}::timestamp - make_interval(secs => ${cooldownSeconds})`;
  const [row] = await db
    .insert(chatCommandTurns)
    .values({ organisationId, command: turn.command, targetId: turn.targetId, triggeredAt: now })
    .onConflictDoUpdate({
      target: [chatCommandTurns.organisationId, chatCommandTurns.command, chatCommandTurns.targetId],
      set: { triggeredAt: now },
      setWhere: or(isNull(chatCommandTurns.triggeredAt), lte(chatCommandTurns.triggeredAt, rested))
    })
    .returning({ previous: sql<Date | null>`old.triggered_at`.mapWith(chatCommandTurns.triggeredAt) });
  if (row === undefined) return undefined;
  const claim: ClaimedTurn = { claimedAt: now, previous: row.previous, cooldownSeconds };
  return claim;
}

/** Give a standard command's turn on its target back, as `giveBackChatCommand` does. Trusted code. */
export async function giveBackStandardTurn(organisationId: string, turn: StandardTurn, claim: Claim) {
  const db = useDB({ trusted: true });
  const given = await db
    .update(chatCommandTurns)
    .set({ triggeredAt: claim.previous })
    .where(
      and(
        eq(chatCommandTurns.organisationId, organisationId),
        eq(chatCommandTurns.command, turn.command),
        eq(chatCommandTurns.targetId, turn.targetId),
        eq(chatCommandTurns.triggeredAt, claim.claimedAt)
      )
    )
    .returning({ targetId: chatCommandTurns.targetId });
  return given.length > 0;
}

/** When a standard command last ran on its target, and how long it rests after: none when it is off. Trusted code. */
export async function selectStandardRest(organisationId: string, turn: StandardTurn) {
  const use = await selectStandardUse(organisationId, turn.command);
  if (use === undefined) return undefined;
  return { cooldownSeconds: use.cooldownSeconds, triggeredAt: use.turns.get(turn.targetId) ?? null };
}
