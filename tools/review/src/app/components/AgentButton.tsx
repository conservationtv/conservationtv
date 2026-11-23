import { Button } from '@conservationtv/ui/components/button';
import { RobotIcon } from '@phosphor-icons/react';
import { useState, type FC } from 'react';
import type { AgentRequest, CommentAgentRequest, Session } from '../../shared/actions.ts';
import { send } from '../api.ts';
import { useSession } from '../session.ts';

// Starting one of the owner's agents through the Worker: signing a pull request off, or fixing what a comment points
// at. Shown only to an operator whose agent is set up (the Worker checks again), and once per press until it answers.

interface AgentButtonProps {
  /** Which agent: shown only when the viewer may start it. */
  agent: keyof Session['agents'];
  /** The Worker's route for it, and what to send. */
  path: string;
  body: AgentRequest | CommentAgentRequest;
  label: string;
  /** What it will do, on hover. */
  title: string;
  size?: 'xs' | 'sm';
  /** Just the robot, where a row has no room for words: the label is read aloud and shown on hover. */
  iconOnly?: boolean;
}

/** Nothing for anyone who may not start it; then idle, starting, started, or why it didn't. */
export const AgentButton: FC<AgentButtonProps> = ({
  agent,
  path,
  body,
  label,
  title,
  size = 'sm',
  iconOnly = false
}) => {
  const session = useSession();
  const [state, setState] = useState<'idle' | 'sending' | 'started'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (!session?.agents[agent]) return null;

  async function start() {
    setState('sending');
    setError(null);
    try {
      await send(path, body);
      setState('started');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The agent did not start.');
      setState('idle');
    }
  }

  const started = state === 'started';
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        variant="outline"
        size={iconOnly ? 'icon-xs' : size}
        loading={state === 'sending'}
        disabled={started}
        title={started ? 'Agent started' : title}
        aria-label={iconOnly ? label : undefined}
        onClick={() => void start()}
      >
        <RobotIcon data-icon={iconOnly ? undefined : 'inline-start'} />
        <ButtonText iconOnly={iconOnly} started={started} label={label} />
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
};

interface ButtonTextProps {
  iconOnly: boolean;
  started: boolean;
  label: string;
}

/** The button's words: none beside the robot alone; once pressed, that the agent started. */
const ButtonText: FC<ButtonTextProps> = ({ iconOnly, started, label }) => {
  if (iconOnly) return null;
  return <>{started ? 'Agent started' : label}</>;
};

interface SignoffAgentProps {
  number: number;
  /** The signoffs to run; every one when left out. */
  signoffs?: readonly string[];
  label: string;
  size?: 'xs' | 'sm';
  iconOnly?: boolean;
}

/** An agent running some signoffs, or every one, on a pull request and fixing what fails. */
export const SignoffAgent: FC<SignoffAgentProps> = ({ number, signoffs, label, size, iconOnly }) => (
  <AgentButton
    agent="signoffs"
    path={`/api/pulls/${number}/agent`}
    body={signoffs ? { signoffs: [...signoffs] } : {}}
    label={label}
    title={
      signoffs
        ? `An agent runs ${signoffs.join(', ')} and fixes what fails`
        : 'An agent runs every signoff and fixes what fails'
    }
    size={size}
    iconOnly={iconOnly}
  />
);

interface CommentAgentProps {
  number: number;
  comment: number;
  kind: CommentAgentRequest['kind'];
}

/** An agent fixing the code a comment points at, pushing the fix and replying on its thread. */
export const CommentAgent: FC<CommentAgentProps> = ({ number, comment, kind }) => (
  <AgentButton
    agent="comments"
    path={`/api/pulls/${number}/comments/${comment}/agent`}
    body={{ kind }}
    label="Fix with agent"
    title="An agent fixes what this comment points at, pushes, and replies on its thread"
    size="xs"
  />
);
