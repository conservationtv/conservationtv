import { useRef, type FC, type ReactNode } from 'react';

import { CameraPictureContext } from '@/components/cameras/control/picture/camera-picture-context';
import { thumbnailOf } from '@/components/cameras/control/picture/camera-thumbnail';

export interface CameraPictureProps {
  children: ReactNode;
}

/**
 * Lets the parts beneath take a still of the camera's video (`useCameraPicture`), wherever among them the video is
 * shown: the video's frame marks itself, and the still is read from the canvas the player draws into inside it.
 */
export const CameraPicture: FC<CameraPictureProps> = ({ children }) => {
  const frameRef = useRef<HTMLElement | null>(null);
  const frame = (element: HTMLElement | null) => {
    frameRef.current = element;
  };
  const capture = () => {
    // No canvas is no video: the camera feeds no stream, or its stream can't be watched from here.
    const canvas = frameRef.current?.querySelector('canvas');
    return canvas ? thumbnailOf(canvas) : null;
  };
  return <CameraPictureContext value={{ frame, capture }}>{children}</CameraPictureContext>;
};
