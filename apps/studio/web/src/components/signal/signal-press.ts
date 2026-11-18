import type { KeyboardEvent, KeyboardEventHandler, MouseEvent, MouseEventHandler } from 'react';

/** How anything pressable on the signal view looks while it waits to be pressed, and under the keyboard's focus. */
export const PRESSABLE =
  'cursor-pointer outline-none transition-[opacity,background-color,border-color] duration-200 focus-visible:ring-2 focus-visible:ring-ring';

export interface PressableProps {
  role?: 'button';
  tabIndex?: 0;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

/**
 * A non-button's own `onClick` and `onKeyDown`, made pressable while it has a click to do: a press reaches the click
 * by pointer, and by Enter or Space, and doesn't reach what's behind it (the canvas, which lets go of the pick). With
 * no click, they're as they were. A button, unless the element is given a role of its own.
 */
export function pressable(
  onClick: MouseEventHandler<HTMLDivElement> | undefined,
  onKeyDown: KeyboardEventHandler<HTMLDivElement> | undefined
): PressableProps {
  if (!onClick) return { onKeyDown };
  return {
    role: 'button',
    tabIndex: 0,
    onClick: (event: MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      onClick(event);
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || (event.key !== 'Enter' && event.key !== ' ')) return;
      // Only its own keys: one on something inside it (a "more" button) is that thing's.
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      event.currentTarget.click();
    }
  };
}
