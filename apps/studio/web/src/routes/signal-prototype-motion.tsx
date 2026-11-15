import type { FC } from 'react';

import { SignalEditForms } from '@/components/signal/editing/signal-edit-forms';
import { SignalEditSurface } from '@/components/signal/editing/signal-edit-surface';
import { SignalEditing, SignalEditToggle } from '@/components/signal/editing/signal-editing';
import { useSignalEditing } from '@/components/signal/editing/signal-editing-store';
import {
  Signal,
  SignalAttention,
  SignalCanvas,
  SignalHeader,
  SignalHeaderText,
  SignalHint,
  SignalTitle
} from '@/components/signal/signal';
import { useSignalLayout } from '@/components/signal/signal-context';
import { SignalMapView } from '@/components/signal/signal-map-view';
import { OPEN_AT_FIRST } from '@/components/signal/signal-samples';
import { ScenarioNote, ScenarioPicker } from '@/components/signal/signal-scenario-picker';
import { useScenario } from '@/components/signal/signal-scenarios';
import { SignalStackView } from '@/components/signal/signal-stack-view';

// The signal view as one working page, on made-up data, with its motion: the map wide, the stack narrow, its state
// switchable. The view only shows; editing is a layer composed on top of it here (<SignalEditing>, its toggle, and
// the surface its forms show in), and the page reads the same with all three taken out. Nothing saves.

/** The map where there's room for it, the stack where there isn't. */
const View: FC = () => {
  const layout = useSignalLayout();
  return layout === 'map' ? <SignalMapView /> : <SignalStackView />;
};

/** What a press does, as things stand. */
const Hint: FC = () => {
  const editing = useSignalEditing();
  const layout = useSignalLayout();
  const adds = layout === 'map' ? 'the dashed rows' : 'each list’s Add';
  return (
    <SignalHint>
      {editing
        ? `Press anything to edit it; ${adds} adds one. Nothing saves.`
        : 'Press anything to follow its path; press a network, or a group in it, to open it, one at a time. Made-up data.'}
    </SignalHint>
  );
};

const SignalPrototypeMotion: FC = () => {
  const { scenario } = useScenario();
  return (
    <Signal system={scenario.system} defaultOpen={OPEN_AT_FIRST}>
      <SignalEditing>
        <main className="flex min-h-svh flex-col bg-background">
          <SignalHeader>
            <SignalHeaderText>
              <SignalTitle>
                Signal
                <SignalAttention />
              </SignalTitle>
              <ScenarioNote />
            </SignalHeaderText>
            <div className="mr-auto sm:mr-0">
              <ScenarioPicker />
            </div>
            <SignalEditToggle />
          </SignalHeader>
          <SignalCanvas>
            <View />
            <Hint />
          </SignalCanvas>
          <SignalEditSurface>
            <SignalEditForms />
          </SignalEditSurface>
        </main>
      </SignalEditing>
    </Signal>
  );
};

export default SignalPrototypeMotion;
