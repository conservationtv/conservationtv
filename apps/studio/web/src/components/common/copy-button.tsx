import { useState, type FC } from 'react';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';

/** How long the tick shows after copying. */
const COPIED_MS = 1_500;

export interface CopyButtonProps {
  /** What goes on the clipboard. */
  value: string;
  /** What is being copied, for assistive technology: "Copy public ID". */
  label: string;
}

/** A small icon button that copies a value, showing a tick for a moment once it has. */
export const CopyButton: FC<CopyButtonProps> = ({ value, label }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
};
