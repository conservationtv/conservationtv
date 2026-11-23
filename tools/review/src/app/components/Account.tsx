import { Avatar, AvatarImage } from '@conservationtv/ui/components/avatar';
import { Button } from '@conservationtv/ui/components/button';
import { buttonVariants } from '@conservationtv/ui/lib/button-variants';
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
      <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={signInHref()}>
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
    <span className="inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap">
      <Avatar className="size-5">
        <AvatarImage src={session.viewer.avatarUrl} alt="" />
      </Avatar>
      <span>{session.viewer.login}</span>
      <Button variant="ghost" size="xs" onClick={() => void signOut()} loading={leaving}>
        Sign out
      </Button>
    </span>
  );
};
