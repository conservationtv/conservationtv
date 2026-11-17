import { createContext, use, type FC, type ReactNode } from 'react';

/**
 * Where the emails' images are served from. Email clients load images by absolute URL, so a sender gives the public
 * origin they are hosted at (see renderEmail); the default is the preview server's own static folder.
 */
const AssetsContext = createContext('/static');

export interface EmailAssetsProps {
  /** The URL the files in src/emails/static are served under, without a trailing slash. */
  url: string;
  children: ReactNode;
}

export const EmailAssets: FC<EmailAssetsProps> = ({ url, children }) => {
  return <AssetsContext value={url}>{children}</AssetsContext>;
};

/** The URL of a file in src/emails/static. */
export function useAsset(file: string): string {
  const base = use(AssetsContext);
  return `${base}/${file}`;
}
