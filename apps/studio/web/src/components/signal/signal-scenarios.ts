import { parseAsStringLiteral, useQueryState } from 'nuqs';

import { SCENARIOS, type SignalScenario } from '@/components/signal/signal-samples';

const KEYS = SCENARIOS.map(scenario => scenario.key);
const parser = parseAsStringLiteral(KEYS).withDefault(KEYS[0] ?? '');

export interface ScenarioChoice {
  /** The made-up state the page is showing. */
  scenario: SignalScenario;
  /** The one after it, round and round. */
  next: SignalScenario | undefined;
  choose: (key: string) => void;
}

/** The prototype's state, kept in the page's address as `?state=`, so a state can be linked to and survives a reload. */
export function useScenario(): ScenarioChoice {
  const [key, setKey] = useQueryState('state', parser);
  const index = Math.max(
    0,
    SCENARIOS.findIndex(each => each.key === key)
  );
  const scenario = SCENARIOS[index];
  if (scenario === undefined) throw new Error('There are no scenarios.');
  return { scenario, next: SCENARIOS[(index + 1) % SCENARIOS.length], choose: next => void setKey(next) };
}
