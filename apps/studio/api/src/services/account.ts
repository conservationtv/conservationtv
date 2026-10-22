import { eq } from 'drizzle-orm';
import { users } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';

// An account's own row, in the transaction the caller is in: in a request session, row-level security decides whether
// the account is visible to it.

export interface AccountChanges {
  name?: string;
  image?: string | null;
}

/** The account, if it is visible. */
export async function getAccount(userId: string) {
  const db = useDB();
  const [account] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      image: users.image,
      createdAt: users.createdAt
    })
    .from(users)
    .where(eq(users.id, userId));
  return account;
}

/** Change the account's profile fields; nothing if it is not visible. */
export async function updateAccount(userId: string, changes: AccountChanges) {
  const db = useDB();
  const [account] = await db.update(users).set(changes).where(eq(users.id, userId)).returning({
    id: users.id,
    name: users.name,
    email: users.email,
    emailVerified: users.emailVerified,
    image: users.image,
    createdAt: users.createdAt
  });
  return account;
}
