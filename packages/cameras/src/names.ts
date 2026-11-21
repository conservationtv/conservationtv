// What a camera is called in chat: its name, or any of its aliases, compared without case, spaces or punctuation, so
// `!ptzhome pondcam` finds "Pond Cam". Chat arguments are split on spaces, so a name is matched as one word.

/** The longest alias, and the most a camera has. */
export const MAX_ALIAS_LENGTH = 60;
export const MAX_ALIASES = 16;

/** A name as it is compared: lowercase letters and digits only. Empty for a name with neither. */
export function chatName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}
