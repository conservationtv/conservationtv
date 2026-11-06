/** The sign-in page, coming back to this location afterwards. */
export function signInPath(location: SignInReturn): string {
  return `/sign-in?redirect=${encodeURIComponent(location.pathname + location.search)}`;
}

/** Where a page is, to come back to after signing in. */
export interface SignInReturn {
  pathname: string;
  search: string;
}

/** Where to go after signing in: the `redirect` query parameter, kept on this site. */
export function signInDestination(params: URLSearchParams): string {
  const target = params.get('redirect') ?? '/';
  return target.startsWith('/') && !target.startsWith('//') ? target : '/';
}
