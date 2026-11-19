import { useNavigate } from 'react-router';

import { useSignOut } from '@/queries/session';

export interface SignOutOfStudio {
  signOut: () => void;
  pending: boolean;
}

/** Signs out, then leaves for the sign-in page: everything under the app needs a session. */
export function useSignOutOfStudio(): SignOutOfStudio {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const leave = () => {
    signOut.mutate(undefined, { onSuccess: () => navigate('/sign-in', { replace: true }) });
  };
  return { signOut: leave, pending: signOut.isPending };
}
