import type { FC } from 'react';
import { useOutletContext } from 'react-router';

import type { Route } from './+types/stream-new-camera';
import type { NewStreamOutletContext } from './stream-new';
import { AddCameraDialog } from '@/components/cameras/add-camera-dialog';

export const meta: Route.MetaFunction = () => [{ title: 'Add a camera · New stream · conservation.tv studio' }];

/**
 * Adding a camera from the new-stream form, at `streams/new/camera`: the dialog opens over the form, which keeps what
 * has been filled in, and once the camera is made the form chooses it as the stream's source.
 */
const StreamNewCameraRoute: FC = () => {
  const { onCameraAdded } = useOutletContext<NewStreamOutletContext>();
  return <AddCameraDialog onAdded={onCameraAdded} />;
};

export default StreamNewCameraRoute;
