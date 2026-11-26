import { Component, type FC, type ReactNode } from 'react';
import { useQueryErrorResetBoundary } from '@tanstack/react-query';

/** How long a quiet part stays away after its first read fails, before it reads again. */
const RETRY_MS = 10_000;

export interface QuietBoundaryProps {
  children: ReactNode;
}

/**
 * Around a part a page can go without for a while (a hint, a prompt): when a read it suspends on fails before it has
 * any answer, the part renders nothing and reads again shortly, rather than the failure reaching the route's error
 * screen and taking the rest of the page (a capture being sent, a show being run) with it.
 */
export const QuietBoundary: FC<QuietBoundaryProps> = ({ children }) => {
  const { reset } = useQueryErrorResetBoundary();
  return <QuietCatch onRetry={reset}>{children}</QuietCatch>;
};

interface QuietCatchProps {
  children: ReactNode;
  onRetry: () => void;
}

interface QuietCatchState {
  failed: boolean;
}

/** React catches a render's failure only in a class component's lifecycle. */
class QuietCatch extends Component<QuietCatchProps, QuietCatchState> {
  override state: QuietCatchState = { failed: false };
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;

  static getDerivedStateFromError(): QuietCatchState {
    return { failed: true };
  }

  override componentDidCatch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // The failed queries are cleared to read again as the part renders, rather than throwing their error at once.
      this.props.onRetry();
      this.setState({ failed: false });
    }, RETRY_MS);
  }

  override componentWillUnmount() {
    clearTimeout(this.timer);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
