/** Flipped once per page load, so the answer holds until a reload. */
const signedIn = Math.random() < 0.5;

/**
 * Whether someone is signed in, standing in for the local check the about page will make (the session the browser
 * already holds), so it answers straight away rather than waiting on the server.
 */
export function isSignedInStandIn() {
  return signedIn;
}
