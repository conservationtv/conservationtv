import type { FC } from 'react';
import { BetterFetchError } from '@better-fetch/fetch';
import { FieldError } from '@conservationtv/ui/components/field';
import { z } from 'zod';

// Better Auth's error bodies: its own `{ message }`, or OAuth's `{ error_description }` from the device flow.
const AuthErrorBodySchema = z.object({ message: z.string().optional(), error_description: z.string().optional() });
type AuthErrorBody = z.output<typeof AuthErrorBodySchema>;

export interface FormErrorProps {
  error: Error | null;
}

/** A failed mutation or query, as a shadcn field error with the server's description where it gave one. */
export const FormError: FC<FormErrorProps> = ({ error }) => {
  if (!error) return null;
  return <FieldError>{describe(error)}</FieldError>;
};

/** The SDK's errors already carry the server's description as their message; Better Auth's carry it in the body. */
function describe(error: Error): string {
  if (!(error instanceof BetterFetchError)) return error.message;
  const body: AuthErrorBody = AuthErrorBodySchema.catch({}).parse(error.error);
  return body.error_description ?? body.message ?? error.message;
}
