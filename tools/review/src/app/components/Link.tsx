import type { AnchorHTMLAttributes, FC, MouseEvent } from 'react';
import { navigate } from '../router.ts';

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

/** An in-app link: an ordinary anchor, so a modified or middle click still opens a new tab. */
export const Link: FC<LinkProps> = ({ to, onClick, ...props }) => {
  // Leave the browser to it when the caller handled the click or a modifier asks for a new tab or window.
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
    if (event.defaultPrevented || modified) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={follow} {...props} />;
};
