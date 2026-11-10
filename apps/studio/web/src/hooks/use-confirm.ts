import { useState } from 'react';
import type { MutateOptions, UseMutationResult } from '@tanstack/react-query';

/** What `<AlertDialog>` takes to be opened and closed by `useConfirm`. */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The wiring a confirmation dialog around a mutation needs, leaving the dialog itself to be composed where it is used:
 *
 *   const remove = useDeleteAgent(organisationId);
 *   const confirmation = useConfirm(remove);
 *   <AlertDialog {...confirmation.dialog}>
 *     …
 *     <FormError error={remove.error} />
 *     <AlertDialogAction loading={remove.isPending} onClick={() => confirmation.confirm(agent.id)}>Remove</AlertDialogAction>
 *
 * `dialog` opens and closes it, forgetting the last refusal when it closes, so it opens clean next time. `confirm` runs
 * the mutation and closes the dialog once it succeeds, then calls the call's own `onSuccess`; a refusal leaves it
 * open, showing why.
 */
export function useConfirm<Data, Failure, Variables, Context>(
  mutation: UseMutationResult<Data, Failure, Variables, Context>
) {
  const [open, setOpen] = useState(false);
  const dialog: ConfirmDialogProps = {
    open,
    onOpenChange: next => {
      setOpen(next);
      if (!next) mutation.reset();
    }
  };
  const confirm = (variables: Variables, options?: MutateOptions<Data, Failure, Variables, Context>) =>
    mutation.mutate(variables, {
      ...options,
      onSuccess: (...succeeded) => {
        setOpen(false);
        options?.onSuccess?.(...succeeded);
      }
    });
  return { dialog, confirm };
}
