import type { ReactElement } from 'react';
import type { Variables } from '../env/config.ts';

export interface Mailbox {
  name: string;
  email: string;
}

/** The name the studio's emails are from, beside `MAIL_FROM`, the address the `MAIL` binding may send as. */
const SENDER_NAME = 'conservation.tv';

/** Where the emails' images are served from, under the API's own URL (`pnpm bundle:email`, src/app.ts). */
export const EMAIL_ASSETS_PATH = '/email/';

/** A composed message, as Cloudflare Email Sending's `send` takes one. */
export interface OutgoingMail {
  from: Mailbox;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SentMail {
  messageId: string;
}

/** The `MAIL` binding as the mailer uses it. */
export interface MailBinding {
  send(message: OutgoingMail): Promise<SentMail>;
}

/** What local development logs in a letter's place: its event, and what someone needs to act on it, such as a code. */
export interface LetterLog extends Record<string, string> {
  event: string;
}

export interface Letter {
  to: string;
  subject: string;
  /**
   * The email, built only when it is sent: the templates (and React Email's renderer behind them) are imported
   * lazily, so a cold start that sends nothing never evaluates them.
   */
  body: () => Promise<ReactElement>;
  log: LetterLog;
}
export type Mailer = (letter: Letter) => Promise<void>;

/**
 * How the studio's emails reach people, by `EMAIL_DELIVERY`. `log` writes each letter's `log` fields to the Worker's
 * log instead, for local development. `send` renders it and sends it through the `MAIL` binding, as deployments do;
 * locally that binding is the real one (`dev.remote`, cloudflare.config.ts), so `EMAIL_DELIVERY=send pnpm dev` sends
 * real email.
 */
export function mailer(variables: Variables, binding: MailBinding): Mailer {
  const mode = variables.EMAIL_DELIVERY;
  switch (mode) {
    case 'log':
      return async ({ to, log }) => {
        console.info(JSON.stringify({ ...log, email: to }));
      };
    case 'send': {
      const from: Mailbox = { name: SENDER_NAME, email: variables.MAIL_FROM };
      const assetsUrl = new URL(EMAIL_ASSETS_PATH, variables.APP_URL).href.replace(/\/$/u, '');
      return async ({ to, subject, body, log }) => {
        const [{ renderEmail }, element] = await Promise.all([import('@conservationtv/email'), body()]);
        const { html, text } = await renderEmail(element, assetsUrl);
        const { messageId } = await binding.send({ from, to, subject, html, text });
        // Which email went, never its contents: the log would otherwise carry codes and links.
        console.info(JSON.stringify({ event: 'email_sent', email: log.event, messageId }));
      };
    }
  }
}
