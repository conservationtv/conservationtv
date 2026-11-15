import type { KeyboardEvent, MouseEvent } from 'react';

/** How anything pressable on the signal view looks while it waits to be pressed, and under the keyboard's focus. */
export const PRESSABLE =
  'cursor-pointer outline-none transition-[opacity,background-color,border-color] duration-200 focus-visible:ring-2 focus-visible:ring-ring';

export interface PressableProps {
  role: 'button';
  tabIndex: 0;
  onClick: (event: MouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

/** Makes a non-button pressable by pointer and keyboard, without its press reaching what's behind it. */
export function pressable(onPress: () => void): PressableProps {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: event => {
      event.stopPropagation();
      onPress();
    },
    onKeyDown: event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      onPress();
    }
  };
}
