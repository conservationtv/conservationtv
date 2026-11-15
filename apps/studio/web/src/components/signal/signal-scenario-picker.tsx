import type { FC } from 'react';
import { motion } from 'motion/react';
import { ArrowRightIcon, CaretDownIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@conservationtv/ui/components/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';

import { Swap } from '@/components/signal/signal-presence';
import { SCENARIOS } from '@/components/signal/signal-samples';
import { useScenario } from '@/components/signal/signal-scenarios';

// The prototype's own controls: which made-up state the system underneath is in.

/** What the state in hand is, in a line; it swaps as the state changes. */
export const ScenarioNote: FC = () => {
  const { scenario } = useScenario();
  return (
    <Swap id={scenario.key} className="text-custom-12 text-muted-foreground">
      <span className="sm:truncate">{scenario.note}</span>
    </Swap>
  );
};

/** Pick a state for the system underneath; a button beside it steps to the next. */
export const ScenarioPicker: FC = () => {
  const { scenario, next, choose } = useScenario();
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="max-w-56 justify-between sm:max-w-none" />}
        >
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-muted-foreground">State:</span>
            <Swap id={scenario.key} className="truncate">
              {scenario.label}
            </Swap>
          </span>
          <CaretDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel>The system underneath</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={scenario.key} onValueChange={value => choose(String(value))}>
              {SCENARIOS.map(each => (
                <DropdownMenuRadioItem key={each.key} value={each.key} className="items-start">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{each.label}</span>
                    <span className="text-muted-foreground">{each.note}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {next && (
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={`Next state: ${next.label}`} />}
            onClick={() => choose(next.key)}
          >
            {/* A nudge forward each time it steps on. */}
            <motion.span
              key={scenario.key}
              className="flex"
              initial={{ x: -5, opacity: 0.3 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.4 }}
            >
              <ArrowRightIcon />
            </motion.span>
          </TooltipTrigger>
          <TooltipContent>Next: {next.label}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
