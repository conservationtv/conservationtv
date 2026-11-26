import { errors, jwtVerify, SignJWT } from 'jose';
import { STANDARD_COMMAND_NAMES } from '@conservationtv/chat';
import { z } from 'zod';
import { signingKey } from '../db/encrypted.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';

// A planned use's receipt: what the listening agent settles the use with once it has carried out its camera commands
// (`organisations.chatCommands.uses.settle`, src/chat/decide.ts). It carries everything settling needs, so nothing is
// kept of the use in between: where to answer in chat, what to say there, and the turn it took, to give back when the
// camera didn't move. It is a JWT this API signs with a key only it holds (HS256, under its own subkey of the field
// key), for the device that triggered the use (`sub`), lasting a minute: longer than the grants it was given with
// take to lapse. A device's own identity would not do, since the device holds it too and could write its own.

/** The purpose its key is derived for: never to change, or receipts in flight stop verifying. */
const RECEIPT_KEY_PURPOSE = 'chat-command-receipt';
const RECEIPT_ALGORITHM = 'HS256';
const RECEIPT_TYPE = 'chat-command-receipt+jwt';
/** The claim what it is a receipt for is carried in. */
const RECEIPT_CLAIM = 'chat_command_use';
const RECEIPT_LIFETIME_SECONDS = 60;

/** The turn a use took (src/chat/decide.ts): an own command's, or a standard command's on a camera or show. */
const ReceiptTurnSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('own'), commandId: z.uuid() }),
  z.strictObject({ kind: z.literal('standard'), command: z.enum(STANDARD_COMMAND_NAMES), targetId: z.uuid() })
]);
export type ReceiptTurn = z.output<typeof ReceiptTurnSchema>;

/** A planned use, as its receipt carries it. */
const ReceiptUseSchema = z.strictObject({
  turn: ReceiptTurnSchema,
  channelId: z.uuid(),
  /** The chat message that used the command, to answer it. */
  messageId: z.string(),
  /** The camera's name, to say in chat when it didn't move; and what to say when it did. */
  camera: z.string(),
  carried: z.string(),
  /** ISO 8601: when the use took the command's turn, and when the command last ran before it. */
  claimedAt: z.iso.datetime(),
  previous: z.iso.datetime().nullable(),
  /** Whether the viewer is told why, should the move not be carried (`toldWhy`). */
  told: z.boolean()
});
export type ReceiptUse = z.output<typeof ReceiptUseSchema>;

/** A receipt for the use, for the device with this ID alone. */
export function signReceipt(deviceId: string, use: ReceiptUse) {
  const environment = useEnvironment();
  const issuedAt = Math.floor(environment.clock() / 1000);
  const key = signingKey(RECEIPT_KEY_PURPOSE);
  return new SignJWT({ [RECEIPT_CLAIM]: use })
    .setProtectedHeader({ alg: RECEIPT_ALGORITHM, typ: RECEIPT_TYPE })
    .setIssuer(environment.variables.APP_URL)
    .setAudience(environment.variables.APP_URL)
    .setSubject(deviceId)
    .setJti(crypto.randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + RECEIPT_LIFETIME_SECONDS)
    .sign(key);
}

/** The use a receipt is for: `invalid_receipt` when it is forged, lapsed, or not the device's with this ID. */
export async function verifyReceipt(receipt: string, deviceId: string) {
  const environment = useEnvironment();
  const key = signingKey(RECEIPT_KEY_PURPOSE);
  try {
    const { payload } = await jwtVerify(receipt, key, {
      algorithms: [RECEIPT_ALGORITHM],
      typ: RECEIPT_TYPE,
      issuer: environment.variables.APP_URL,
      audience: environment.variables.APP_URL,
      subject: deviceId,
      currentDate: new Date(environment.clock())
    });
    return ReceiptUseSchema.parse(payload[RECEIPT_CLAIM]);
  } catch (error) {
    if (error instanceof errors.JOSEError || error instanceof z.ZodError)
      throw new ApiFailure('invalid_receipt', { cause: error });
    throw error;
  }
}
