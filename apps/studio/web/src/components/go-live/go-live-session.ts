import { useEffect, useRef, useState } from 'react';
import { HttpError } from '@conservationtv/studio-sdk';

import {
  personalDevice,
  publishMoq,
  publishProtocols,
  publishWhip,
  WhipRefused,
  type MoqTarget,
  type PublishConnection,
  type SessionState,
  type UrlTarget
} from '@/lib/publishing';
import { askToPublish, useEnsurePersonalStream, type Expiring } from '@/queries/publishing';

// Going live from this browser, as a session the page starts and stops: the stream its person goes live on from this
// kind of device (made the first time), the credential and gateway the API chooses for what this browser can send,
// and then sending, by MoQ or WHIP (src/lib/publishing.ts), until stopped. A MoQ session redials by itself, and its
// credential is renewed before it expires; a WHIP session that is lost, or any attempt that fails for a moment, is
// asked for again and started afresh.

/** Where going live is: not started; asking; dialling; sending; cut off and trying again; or given up, saying why. */
export type GoLivePhase = 'idle' | 'starting' | SessionState | 'failed';

export interface GoLiveStatus {
  phase: GoLivePhase;
  /** What to tell its person about it: why it failed, or what it is waiting for. */
  message?: string;
  /** The stream being published, once it is known. */
  streamId?: string;
  /** How it is sent: `moq` or `webrtc`. */
  protocol?: string;
}

/** How long to wait before asking again after a session is lost or refused; doubled for each failure in a row. */
const RETRY_MS = 3_000;

/** The longest wait between attempts, for a phone that is out of signal for a while. */
const RETRY_MAX_MS = 30_000;

/** How long before a credential expires to ask for the next one. */
const RENEW_BEFORE_MS = 5 * 60_000;

/** What a session publishes, and how its credentials are asked for. */
interface Publication {
  organisationId: string;
  streamId: string;
  protocols: string[];
  networkId: string | null;
  media: MediaStream;
}

type Report = (status: Omit<GoLiveStatus, 'streamId'>) => void;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** When to ask for a credential again: shortly before it expires, and never sooner than a minute. */
function renewIn(expiresAt: string | undefined): number {
  if (expiresAt === undefined) return Number.MAX_SAFE_INTEGER;
  return Math.max(Date.parse(expiresAt) - Date.now() - RENEW_BEFORE_MS, 60_000);
}

/** Whether the API's answer is a MoQ connection: one naming a relay. */
function isMoq(connection: PublishConnection): connection is MoqTarget {
  return connection.protocol === 'moq' && 'relay' in connection;
}

/**
 * Publish over MoQ until `signal` aborts, renewing the credential shortly before each expires. A renewal that fails
 * is tried again a minute later: the session carries on meanwhile, and redials with what it has.
 */
async function publishByMoq(
  publication: Publication,
  connection: MoqTarget & Expiring,
  signal: AbortSignal,
  report: Report
) {
  const session = await publishMoq(publication.media, connection, {
    onState: (phase, message) => report({ phase, message, protocol: 'moq' })
  });
  let expiresAt = connection.expiresAt;
  try {
    while (!signal.aborted) {
      await pause(renewIn(expiresAt), signal);
      if (signal.aborted) break;
      try {
        const { organisationId, streamId, protocols, networkId } = publication;
        const renewed = await askToPublish(organisationId, streamId, protocols, networkId);
        session.renew(renewed.connection);
        expiresAt = renewed.connection.expiresAt;
      } catch {
        expiresAt = new Date(Date.now() + RENEW_BEFORE_MS + 60_000).toISOString();
      }
    }
  } finally {
    session.close();
  }
}

/** Publish over WHIP until the session is lost or `signal` aborts. */
async function publishByWhip(publication: Publication, connection: UrlTarget, signal: AbortSignal, report: Report) {
  let lost: () => void = () => undefined;
  const ended = new Promise<void>(resolve => {
    lost = resolve;
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  const session = await publishWhip(publication.media, connection, {
    onState: (phase, message) => {
      report({ phase, message, protocol: 'webrtc' });
      if (phase === 'lost') lost();
    }
  });
  await ended;
  session.close();
}

/**
 * Whether the API's refusal will be the same however often it is asked: no right to publish, a stream with a source of
 * its own, a stream that is gone, nowhere to publish it. Anything else (no answer at all, a 5xx, a timeout, being asked
 * to slow down) is a moment's trouble, as a phone moving between networks has.
 */
function isPermanent(error: Error): boolean {
  return error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429;
}

/**
 * Publish until `signal` aborts: asking for a credential, sending, and asking again whenever a session is lost or
 * anything on the way fails for a moment, waiting longer each time it fails in a row. Only a refusal that asking
 * again would not change ends it, thrown with its message.
 */
async function publishUntil(publication: Publication, signal: AbortSignal, report: Report) {
  // Failures in a row: none after a session that started, or a refusal that is only waiting for the gateway.
  let failures = 0;
  while (!signal.aborted) {
    // MoQ redials by itself, so its session lasts until stopped. A WHIP session lasts until it is lost, and the next
    // is asked for promptly; a refusal (404 while the gateway's agent has yet to serve the path, within about half a
    // minute) is told and asked for again shortly.
    let protocol: string | undefined = undefined;
    try {
      const { organisationId, streamId, protocols, networkId } = publication;
      const { connection } = await askToPublish(organisationId, streamId, protocols, networkId);
      protocol = connection.protocol;
      report({ phase: 'connecting', protocol });
      if (isMoq(connection)) {
        await publishByMoq(publication, connection, signal, report);
        return;
      }
      await publishByWhip(publication, connection, signal, report);
      failures = 0;
    } catch (error) {
      // Stopping is not a failure; a permanent refusal ends it; waiting for the gateway is not a failure in a row.
      if (signal.aborted) return;
      if (error instanceof Error && isPermanent(error)) throw error;
      if (error instanceof WhipRefused && error.status === 404) {
        const message = 'Waiting for the gateway to take this stream. It can take half a minute.';
        report({ phase: 'connecting', message, protocol });
        failures = 0;
      } else {
        const message = error instanceof WhipRefused ? error.message : 'Can’t reach conservation.tv. Trying again.';
        report({ phase: 'lost', message, protocol });
        failures += 1;
      }
    }
    await pause(Math.min(RETRY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_MS), signal);
  }
}

/**
 * Going live from this browser: `start` sends a capture, from where its person says they are (`networkId`, null for
 * the internet), until `stop`; `status` says how it is going. Stopping, or leaving the page, ends the session but
 * leaves the capture to whoever made it.
 */
export function useGoLiveSession(organisationId: string) {
  const ensure = useEnsurePersonalStream(organisationId);
  const [status, setStatus] = useState<GoLiveStatus>({ phase: 'idle' });
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  // The stream first (made the first time), then what this browser can send, then publishing until stopped; a
  // failure that is not the session's own stopping is told.
  const start = async (media: MediaStream, networkId: string | null) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setStatus({ phase: 'starting' });
    try {
      const stream = await ensure.mutateAsync(personalDevice());
      const protocols = await publishProtocols();
      if (protocols.length === 0) throw new Error('This browser can’t send video: try another browser.');
      const report: Report = next => {
        if (!controller.signal.aborted) setStatus({ ...next, streamId: stream.id });
      };
      report({ phase: 'starting' });
      await publishUntil(
        { organisationId, streamId: stream.id, protocols, networkId, media },
        controller.signal,
        report
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Going live failed.';
      if (!controller.signal.aborted) setStatus(current => ({ ...current, phase: 'failed', message }));
    }
  };

  const stop = () => {
    running.current?.abort();
    running.current = null;
    setStatus({ phase: 'idle' });
  };

  return { status, start, stop };
}
