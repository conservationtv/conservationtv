import { useState } from 'react';

/** How long a button says "Copied" after copying. */
const COPIED_MS = 1_600;

/** Copies text, and says so for a moment: `copied` is true until it has been shown long enough. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };
  return { copied, copy };
}
