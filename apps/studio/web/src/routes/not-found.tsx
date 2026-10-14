import { redirect } from 'react-router';

/** Unknown paths go home, as before. */
export function clientLoader() {
  throw redirect('/');
}

export default function NotFoundRoute() {
  return null;
}
