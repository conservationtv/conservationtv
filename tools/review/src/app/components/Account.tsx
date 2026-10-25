import { useQueryClient } from '@tanstack/react-query';
import { useState, type FC } from 'react';
import { send, sessionQuery } from '../api.ts';
import { signInHref, useSession } from '../session.ts';

/** Who is signed in and a way out, or a way in; nothing when signing in is not set up. */
export const Account: FC = () => {
  const session = useSession();
  const queryClient = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  if (!session?.enabled) return null;
  if (!session.viewer) {
    return (
      <a className="button small-button" href={signInHref()}>
        Sign in with GitHub
      </a>
    );
  }
  async function signOut() {
    setLeaving(true);
    await send('/api/auth/logout').finally(() => setLeaving(false));
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
  }
  return (
    <span className="account">
      <span className="avatar">
        <img src={session.viewer.avatarUrl} alt="" width={20} height={20} />
      </span>
      <span className="account-login">{session.viewer.login}</span>
      <button type="button" className="link-button muted" onClick={() => void signOut()} disabled={leaving}>
        Sign out
      </button>
    </span>
  );
};
