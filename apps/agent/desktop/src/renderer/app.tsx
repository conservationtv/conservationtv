import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { FolderOpenIcon, LinkIcon, PlayIcon, StopIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@conservationtv/ui/components/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import type { AgentIdentity, DesktopState, LogLine, RuntimeView } from '../shared/bridge.ts';
import { desktop, useDesktopState, useLogLines } from './desktop.ts';

// The window: the agent this computer runs as, whether it runs and what its runtimes are doing, and its latest log
// lines; or, before it is set up, how to set it up from the studio.

export const App: FC = () => {
  const state = useDesktopState();
  return (
    <main className="flex h-screen flex-col gap-3 p-4">
      {state.agent === null ? <NotSetUp /> : <AgentPanel agent={state.agent} state={state} />}
    </main>
  );
};

const NotSetUp: FC = () => (
  <Empty className="flex-1">
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <LinkIcon />
      </EmptyMedia>
      <EmptyTitle>Set this computer up as an agent</EmptyTitle>
      <EmptyDescription>
        In the studio, open the agent's page and choose Open in the desktop app. This app runs it from then on, whenever
        it is open.
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
);

const STATE_LABELS = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping'
} satisfies Record<DesktopState['state'], string>;

interface AgentPanelProps {
  agent: AgentIdentity;
  state: DesktopState;
}

const AgentPanel: FC<AgentPanelProps> = ({ agent, state }) => (
  <>
    <Card>
      <CardHeader>
        <CardTitle>{agent.name}</CardTitle>
        <CardDescription>For the studio at {new URL(agent.apiUrl).host}</CardDescription>
        <CardAction>
          <Badge variant={state.state === 'running' ? 'default' : 'outline'}>{STATE_LABELS[state.state]}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.error !== null && (
          <Alert variant="destructive">
            <WarningIcon />
            <AlertTitle>The agent stopped</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <Runtimes runtimes={state.runtimes} />
        <div className="flex flex-wrap gap-2">
          <StartStop state={state.state} />
          <Button variant="outline" onClick={() => void desktop.openDataFolder()}>
            <FolderOpenIcon />
            Data folder
          </Button>
          <Button variant="ghost" className="ml-auto" onClick={() => void desktop.forget()}>
            <TrashIcon />
            Forget
          </Button>
        </div>
      </CardContent>
    </Card>
    <Logs />
  </>
);

interface StartStopProps {
  state: DesktopState['state'];
}

const StartStop: FC<StartStopProps> = ({ state }) => {
  const [pending, setPending] = useState(false);
  const busy = pending || state === 'starting' || state === 'stopping';
  const run = (action: () => Promise<void>) => {
    setPending(true);
    void action().finally(() => setPending(false));
  };
  if (state === 'stopped') {
    return (
      <Button loading={busy} onClick={() => run(desktop.start)}>
        <PlayIcon />
        Start
      </Button>
    );
  }
  return (
    <Button variant="outline" loading={busy} onClick={() => run(desktop.stop)}>
      <StopIcon />
      Stop
    </Button>
  );
};

const APPLY_LABELS = {
  applying: 'Applying',
  applied: 'Up to date',
  failed: 'Failing'
} satisfies Record<RuntimeView['apply'], string>;

interface RuntimesProps {
  runtimes: RuntimeView[];
}

const Runtimes: FC<RuntimesProps> = ({ runtimes }) => {
  if (runtimes.length === 0) return null;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
      {runtimes.map(runtime => (
        <li key={runtime.key} className="flex flex-col gap-0.5 px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono">{runtime.key}</span>
            <Badge variant={runtime.apply === 'failed' ? 'destructive' : 'secondary'}>
              {APPLY_LABELS[runtime.apply]}
            </Badge>
          </div>
          {runtime.error !== null && <span className="text-destructive">{runtime.error}</span>}
        </li>
      ))}
    </ul>
  );
};

const LEVEL_CLASSES = {
  trace: 'text-muted-foreground',
  debug: 'text-muted-foreground',
  info: '',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
  fatal: 'text-destructive'
} satisfies Record<LogLine['level'], string>;

const Logs: FC = () => {
  const lines = useLogLines();
  const end = useRef<HTMLDivElement>(null);
  // Braced: Chromium's scrollIntoView returns a promise now, which React would take for the effect's cleanup.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [lines]);
  return (
    <Section
      title="Log"
      action={
        <Button variant="ghost" size="sm" onClick={() => void desktop.openLogFolder()}>
          <FolderOpenIcon />
          Show file
        </Button>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[0.6875rem] leading-relaxed">
        {lines.map((line, index) => (
          <div key={`${String(line.timestamp)}-${String(index)}`} className={LEVEL_CLASSES[line.level]}>
            <span className="text-muted-foreground">{new Date(line.timestamp).toLocaleTimeString()} </span>
            {line.message}
          </div>
        ))}
        <div ref={end} />
      </div>
    </Section>
  );
};

interface SectionProps {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}

const Section: FC<SectionProps> = ({ title, action, children }) => (
  <section className="flex min-h-0 flex-1 flex-col gap-1.5">
    <div className="flex items-center justify-between">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      {action}
    </div>
    {children}
  </section>
);
