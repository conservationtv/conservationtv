import type { FC } from 'react';
import { KeyIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';

import { CopyButton } from '@/components/common/copy-button';
import { FormError } from '@/components/common/form-error';
import { useOrganisationId } from '@/hooks/use-organisation';
import { API_URL } from '@/lib/auth-client';
import { bytesFromBase64url, hexFromBytes } from '@/lib/encoding';
import { useRevealKeyPair } from '@/queries/devices';

export interface AgentSetupProps {
  /** The agent's ID, which is its device's. */
  agentId: string;
  name: string;
}

/**
 * How to start the agent on a machine: its environment, with the secret key that makes it this agent. The key is
 * asked for only when someone presses the button, and kept only while this is on screen; anyone holding it can act as
 * the agent, so it is for administrators and is not shown until asked for.
 */
export const AgentSetup: FC<AgentSetupProps> = ({ agentId, name }) => {
  const organisationId = useOrganisationId();
  const reveal = useRevealKeyPair(organisationId);
  if (!reveal.data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button variant="outline" loading={reveal.isPending} onClick={() => reveal.mutate(agentId)}>
          <KeyIcon />
          Show its environment
        </Button>
        <FormError error={reveal.error} />
      </div>
    );
  }
  const environment = [
    'AGENT_MODE=conservationtv',
    `AGENT_NAME=${JSON.stringify(name)}`,
    // The agent reads its secret key as hex; the API gives the raw 32-byte seed as unpadded base64url.
    `AGENT_SECRET_KEY=${hexFromBytes(bytesFromBase64url(reveal.data.privateKey))}`,
    `STUDIO_API_URL=${API_URL}`
  ].join('\n');
  return (
    <div className="flex flex-col gap-2">
      <div className="relative rounded-md border border-border bg-muted/40">
        <pre className="overflow-x-auto p-3 pr-10 font-mono text-custom-12 leading-relaxed text-foreground">
          {environment}
        </pre>
        <div className="absolute top-2 right-2">
          <CopyButton value={environment} label="Copy the environment" />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-custom-12 text-custom-text-secondary">
          Keep the secret key private: whoever has it is this agent.
        </p>
        <Button variant="ghost" size="sm" onClick={() => reveal.reset()}>
          Hide
        </Button>
      </div>
    </div>
  );
};
