/**
 * Run by `OvhVpsMachine` as a local command: `node ovhVpsInstall.js install|describe`. Kept free of Pulumi so it runs
 * as a plain Node script.
 *
 * - `describe` reads the VPS's addresses and the id of the image named `FLEET_OVH_IMAGE` there (ids differ by region),
 *   and changes nothing.
 * - `install` reinstalls the VPS from that image with `FLEET_OVH_PUBLIC_KEY` for the image's default user, waits for
 *   the reinstall to finish, then describes it. Everything on the VPS is erased.
 *
 * Both print one JSON object on stdout. Credentials come from the environment, as the OVH SDKs and Pulumi provider
 * read them (`OVH_ENDPOINT` with `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET` and `OVH_CONSUMER_KEY`, or
 * `OVH_CLIENT_ID` and `OVH_CLIENT_SECRET`, or `OVH_ACCESS_TOKEN`), falling back to `ovh.conf` in the working directory,
 * the home directory or /etc.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENDPOINTS = new Map([
  ['ovh-eu', 'https://eu.api.ovh.com/1.0'],
  ['ovh-ca', 'https://ca.api.ovh.com/1.0'],
  ['ovh-us', 'https://api.us.ovhcloud.com/1.0'],
  ['kimsufi-eu', 'https://eu.api.kimsufi.com/1.0'],
  ['kimsufi-ca', 'https://ca.api.kimsufi.com/1.0'],
  ['soyoustart-eu', 'https://eu.api.soyoustart.com/1.0'],
  ['soyoustart-ca', 'https://ca.api.soyoustart.com/1.0']
]);
const TOKEN_URLS = new Map([
  ['ovh-eu', 'https://www.ovh.com/auth/oauth2/token'],
  ['ovh-ca', 'https://ca.ovh.com/auth/oauth2/token'],
  ['ovh-us', 'https://us.ovhcloud.com/auth/oauth2/token']
]);
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 10 * 1000;

/** `ovh.conf`: an ini file of sections, each a map of keys to values. */
type ConfigFile = Map<string, Map<string, string>>;

interface Credentials {
  endpoint: string;
  base: string;
  applicationKey?: string;
  applicationSecret?: string;
  consumerKey?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
}

/** The body of `POST /vps/{serviceName}/rebuild`. */
interface RebuildRequest {
  imageId: string;
  publicSshKey: string;
  doNotSendPassword: boolean;
}

interface Task {
  id: number;
  state: string;
  type: string;
}

interface VpsDetails {
  state: string;
}

interface VpsImage {
  id: string;
  name: string;
}

interface ApiError {
  message?: string;
}

interface TokenResponse {
  access_token: string;
}

interface Description {
  serviceName: string;
  state: string;
  image: string;
  imageId: string;
  ipv4: string;
  ipv6?: string;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// The first ovh.conf found wins, as in OVH's SDKs. Lines are `[section]` headers or `key = value` pairs; `;` and `#`
// start comments.
function readConfigFile(): ConfigFile {
  const text = [join(process.cwd(), 'ovh.conf'), join(homedir(), '.ovh.conf'), '/etc/ovh.conf']
    .map(readIfExists)
    .find(contents => contents !== undefined);
  const sections: ConfigFile = new Map();
  let section = new Map<string, string>();
  sections.set('', section);
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    const pair = /^([^=;#]+)=(.*)$/.exec(line);
    if (header) {
      section = new Map();
      sections.set(header[1].trim(), section);
    } else if (pair) {
      section.set(pair[1].trim(), pair[2].trim());
    }
  }
  return sections;
}

// Each value comes from its environment variable first, then from the endpoint's section of ovh.conf.
function readCredentials(): Credentials {
  const file = readConfigFile();
  const endpoint = process.env.OVH_ENDPOINT ?? file.get('default')?.get('endpoint') ?? 'ovh-eu';
  const section = file.get(endpoint) ?? new Map<string, string>();
  const value = (env: string, key: string) => process.env[env] ?? section.get(key);
  const base = ENDPOINTS.get(endpoint) ?? endpoint.replace(/\/$/, '');
  if (!base.startsWith('https://')) throw new Error(`Unknown OVH endpoint "${endpoint}".`);
  return {
    endpoint,
    base,
    applicationKey: value('OVH_APPLICATION_KEY', 'application_key'),
    applicationSecret: value('OVH_APPLICATION_SECRET', 'application_secret'),
    consumerKey: value('OVH_CONSUMER_KEY', 'consumer_key'),
    clientId: value('OVH_CLIENT_ID', 'client_id'),
    clientSecret: value('OVH_CLIENT_SECRET', 'client_secret'),
    accessToken: process.env.OVH_ACCESS_TOKEN
  };
}

class OvhClient {
  private timeDelta?: number;
  private bearer?: string;

  public constructor(private readonly credentials: Credentials) {}

  public get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path, '');
  }

  public post<T>(path: string, body: RebuildRequest): Promise<T> {
    return this.call<T>('POST', path, JSON.stringify(body));
  }

  private async call<T>(method: string, path: string, payload: string): Promise<T> {
    const url = `${this.credentials.base}${path}`;
    const headers = new Headers(await this.auth(method, url, payload));
    headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { method, headers, body: payload || undefined });
    const text = await response.text();
    if (!response.ok) throw new Error(`OVH API ${method} ${path} failed (${response.status}): ${errorMessage(text)}`);
    // SAFETY: every caller names the response type OVH's API documents for that path.
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // An access token, then the signed application key, then OAuth2 client credentials: the OVH SDKs' order.
  private async auth(method: string, url: string, payload: string): Promise<Headers> {
    const c = this.credentials;
    if (c.accessToken) return new Headers({ Authorization: `Bearer ${c.accessToken}` });
    if (c.applicationKey && c.applicationSecret && c.consumerKey) {
      const timestamp = String(Math.floor(Date.now() / 1000) + (await this.serverTimeDelta()));
      const signature = createHash('sha1')
        .update([c.applicationSecret, c.consumerKey, method, url, payload, timestamp].join('+'))
        .digest('hex');
      return new Headers({
        'X-Ovh-Application': c.applicationKey,
        'X-Ovh-Consumer': c.consumerKey,
        'X-Ovh-Timestamp': timestamp,
        'X-Ovh-Signature': `$1$${signature}`
      });
    }
    if (c.clientId && c.clientSecret) return new Headers({ Authorization: `Bearer ${await this.oauthToken()}` });
    throw new Error(
      'No OVH credentials: set OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET and OVH_CONSUMER_KEY, or OVH_CLIENT_ID ' +
        'and OVH_CLIENT_SECRET, or OVH_ACCESS_TOKEN (with OVH_ENDPOINT), or run `ovhcloud login`.'
    );
  }

  // Signatures carry the server's clock: a request more than a few seconds out is refused.
  private async serverTimeDelta(): Promise<number> {
    if (this.timeDelta === undefined) {
      const response = await fetch(`${this.credentials.base}/auth/time`);
      this.timeDelta = Number(await response.text()) - Math.floor(Date.now() / 1000);
    }
    return this.timeDelta;
  }

  private async oauthToken(): Promise<string> {
    if (this.bearer) return this.bearer;
    const tokenUrl = TOKEN_URLS.get(this.credentials.endpoint);
    if (!tokenUrl) throw new Error(`OAuth2 credentials are not supported for endpoint "${this.credentials.endpoint}".`);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.credentials.clientId ?? '',
        client_secret: this.credentials.clientSecret ?? '',
        scope: 'all'
      })
    });
    if (!response.ok) throw new Error(`OVH OAuth2 token request failed (${response.status}): ${await response.text()}`);
    // SAFETY: a successful OAuth2 client-credentials response always carries `access_token` (RFC 6749 §5.1).
    const token = (await response.json()) as TokenResponse;
    this.bearer = token.access_token;
    return this.bearer;
  }
}

/** OVH's error message from a failed response body, or the body itself when it is not OVH's JSON error. */
function errorMessage(text: string): string {
  try {
    // SAFETY: OVH's API errors are `{ message, ... }`; a body without `message` falls back to the raw text.
    return (JSON.parse(text) as ApiError).message ?? text;
  } catch {
    return text;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function imageId(client: OvhClient, vps: string, image: string): Promise<string> {
  const ids = await client.get<string[]>(`/vps/${vps}/images/available`);
  const images = await Promise.all(ids.map(id => client.get<VpsImage>(`/vps/${vps}/images/available/${id}`)));
  const match = images.find(candidate => candidate.name === image);
  if (!match) {
    const names = [...new Set(images.map(candidate => candidate.name))].sort().join(', ');
    throw new Error(`VPS ${decodeURIComponent(vps)} offers no image named "${image}". Available: ${names}.`);
  }
  return match.id;
}

async function describe(client: OvhClient, vps: string, image: string): Promise<Description> {
  const [details, ips, id] = await Promise.all([
    client.get<VpsDetails>(`/vps/${vps}`),
    client.get<string[]>(`/vps/${vps}/ips`),
    imageId(client, vps, image)
  ]);
  const ipv4 = ips.find(ip => !ip.includes(':'));
  if (!ipv4) throw new Error(`VPS ${decodeURIComponent(vps)} has no IPv4 address.`);
  const ipv6 = ips.find(ip => ip.includes(':'));
  return { serviceName: decodeURIComponent(vps), state: details.state, image, imageId: id, ipv4, ipv6 };
}

async function install(client: OvhClient, vps: string, image: string, publicKey: string): Promise<Description> {
  const id = await imageId(client, vps, image);
  const request: RebuildRequest = { imageId: id, publicSshKey: publicKey.trim(), doNotSendPassword: true };
  // OVH answers a rebuild with its task; an empty answer leaves the VPS state to follow instead.
  const answer = await client.post<Task | undefined>(`/vps/${vps}/rebuild`, request);
  const task = answer?.id === undefined ? undefined : answer;
  process.stderr.write(`Reinstalling ${decodeURIComponent(vps)} from ${image} (${id})\n`);
  await waitForReinstall(client, vps, task);
  return describe(client, vps, image);
}

// Follows the rebuild task when OVH returns one, then waits for the VPS to be running. Without a task, the reinstall is
// done once the VPS has left `running` and come back. The timeout fails the install.
async function waitForReinstall(client: OvhClient, vps: string, task: Task | undefined): Promise<void> {
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  let started = task !== undefined;
  while (Date.now() < deadline) {
    // Poll until the task (if any) is done and the VPS reports running after having been seen elsewhere.
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    if (task !== undefined && !(await taskDone(client, vps, task))) continue;
    const { state } = await client.get<VpsDetails>(`/vps/${vps}`);
    started = started || state !== 'running';
    if (started && state === 'running') return;
  }
  throw new Error(
    `Reinstalling ${decodeURIComponent(vps)} did not finish within ${INSTALL_TIMEOUT_MS / 60000} minutes.`
  );
}

/** Whether the task has finished; a failed or cancelled one fails the install. */
async function taskDone(client: OvhClient, vps: string, task: Task): Promise<boolean> {
  const current = await client.get<Task>(`/vps/${vps}/tasks/${task.id}`);
  if (current.state === 'error' || current.state === 'cancelled') {
    throw new Error(`Reinstall task ${current.id} ended ${current.state}.`);
  }
  return current.state === 'done';
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== 'install' && action !== 'describe') throw new Error('Usage: ovhVpsInstall.js install|describe');
  const client = new OvhClient(readCredentials());
  const vps = encodeURIComponent(required('FLEET_OVH_SERVICE'));
  const image = required('FLEET_OVH_IMAGE');
  const result =
    action === 'install'
      ? await install(client, vps, image, required('FLEET_OVH_PUBLIC_KEY'))
      : await describe(client, vps, image);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
