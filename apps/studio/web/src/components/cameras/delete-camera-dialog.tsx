import type { FC } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@conservationtv/ui/components/alert-dialog';
import { Button } from '@conservationtv/ui/components/button';

import { FormError } from '@/components/common/form-error';
import { useConfirm } from '@/hooks/use-confirm';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUnpinPage } from '@/hooks/use-unpin-page';
import { useDeleteCamera } from '@/queries/cameras';

export interface DeleteCameraDialogProps {
  cameraId: string;
  /** What the camera is called, for the confirmation. */
  name: string;
}

/**
 * Removes the camera and its device once confirmed, then goes back to the cameras. The API refuses while a stream
 * still starts from it, and says so here.
 */
export const DeleteCameraDialog: FC<DeleteCameraDialogProps> = ({ cameraId, name }) => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const remove = useDeleteCamera(organisationId);
  const confirmation = useConfirm(remove);
  const unpin = useUnpinPage();
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>Delete</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="truncate">Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            A camera can only be deleted once no stream starts from it. Its identity goes with it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() =>
              confirmation.confirm(cameraId, {
                onSuccess: () => {
                  unpin();
                  navigate('..', { relative: 'path', replace: true });
                }
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
