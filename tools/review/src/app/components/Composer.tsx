import { useState, type FC, type KeyboardEvent } from 'react';

export interface ComposerAction {
  label: string;
  /** The first primary action is also what ⌘↵ does. */
  primary?: boolean;
  /** Whether it can go with nothing written, such as an approval. */
  allowsEmpty?: boolean;
  run(body: string): Promise<void> | void;
}

interface ComposerProps {
  placeholder: string;
  actions: readonly ComposerAction[];
  onCancel?(): void;
  autoFocus?: boolean;
  /** What was being written before, and each edit as it is made: for a caller that keeps it across remounts. */
  initial?: string;
  onChange?(body: string): void;
}

/** A Markdown box and the buttons that send it, each saying when it is sending or why it failed. */
export const Composer: FC<ComposerProps> = ({ placeholder, actions, onCancel, autoFocus, initial, onChange }) => {
  const [body, setBody] = useState(initial ?? '');
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: ComposerAction) {
    setSending(action.label);
    setError(null);
    try {
      await action.run(body.trim());
      setBody('');
      onChange?.('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not go through.');
    } finally {
      setSending(null);
    }
  }

  const empty = !body.trim();
  // An action goes only with something written, unless it can go without.
  const ready = (action: ComposerAction) => sending === null && (!empty || Boolean(action.allowsEmpty));
  const primary = actions.find(action => action.primary);
  // ⌘↵ or Ctrl↵ sends with the primary action when it can go; Escape cancels.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const submitting = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
    if (submitting && primary && ready(primary)) {
      event.preventDefault();
      void run(primary);
    }
    if (event.key === 'Escape') onCancel?.();
  }

  return (
    <div className="composer">
      <textarea
        value={body}
        placeholder={placeholder}
        rows={3}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by the reviewer to write in straight away.
        autoFocus={autoFocus}
        disabled={sending !== null}
        onChange={event => {
          setBody(event.target.value);
          onChange?.(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {error ? <p className="error-text small">{error}</p> : null}
      <div className="composer-actions">
        {onCancel ? (
          <button type="button" className="button" onClick={onCancel} disabled={sending !== null}>
            Cancel
          </button>
        ) : null}
        {actions.map(action => (
          <button
            key={action.label}
            type="button"
            className={action.primary ? 'button primary' : 'button'}
            disabled={!ready(action)}
            onClick={() => void run(action)}
          >
            {sending === action.label ? 'Sending…' : action.label}
          </button>
        ))}
      </div>
    </div>
  );
};
