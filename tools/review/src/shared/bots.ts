import type { ConversationEntry, Thread } from './review.ts';

/**
 * The agents that review pull requests here, by GitHub login. Their reviews come on every push, so they are read for
 * their verdict and what is still open rather than in full.
 */
export const reviewBots = new Map([['pullfrog[bot]', 'Pullfrog']]);

export function isReviewBot(login: string): boolean {
  return reviewBots.has(login);
}

/** How a bot's review comes out: nothing to fix, notes worth reading, or something to fix first. */
export type VerdictTone = 'clean' | 'notes' | 'attention';

export interface Verdict {
  tone: VerdictTone;
  /** Its opening line, without the marker. */
  summary: string;
}

/** GitHub's alert markers: the ones that ask for something to be done before merging, and the rest. */
const ATTENTION = /^\[!(IMPORTANT|WARNING|CAUTION)\]\s*/i;
const NOTE = /^\[!(NOTE|TIP)\]\s*/i;

/**
 * A bot review's verdict: the blockquote it opens with (`> ✅ No new issues found.`, `> ℹ️ …`, or a GitHub alert such
 * as `> [!IMPORTANT]`). Null when the review doesn't open with one, such as one carrying only line comments.
 */
export function verdictOf(body: string): Verdict | null {
  const lines = body.trimStart().split('\n');
  const quoted: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('>')) break;
    quoted.push(line.replace(/^>\s?/, ''));
  }
  const text = quoted.join(' ').trim();
  if (!text) return null;
  if (ATTENTION.test(text)) return { tone: 'attention', summary: text.replace(ATTENTION, '') };
  if (NOTE.test(text)) return { tone: 'notes', summary: text.replace(NOTE, '') };
  if (text.startsWith('✅')) return { tone: 'clean', summary: text.replace(/^✅\s*/, '') };
  return { tone: 'notes', summary: text.replace(/^ℹ️\s*/, '') };
}

/** A review bot's review of one commit, with the line threads it opened. */
export interface BotReview {
  entry: ConversationEntry;
  verdict: Verdict | null;
  threads: Thread[];
}

/** What one review bot has said on a pull request: each review, oldest first, and every thread it opened. */
export interface BotReport {
  login: string;
  name: string;
  reviews: BotReview[];
  threads: Thread[];
}

/** Each review bot that has reviewed the pull request, with its reviews and threads. */
export function botReports(conversation: readonly ConversationEntry[], threads: readonly Thread[]): BotReport[] {
  return [...reviewBots].flatMap(([login, name]): BotReport[] => {
    const own = threads.filter(thread => thread.comments[0]?.author.login === login);
    const reviews = conversation
      .filter(entry => entry.review !== null && entry.author.login === login)
      .map(entry => ({
        entry,
        verdict: verdictOf(entry.body),
        threads: own.filter(thread => thread.reviewId === entry.id)
      }));
    return reviews.length || own.length ? [{ login, name, reviews, threads: own }] : [];
  });
}

/** `suggestion` blocks in a comment: what a reviewer offers to put in place of the lines it is on. */
export function hasSuggestion(body: string): boolean {
  return /^```suggestion\b/m.test(body);
}
