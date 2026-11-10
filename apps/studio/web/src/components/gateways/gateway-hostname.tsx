import { useState, type FC } from 'react';

import { CopyButton } from '@/components/common/copy-button';
import { StatusLabel, type Status } from '@/components/common/status';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';

// The hostname a MediaMTX gateway is reached at on its network, `<gateway>.<organisation>.<GATEWAY_DOMAIN>`, and the
// certificate it serves TLS with (apps/studio/api/src/gateways/certificates.ts). The studio gives it both when the
// agent running it asks for its configuration, so a gateway nothing runs has neither yet.

/** The hostname and certificate as the gateway list carries them (`tls` on each of the organisation's own). */
interface GatewayTls {
  hostname: string;
  /** Where the hostname's DNS record last pointed: the agent's preferred address. */
  address: string | null;
  issuedAt: string | null;
  notAfter: string | null;
  /** The last attempt to issue one, and why it failed, if it did. */
  attemptedAt: string | null;
  error: string | null;
}

/** How the certificate stands, as a status and in words. */
interface CertificateStanding {
  status: Status;
  words: string;
}

/**
 * Valid until it expires; expired once it has; otherwise being issued, or failing to be. A failure beside a valid
 * certificate is a renewal that hasn't worked yet, which matters only once the certificate runs out.
 */
function standingOf(tls: GatewayTls, now: number): CertificateStanding {
  if (tls.notAfter !== null && Date.parse(tls.notAfter) > now) {
    return { status: 'ok', words: `Certificate until ${formatDate(tls.notAfter)}` };
  }
  if (tls.notAfter !== null)
    return { status: 'failing', words: `Certificate expired ${formatRelative(tls.notAfter, now)}` };
  if (tls.error !== null) return { status: 'failing', words: 'No certificate yet' };
  return { status: 'unknown', words: 'Issuing a certificate' };
}

export interface GatewayHostnameProps {
  /** The gateway's hostname and certificate: null until it has been given one. */
  tls: GatewayTls | null;
}

/** The gateway's hostname, with a copy button, how its certificate stands, and why the last attempt failed if it did. */
export const GatewayHostname: FC<GatewayHostnameProps> = ({ tls }) => {
  // When the row was first shown: what it says about expiry holds still while it stays on screen.
  const [now] = useState(Date.now);
  if (!tls) {
    return (
      <p className="text-custom-12 text-custom-text-secondary">
        No hostname yet. The studio gives it one when its agent next asks for its configuration.
      </p>
    );
  }
  const standing = standingOf(tls, now);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-custom-12 text-foreground" title={tls.hostname}>
            {tls.hostname}
          </span>
          <CopyButton value={tls.hostname} label="Copy hostname" />
        </span>
        <StatusLabel status={standing.status}>{standing.words}</StatusLabel>
        {tls.address !== null && (
          <span className="text-custom-12 text-custom-text-secondary">Points at {tls.address}</span>
        )}
      </div>
      {tls.error !== null && tls.attemptedAt !== null && (
        <p className="text-custom-12 text-destructive" title={formatDateTime(tls.attemptedAt)}>
          Last attempt {formatRelative(tls.attemptedAt, now)} failed: {tls.error}
        </p>
      )}
    </div>
  );
};
