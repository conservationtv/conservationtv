import type { FC, ReactNode } from 'react';
import { Button, Column, Heading, Link, Row, Section, Text } from 'react-email';

export interface EmailHeadingProps {
  children: ReactNode;
}

/** The email's one heading, at the top of the message. */
export const EmailHeading: FC<EmailHeadingProps> = ({ children }) => {
  return (
    <Heading
      as="h1"
      className="m-0 mb-4 text-[24px] leading-[30px] font-semibold tracking-tight text-foreground dark:text-dark-foreground"
    >
      {children}
    </Heading>
  );
};

export interface EmailTextProps {
  children: ReactNode;
}

/** A paragraph of the message. */
export const EmailText: FC<EmailTextProps> = ({ children }) => {
  return (
    <Text className="m-0 mb-4 text-custom-15 leading-[24px] text-foreground dark:text-dark-foreground">{children}</Text>
  );
};

/** A quieter paragraph: what to do if the email wasn't expected, how long something lasts. */
export const EmailNote: FC<EmailTextProps> = ({ children }) => {
  return (
    <Text className="m-0 mt-4 text-custom-13 leading-[20px] text-muted-foreground dark:text-dark-muted-foreground">
      {children}
    </Text>
  );
};

export interface EmailButtonProps {
  href: string;
  children: ReactNode;
}

/** The email's main action. */
export const EmailButton: FC<EmailButtonProps> = ({ href, children }) => {
  return (
    <Section className="mt-6 mb-4">
      <Button
        href={href}
        className="rounded-lg bg-primary dark:bg-dark-primary px-5 py-3 text-custom-15 leading-[20px] font-medium text-primary-foreground dark:text-dark-primary-foreground"
      >
        {children}
      </Button>
    </Section>
  );
};

export interface EmailLinkProps {
  href: string;
  children: ReactNode;
}

/** An inline link in the message's text. */
export const EmailLink: FC<EmailLinkProps> = ({ href, children }) => {
  return (
    <Link href={href} className="text-foreground dark:text-dark-foreground underline">
      {children}
    </Link>
  );
};

export interface EmailFallbackLinkProps {
  href: string;
}

/** The main action's address written out, for clients that don't show the button. */
export const EmailFallbackLink: FC<EmailFallbackLinkProps> = ({ href }) => {
  return (
    <Text className="m-0 text-custom-13 leading-[20px] break-all text-muted-foreground dark:text-dark-muted-foreground">
      Or paste this link into your browser:{' '}
      <Link href={href} className="text-secondary-foreground dark:text-dark-secondary-foreground underline">
        {href}
      </Link>
    </Text>
  );
};

export interface EmailCodeProps {
  /** The code, as the person types it. */
  children: string;
}

/** A one-time code, large and spaced out so it reads at a glance. */
export const EmailCode: FC<EmailCodeProps> = ({ children }) => {
  return (
    <Section className="my-6 rounded-xl border border-solid border-border dark:border-dark-border bg-muted dark:bg-dark-muted py-5 text-center">
      {/* Letter spacing also follows the last digit, so the same space before the first keeps the code centred. */}
      <Text className="m-0 pl-[10px] text-[34px] leading-[40px] font-semibold tracking-[10px] text-foreground dark:text-dark-foreground">
        {children}
      </Text>
    </Section>
  );
};

export interface EmailDetailsProps {
  /** EmailDetail rows. */
  children: ReactNode;
}

/** Facts about what happened, as label and value rows: the device, the place, the time. */
export const EmailDetails: FC<EmailDetailsProps> = ({ children }) => {
  return (
    <Section className="my-6 rounded-xl border border-solid border-border dark:border-dark-border px-5 py-2">
      {children}
    </Section>
  );
};

export interface EmailDetailProps {
  label: string;
  children: ReactNode;
}

export const EmailDetail: FC<EmailDetailProps> = ({ label, children }) => {
  return (
    <Row>
      <Column className="w-[38%] py-2 align-top">
        <Text className="m-0 text-custom-13 leading-[20px] text-muted-foreground dark:text-dark-muted-foreground">
          {label}
        </Text>
      </Column>
      <Column className="py-2 align-top">
        <Text className="m-0 text-custom-13 leading-[20px] font-medium text-foreground dark:text-dark-foreground">
          {children}
        </Text>
      </Column>
    </Row>
  );
};
