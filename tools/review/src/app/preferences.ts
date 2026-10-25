import { useState } from 'react';

// How the reviewer likes the review laid out, kept in this browser across pull requests.

/** A switch kept under `key`, starting as `initial` until the reviewer flips it. */
export function useSwitch(key: string, initial: boolean): [boolean, () => void] {
  const stored = localStorage.getItem(`review:${key}`);
  const [on, setOn] = useState(stored === null ? initial : stored === 'true');
  const flip = () => {
    localStorage.setItem(`review:${key}`, String(!on));
    setOn(!on);
  };
  return [on, flip];
}
