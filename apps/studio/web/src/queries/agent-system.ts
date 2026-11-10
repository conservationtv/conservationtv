import { queryOptions } from '@tanstack/react-query';

import { askAgent } from '@/lib/agent-connection';

// What an agent says about itself, asked of the agent directly: HTTP over iroh from this browser, as its own device
// in the organisation (src/lib/agent-connection.ts). The studio API only names the relay; it never sees the answers.

/** How often a reachable agent is asked again, and one that didn't answer is tried again. */
const LIVE_MS = 5_000;
const UNREACHABLE_RETRY_MS = 20_000;

/**
 * The agent's runtimes as it reports them now: the machine it runs on, MediaMTX, its metrics and OBS, and whether each
 * has taken its latest spec. Live, so it is asked again every few seconds while something shows it. An agent that
 * can't be reached (it is off, the relay is down) comes back as its failure's message rather than thrown, so the page
 * can say so in place and keep trying, a little less often.
 */
export const agentSystemQueryOptions = (organisationId: string, agentPublicId: string) =>
  queryOptions({
    queryKey: ['agent-direct', organisationId, agentPublicId, 'system'] as const,
    queryFn: async () => {
      try {
        const system = await askAgent(organisationId, agentPublicId, agent => agent.system.get.v1());
        return { system, askedAt: Date.now() };
      } catch (error) {
        return { failure: error instanceof Error ? error.message : String(error), askedAt: Date.now() };
      }
    },
    staleTime: 0,
    // Not kept between visits: a page opening on a minute-old answer would call a stopped agent running.
    gcTime: 0,
    refetchInterval: query => (query.state.data && 'failure' in query.state.data ? UNREACHABLE_RETRY_MS : LIVE_MS)
  });
