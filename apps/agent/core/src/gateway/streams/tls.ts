import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediamtxTls } from '@conservationtv/studio-sdk';

// The certificate MediaMTX serves TLS with, from the studio API's configuration: the gateway's hostname, its chain and
// its key (`MediamtxTls`, as the studio SDK names it). MediaMTX reads them from files, and reads a file again only when its config names a different one, so each
// certificate is written under a name of its own, from its digest, and the config changing to name it is what makes
// MediaMTX pick it up. Whatever else is in the directory is from an earlier certificate, and removed.

/** Where MediaMTX reads the certificate and key from. */
export interface TlsFiles {
  hostname: string;
  certificate: string;
  key: string;
}

/** The files for `tls` under `directory`, written if they are not there, with any other certificate's removed. */
export async function writeTlsFiles(directory: string, tls: MediamtxTls): Promise<TlsFiles> {
  await mkdir(directory, { recursive: true });
  const digest = createHash('sha256').update(tls.certificate).digest('hex').slice(0, 16);
  const certificate = join(directory, `${digest}.crt`);
  const key = join(directory, `${digest}.key`);
  const wanted = new Set([`${digest}.crt`, `${digest}.key`]);
  for (const entry of await readdir(directory)) {
    if (!wanted.has(entry)) await rm(join(directory, entry), { force: true });
  }
  await writeFile(certificate, tls.certificate);
  await writeFile(key, tls.privateKey, { mode: 0o600 });
  return { hostname: tls.hostname, certificate, key };
}

/** Removes every certificate written. */
export function removeTlsFiles(directory: string): Promise<void> {
  return rm(directory, { recursive: true, force: true });
}
