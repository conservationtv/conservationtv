import { setTimeout as sleep } from 'node:timers/promises';
import { log, spinner } from '@clack/prompts';
import { authClient } from './api.js';
import { LoginError } from './errors.js';

/** The client ID the API's device flow accepts for this CLI: named for the studio CLI it replaced. */
const CLIENT_ID = 'studio-cli';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// Prompts and progress draw on stderr: stdout carries the command's result.
const output = process.stderr;

type AuthClient = ReturnType<typeof authClient>;

/** A signed-in session, before it has a profile. */
export interface Session {
  token: string;
  email: string | undefined;
}

/** Better Auth's bearer plugin reads the session from this header, so no cookie is needed. */
function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

interface DeviceCode {
  device_code: string;
  expires_in: number;
  interval: number;
}

/** Poll until the person approves or denies the code in the web app, backing off when asked to. */
async function waitForApproval(auth: AuthClient, code: DeviceCode): Promise<string> {
  const deadline = Date.now() + code.expires_in * 1000;
  let interval = code.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const { data, error } = await auth.device.token({
      grant_type: DEVICE_CODE_GRANT,
      device_code: code.device_code,
      client_id: CLIENT_ID
    });
    if (data) return data.access_token;
    // Only the two waiting states continue; every other error ends the login.
    switch (error.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += 5;
        break;
      default:
        throw new LoginError(error.error_description ?? `Login failed: ${error.error}`);
    }
  }
  throw new LoginError('The code expired before it was approved. Log in again.');
}

/** `waitForApproval`, with a spinner on a terminal; one line otherwise, where animation frames would only be noise. */
async function showApproval(auth: AuthClient, code: DeviceCode): Promise<string> {
  if (!output.isTTY) {
    log.step('Waiting for approval', { output });
    return waitForApproval(auth, code);
  }
  const progress = spinner({ output });
  progress.start('Waiting for approval');
  try {
    const token = await waitForApproval(auth, code);
    progress.stop('Approved');
    return token;
  } catch (failure) {
    progress.error('Not approved');
    throw failure;
  }
}

/** The OAuth device flow: show a code, then wait while the person approves it in the web app. */
export async function authorize(apiUrl: string): Promise<Session> {
  const auth = authClient(apiUrl);
  const { data: code, error } = await auth.device.code({ client_id: CLIENT_ID });
  if (error) throw new LoginError(`The API refused to start a device login (HTTP ${error.status}).`);
  const url = code.verification_uri_complete ?? code.verification_uri;
  log.step(`Open ${url} and approve the code ${code.user_code}`, { output });
  const token = await showApproval(auth, code);
  const session = await auth.getSession({ fetchOptions: bearer(token) });
  return { token, email: session.data?.user.email };
}

/** Revoke a session on the API, which also removes its browser devices. */
export async function signOut(apiUrl: string, token: string): Promise<void> {
  const auth = authClient(apiUrl);
  await auth.signOut({ fetchOptions: bearer(token) });
}
