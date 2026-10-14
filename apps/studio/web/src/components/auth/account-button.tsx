import type { FC } from 'react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { Avatar, AvatarFallback } from '@conservationtv/ui/components/avatar';
import { Button } from '@conservationtv/ui/components/button';

export interface AccountButtonProps {
  email: string;
  /** How tapping signs in, under the email. */
  hint: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}

/**
 * One remembered account, as an account-picker row: an initial on the brand gradient, the email, and how tapping
 * signs in. Still an outline Button, so it shares its hover and loading behaviour.
 */
export const AccountButton: FC<AccountButtonProps> = ({ email, hint, loading, disabled, onClick }) => {
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className="group/account h-auto justify-start gap-3 py-2.5 pr-3 pl-2.5 text-left"
      loading={loading}
      disabled={disabled}
      onClick={onClick}
    >
      <Avatar className="size-8">
        <AvatarFallback className="bg-linear-to-br from-[#ffce51] via-[#ff715b] to-[#c43f98] text-sm font-semibold text-white">
          {email.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{email}</span>
        <span className="text-xs font-normal text-muted-foreground">{hint}</span>
      </span>
      <CaretRightIcon className="text-muted-foreground transition-transform group-hover/account:translate-x-0.5" />
    </Button>
  );
};
