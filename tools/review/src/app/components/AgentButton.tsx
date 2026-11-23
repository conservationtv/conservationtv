import { Button } from '@conservationtv/ui/components/button';
import { RobotIcon } from '@phosphor-icons/react';
import { useState, type FC } from 'react';
import { send } from '../api.ts';
import { useSession } from '../session.ts';

// Starting an agent on the owner's machine to sign a pull request off: it runs the signoffs, fixes what fails, and
// pushes. Shown only to an operator (the Worker checks again), and only once per press until it answers.

interface AgentButtonProps {
  number: number;
  /** The signoffs to run; every one when left out. */
  signoffs?: readonly string[];
  label: string;
  size?: 'xs' | 'sm';
}

/** Nothing for anyone but an operator; then idle, starting, started, or why it didn't. */
export const AgentButton: FC<AgentButtonProps> = ({ number, signoffs, label, size = 'sm' }) => {
  const session = useSession();
  const [state, setState] = useState<'idle' | 'sending' | 'started'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (!session?.operator) return null;

  async function start() {
    setState('sending');
    setError(null);
    try {
      await send(`/api/pulls/${number}/agent`, signoffs ? { signoffs: [...signoffs] } : {});
      setState('started');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The agent did not start.');
      setState('idle');
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        variant="outline"
        size={size}
        loading={state === 'sending'}
        disabled={state === 'started'}
        title={
          signoffs
            ? `An agent runs ${signoffs.join(', ')} and fixes what fails`
            : 'An agent runs every signoff and fixes what fails'
        }
        onClick={() => void start()}
      >
        <RobotIcon data-icon="inline-start" />
        {state === 'started' ? 'Agent started' : label}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
};
