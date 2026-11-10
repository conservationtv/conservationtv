import type { FC } from 'react';

import type { Route } from './+types/camera-new';
import { AddCameraDialog } from '@/components/cameras/add-camera-dialog';

export const meta: Route.MetaFunction = () => [{ title: 'Add a camera · conservation.tv studio' }];

/** Adding a camera, as a dialog over the cameras page at `cameras/new`, closing back to the list once it is made. */
const CameraNewRoute: FC = () => {
  return <AddCameraDialog />;
};

export default CameraNewRoute;
