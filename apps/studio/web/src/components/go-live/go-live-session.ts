import { useEffect, useRef, useState } from 'react';
import { BroadcastPipeline, resolveBroadcast } from '@conservationtv/broadcast';
import { HttpError } from '@conservationtv/studio-sdk';

import {
  personalDevice,
  profileFor,
  publishMoq,
  publishProtocols,
  type MoqTarget,
  type CaptureSource,
  type PublishConnection,
  type SessionState
} from '@/lib/publishing';
import { askToPublish, useEnsurePersonalStream, type Expiring, type ExpiringConnection } from '@/queries/publishing';

// Going live from this browser, as a session the page starts and stops: the stream its person goes live on from this
// kind of device (made the first time), a credential for conservation.tv, and then sending by MoQ
// (src/lib/publishing.ts) until stopped. What is sent is resolved once, for this device and this capture, as one
// broadcast pipeline: a ladder of sizes, each encoded only while someone watches it. The session redials by itself,
// and its credential is renewed before it expires; asking for one that fails for a moment is tried again.

/** Where going live is: not started; asking; dialling; sending; cut off and trying again; or given up, saying why. */
export type GoLivePhase = 'idle' | 'starting' | SessionState | 'failed';

export interface GoLiveStatus {
  phase: GoLivePhase;
  /** What to tell its person about it: why it failed, or what it is waiting for. */
  message?: string;
  /** The stream being published, once it is known. */
  streamId?: string;
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
  pipeline: BroadcastPipeline;
}

type Report = (status: Omit<GoLiveStatus, 'streamId'>) => void;

/**
 * Resolves once `signal` aborts, at once if it already has: an abort that has already happened never fires its event,
 * so a listener added after it would wait for ever.
 */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const elapsed = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([elapsed, aborted(signal)]);
  clearTimeout(timer);
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
  const session = await publishMoq(publication.pipeline, connection, {
    onState: (phase, message) => report({ phase, message })
  });
  let expiresAt = connection.expiresAt;
  try {
    while (!signal.aborted) {
      await pause(renewIn(expiresAt), signal);
      if (signal.aborted) break;
      try {
        const { organisationId, streamId, protocols } = publication;
        const renewed = await askToPublish(organisationId, streamId, protocols, null, signal);
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

/**
 * Publish one session by the connection the API gave, unless stopped while it was asked for, when nothing is dialled.
 * It redials by itself, so it lasts until stopped.
 */
async function publishSession(
  publication: Publication,
  connection: ExpiringConnection,
  signal: AbortSignal,
  report: Report
): Promise<void> {
  if (signal.aborted) return;
  // Only MoQ is asked for, so anything else is the API's mistake, and asking again would not change it.
  if (!isMoq(connection)) throw new Error('conservation.tv offered no way to go live from this browser.');
  report({ phase: 'connecting' });
  await publishByMoq(publication, connection, signal, report);
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
 * Publish until `signal` aborts: asking for a credential and sending, and asking again whenever asking fails for a
 * moment, waiting longer each time it fails in a row. Only a refusal that asking again would not change ends it,
 * thrown with its message.
 */
async function publishUntil(publication: Publication, signal: AbortSignal, report: Report) {
  let failures = 0;
  while (!signal.aborted) {
    // A session that starts lasts until stopped; asking that fails waits, longer after each failure in a row.
    try {
      const { organisationId, streamId, protocols } = publication;
      const { connection } = await askToPublish(organisationId, streamId, protocols, null, signal);
      await publishSession(publication, connection, signal, report);
      return;
    } catch (error) {
      // Stopping is not a failure; a permanent refusal ends it; anything else is tried again, later each time.
      if (signal.aborted) return;
      if (error instanceof Error && isPermanent(error)) throw error;
      report({ phase: 'lost', message: 'Can’t reach conservation.tv. Trying again.' });
      failures += 1;
    }
    await pause(Math.min(RETRY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_MS), signal);
  }
}

/**
 * Going live from this browser: `start` sends a capture of a source (a camera or a screen) until `stop`; `status`
 * says how it is going. Stopping, or leaving the page, ends the session but leaves the capture to whoever made it.
 */
export function useGoLiveSession(organisationId: string) {
  const ensure = useEnsurePersonalStream(organisationId);
  const [status, setStatus] = useState<GoLiveStatus>({ phase: 'idle' });
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  // The stream first (made the first time), then what this browser can send, then publishing until stopped; a
  // failure that is not the session's own stopping is told.
  const start = async (media: MediaStream, source: CaptureSource) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setStatus({ phase: 'starting' });
    let pipeline: BroadcastPipeline | undefined = undefined;
    try {
      const stream = await ensure.mutateAsync(personalDevice());
      const protocols = await publishProtocols();
      if (protocols.length === 0) throw new Error('This browser can’t go live: try another browser.');
      // The source's ladder, fitted to this device and the capture as it came: resolved once, kept until stopped.
      const broadcast = await resolveBroadcast(profileFor(source), media);
      if (controller.signal.aborted) return;
      pipeline = new BroadcastPipeline(media, broadcast);
      const report: Report = next => {
        if (!controller.signal.aborted) setStatus({ ...next, streamId: stream.id });
      };
      report({ phase: 'starting' });
      await publishUntil({ organisationId, streamId: stream.id, protocols, pipeline }, controller.signal, report);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Going live failed.';
      if (!controller.signal.aborted) setStatus(current => ({ ...current, phase: 'failed', message }));
    } finally {
      pipeline?.close();
    }
  };

  const stop = () => {
    running.current?.abort();
    running.current = null;
    setStatus({ phase: 'idle' });
  };

  return { status, start, stop };
}
