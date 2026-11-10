import { useState } from 'react';
import { useLocation, useNavigate, type To } from 'react-router';
import type { MutateOptions, UseMutationResult } from '@tanstack/react-query';

/** What `<Dialog>` and `<AlertDialog>` take to be opened and closed by `useDialog`. */
export interface MutationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
}

export interface UseDialogOptions {
  /** Runs each time the dialog opens, after the last refusal is forgotten: to start its form again, say. */
  onOpen?: () => void;
  /**
   * Makes the dialog a route's: it starts open, and once it has finished closing the app goes back to the page beneath
   * it. Opened from within the app, that is a step back in history, so the back button doesn't open it again; opened
   * by its address, it is this path (`'..'`), in its place. A dialog that navigates elsewhere when it succeeds calls
   * the mutation itself, not `mutate`: closing would step back once the animation ends, and can overtake that
   * navigation while the next page's module loads. It stays open until that page replaces it.
   */
  closeTo?: To;
}

/**
 * The wiring a dialog around a mutation needs, leaving the dialog itself to be composed where it is used:
 *
 *   const update = useUpdateNetwork(organisationId);
 *   const form = useForm({ …, onSubmit: ({ value }) => dialog.mutate(…) });
 *   const dialog = useDialog(update, { onOpen: () => form.reset() });
 *   <Dialog {...dialog.props}>
 *     …
 *     <FormError error={update.error} />
 *     <Button type="submit" loading={update.isPending}>Save</Button>
 *
 * `props` opens and closes it, forgetting the last refusal whenever it opens or closes, so it opens clean. `mutate`
 * runs the mutation, closes the dialog once it succeeds, then calls the call's own `onSuccess`; a refusal leaves it
 * open, showing why. `close` closes it without the mutation, as a dialog that only shows something does.
 */
export function useDialog<Data, Failure, Variables, Context>(
  mutation: UseMutationResult<Data, Failure, Variables, Context>,
  options: UseDialogOptions = {}
) {
  const { onOpen, closeTo } = options;
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(closeTo !== undefined);
  const props: MutationDialogProps = {
    open,
    onOpenChange: next => {
      setOpen(next);
      mutation.reset();
      if (next) onOpen?.();
    },
    onOpenChangeComplete: next => {
      if (next || closeTo === undefined) return;
      // The first page the app opened has the key 'default': there is nothing in the app to go back to.
      if (location.key === 'default') navigate(closeTo, { relative: 'path', replace: true });
      else navigate(-1);
    }
  };
  const mutate = (variables: Variables, callOptions?: MutateOptions<Data, Failure, Variables, Context>) =>
    mutation.mutate(variables, {
      ...callOptions,
      onSuccess: (...succeeded) => {
        setOpen(false);
        callOptions?.onSuccess?.(...succeeded);
      }
    });
  return { props, mutate, close: () => setOpen(false) };
}
