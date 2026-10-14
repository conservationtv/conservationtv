import { z } from 'zod';

// The accounts that have signed in on this browser, most recent first, each with the passkeys this browser holds for
// it (none for an account that signs in by email code). Sign-in lists them as one-tap rows. A hint, not the truth: a
// passkey can be removed elsewhere, so a failed passkey sign-in always falls back to the email code.
//
// This module is the record's format and pure updates to it. Reading and writing go through the this-device queries
// (src/queries/this-device.ts), so the app always sees the record through TanStack Query.

const STORAGE_KEY = 'studio.accounts';
/** The previous record: passkeys only, one entry per credential. Converted on first read, then removed. */
const LEGACY_STORAGE_KEY = 'studio.passkeys';

const KnownAccountsSchema = z.array(z.object({ email: z.string().min(1), credentialIds: z.array(z.string().min(1)) }));
export type KnownAccounts = z.output<typeof KnownAccountsSchema>;
/** An account this browser has signed in, and the passkeys it holds for it (possibly none). */
export type KnownAccount = KnownAccounts[number];

const LegacyPasskeysSchema = z.array(z.object({ credentialId: z.string().min(1), email: z.string().min(1) }));
type LegacyPasskeys = z.output<typeof LegacyPasskeysSchema>;

function parse<T>(schema: z.ZodType<T>, key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : schema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** The legacy record grouped by account, most recently remembered first. */
function fromLegacy(passkeys: LegacyPasskeys): KnownAccounts {
  const accounts = new Map<string, string[]>();
  for (const { email, credentialId } of passkeys.toReversed()) {
    accounts.set(email, [...(accounts.get(email) ?? []), credentialId]);
  }
  return [...accounts].map(([email, credentialIds]) => ({ email, credentialIds }));
}

/** Read the record; an unreadable value counts as no accounts. A legacy record is converted and saved. */
export function readKnownAccounts(): KnownAccounts {
  const current = parse(KnownAccountsSchema, STORAGE_KEY);
  if (current) return current;
  const legacy = parse(LegacyPasskeysSchema, LEGACY_STORAGE_KEY);
  if (!legacy) return [];
  const converted = fromLegacy(legacy);
  writeKnownAccounts(converted);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return converted;
}

export function writeKnownAccounts(accounts: KnownAccounts): void {
  if (accounts.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
  else localStorage.removeItem(STORAGE_KEY);
}

export function credentialIdsOf(accounts: KnownAccounts): string[] {
  return accounts.flatMap(account => account.credentialIds);
}

/** The account moves to the top with these passkeys added; an unknown email is added. */
export function withPasskeys(accounts: KnownAccounts, email: string, credentialIds: string[]): KnownAccounts {
  const existing = accounts.find(account => account.email === email);
  const ids = [...new Set([...(existing?.credentialIds ?? []), ...credentialIds])];
  return [{ email, credentialIds: ids }, ...accounts.filter(account => account.email !== email)];
}

/** A sign-in: the account becomes the most recent, keeping any passkeys it already has here. */
export function withSignIn(accounts: KnownAccounts, email: string): KnownAccounts {
  return withPasskeys(accounts, email, []);
}

/** Passkeys removed, or no longer known to the server: their accounts stay, signing in by email code. */
export function withoutPasskeys(accounts: KnownAccounts, credentialIds: string[]): KnownAccounts {
  return accounts.map(account => ({
    ...account,
    credentialIds: account.credentialIds.filter(id => !credentialIds.includes(id))
  }));
}
