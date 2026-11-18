import type { ReactElement } from 'react';
import { render } from 'react-email';

import { EmailAssets } from './components/assets.tsx';

export interface RenderedEmail {
  html: string;
  /** The same message as plain text, for the multipart alternative. */
  text: string;
}

/**
 * Renders an email for sending: its HTML with styles inlined, and a plain-text version. `assetsUrl` is the public URL
 * src/emails/static is served under, since email clients only load images by absolute URL.
 */
export async function renderEmail(email: ReactElement, assetsUrl: string): Promise<RenderedEmail> {
  const element = <EmailAssets url={assetsUrl}>{email}</EmailAssets>;
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}
