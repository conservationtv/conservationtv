import { useEffect, useState, type FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SpeakerHighIcon, SpeakerSlashIcon } from '@phosphor-icons/react';
import { Stage, Stream, useSnapshot, useStreamStatus } from '@strangecyan/vignette/react';
import { Button } from '@conservationtv/ui/components/button';

import { CtvStreamView } from '@/components/shows/ctv-stream-view';
import { MonitorSoundContext } from '@/components/shows/monitor-sound';
import { useOrganisationId } from '@/hooks/use-organisation';
import { api } from '@/lib/api';
import { showOperationMutationKey, showQueryOptions } from '@/queries/shows';

// A show's broadcast (apps/studio/api/src/shows): what is on screen, composed by the show's own object from what is in
// the database, and followed by its stage here and by the outputs following it on their agents.

/** The source kinds a broadcast places beyond vignette's built-ins. */
const SOURCES = [CtvStreamView];

export interface BroadcastStageProps {
  showId: string;
}

/**
 * A show's broadcast, followed from its object in the API (apps/studio/api/src/shows/host.tsx) at the WebSocket address
 * the SDK gives, which `<Stream>` follows by its scheme, and rendered by vignette's React target. Every connection is
 * sent setup and the latest update first (a show never composed is composed for it), so `<Stream>` simply redials
 * with backoff when it drops. The session cookie travels with the upgrade, as with every call to the API. Keyed by the
 * show where it is used: another show is another stream, so it starts over.
 *
 * The stage is a monitor: it is silent until someone watching asks to hear it (`MonitorSoundContext`).
 */
export const BroadcastStage: FC<BroadcastStageProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const url = api.organisations.shows.follow({ id: organisationId, showId });
  const [listening, setListening] = useState(false);
  // Around `<Stream>` rather than inside it: sources placed for their sound alone, and sources placed in more than one
  // scene, render in hosts of `<Stream>`'s own beside its children, and must read it too.
  return (
    <MonitorSoundContext value={listening}>
      <Stream url={url} sources={SOURCES}>
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Stage className="w-full overflow-hidden rounded-lg bg-black" />
            <StageSound listening={listening} onListeningChange={setListening} />
          </div>
          <BroadcastStatus />
        </div>
        <ShowReadRefresh showId={showId} />
      </Stream>
    </MonitorSoundContext>
  );
};

/** Where the stage is with the stream: still connecting, caught up, or why it isn't. */
const BroadcastStatus: FC = () => {
  const status = useStreamStatus();
  const settled = status.revision.settled;
  return (
    <p className="text-custom-12 text-muted-foreground tabular-nums">
      {status.error ? `Can’t show the broadcast: ${status.error.message}` : status.phase}
      {settled === undefined ? null : ` · revision ${String(settled)}`}
    </p>
  );
};

interface StageSoundProps {
  listening: boolean;
  onListeningChange: (listening: boolean) => void;
}

/**
 * Over the stage's corner, while anything placed has sound: asks to hear the show, or stops hearing it. Once asked, a
 * browser may still hold the sound back until the page is pressed (vignette reports it `blocked`), so it asks again
 * then: pressing it is the gesture vignette's mixer waits for, and resumes it.
 */
const StageSound: FC<StageSoundProps> = ({ listening, onListeningChange }) => {
  const snapshot = useSnapshot();
  const status = useStreamStatus();
  const audible = snapshot?.sources.some(source => source.audio !== undefined) ?? false;
  if (!audible) return null;
  const blocked = status.audio?.state === 'blocked';
  const playing = listening && !blocked;
  return (
    <Button
      variant="secondary"
      size="sm"
      className="absolute right-2 bottom-2 opacity-90 shadow-sm"
      aria-pressed={playing}
      onClick={() => onListeningChange(!playing)}
    >
      {playing ? <SpeakerHighIcon /> : <SpeakerSlashIcon />}
      {playing ? 'Sound on' : 'Enable sound'}
    </Button>
  );
};

interface ShowReadRefreshProps {
  showId: string;
}

/**
 * Reads the show's controls again whenever its broadcast is composed again, which is how anything that changed it
 * elsewhere (chat, a camera locked, another member) reaches them; left alone while an operation from here is in
 * flight, which reads them again itself once it settles. Renders nothing.
 */
const ShowReadRefresh: FC<ShowReadRefreshProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const client = useQueryClient();
  const status = useStreamStatus();
  const settled = status.revision.settled;
  useEffect(() => {
    if (settled === undefined) return;
    if (client.isMutating({ mutationKey: showOperationMutationKey(organisationId, showId) }) > 0) return;
    void client.invalidateQueries({ queryKey: showQueryOptions(organisationId, showId).queryKey });
  }, [client, organisationId, showId, settled]);
  return null;
};
