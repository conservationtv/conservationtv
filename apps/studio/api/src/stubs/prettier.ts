// Bundled in place of `prettier/standalone` and `prettier/plugins/html` (see vite.config.ts), which React Email's
// `render` imports only to format HTML when asked to (`pretty`). The emails (src/email/mailer.ts) are never formatted.

export const format = (): never => {
  throw new Error('Prettier is not bundled in the studio API Worker');
};

export default { format };
