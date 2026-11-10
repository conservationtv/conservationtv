import { useLocation } from 'react-router';

import { useRemovePin } from '@/queries/this-device';

/**
 * Unpins the page it is called on: for a detail page to call once what it shows has been deleted, so the rail doesn't
 * keep a way back to nothing.
 */
export function useUnpinPage(): () => void {
  const location = useLocation();
  const remove = useRemovePin();
  return () => remove.mutate(location.pathname);
}
