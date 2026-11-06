import type { FC } from 'react';
import { Navigate } from 'react-router';

/** Unknown paths go home, as before. */
const NotFoundRoute: FC = () => {
  return <Navigate to="/" replace />;
};

export default NotFoundRoute;
