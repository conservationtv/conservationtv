import type { FC, ReactNode } from 'react';
import {
  Body,
  Column,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
  pixelBasedPreset
} from 'react-email';

import { uiTheme } from '../generated/ui-theme.ts';
import { useAsset } from './assets.tsx';

export interface EmailLayoutProps {
  /** The line inboxes show after the subject. */
  preview: string;
  children: ReactNode;
}

/**
 * An email's page: a plain letter in a narrow column, styled by @conservationtv/ui's theme. Figtree loads where the
 * client allows web fonts; elsewhere the theme's sans-serif fallback stands in.
 *
 * The email declares both colour schemes, so clients that support `prefers-color-scheme` (Apple Mail, Outlook for
 * Mac, Thunderbird) show the parts' `dark:` colours instead of inverting the light ones themselves. The page's light
 * background is the clients' own white: React Email copies a Body's inline styles onto a table cell that its dark
 * class doesn't reach, so the Body only carries the dark background.
 */
export const EmailLayout: FC<EmailLayoutProps> = ({ preview, children }) => {
  return (
    <Html lang="en">
      {/* Tailwind wraps the Head so it can place the dark-mode media queries there. */}
      <Tailwind theme={uiTheme} config={pixelBasedPreset}>
        <Head>
          <meta name="color-scheme" content="light dark" />
          <meta name="supported-color-schemes" content="light dark" />
          <style>{':root { color-scheme: light dark; supported-color-schemes: light dark; }'}</style>
          <link
            href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap"
            rel="stylesheet"
          />
        </Head>
        <Preview>{preview}</Preview>
        <Body className="m-0 font-sans dark:bg-dark-background">
          <Container className="mx-auto max-w-[520px] px-6 py-12">{children}</Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

/** The conservation.tv mark and wordmark, side by side at the top of the letter. */
export const EmailHeader: FC = () => {
  const logo = useAsset('logo.png');
  return (
    <Section className="pb-8">
      <Row>
        <Column className="w-[64px] align-middle">
          <Img src={logo} alt="" width={55} height={19} />
        </Column>
        <Column className="align-middle">
          <Text className="m-0 text-custom-17 leading-[20px] font-semibold tracking-tight text-foreground dark:text-dark-foreground">
            conservation.tv
          </Text>
        </Column>
      </Row>
    </Section>
  );
};

export interface EmailMessageProps {
  children: ReactNode;
}

/** The message itself, under the header. */
export const EmailMessage: FC<EmailMessageProps> = ({ children }) => {
  return <Section>{children}</Section>;
};

export interface EmailFooterProps {
  /** Why this person received the email. */
  children: ReactNode;
}

/** Small print under a hairline: why the email was sent. */
export const EmailFooter: FC<EmailFooterProps> = ({ children }) => {
  return (
    <Section>
      <Hr className="my-8 border-0 border-t border-solid border-border dark:border-dark-border" />
      <Text className="m-0 text-custom-12 leading-[18px] text-muted-foreground dark:text-dark-muted-foreground">
        {children}
      </Text>
    </Section>
  );
};
