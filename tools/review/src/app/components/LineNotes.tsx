import { useQueryClient } from '@tanstack/react-query';
import type { FC } from 'react';
import type { Pull } from '../../shared/review.ts';
import { refreshReview, send } from '../api.ts';
import type { Drafts } from '../drafts.ts';
import type { LineTarget, Note } from '../notes.ts';
import { MarkdownBody } from './common.tsx';
import { Composer } from './Composer.tsx';
import { ThreadView } from './ThreadView.tsx';

interface LineComposerProps {
  pull: Pull;
  target: LineTarget;
  drafts: Drafts;
  /** What was written before the composer last scrolled out of view, and where each edit goes. */
  written: string;
  onWrite(body: string): void;
  onClose(): void;
}

/** A comment being written on a line or a range: added to the pending review, or sent on its own straight away. */
const LineComposer: FC<LineComposerProps> = ({ pull, target, drafts, written, onWrite, onClose }) => {
  const queryClient = useQueryClient();
  const { comment } = target;
  if (!comment) {
    return (
      <div className="line-note line-note-blocked">
        <p className="small">
          GitHub only takes comments on lines its own diff shows: these are context opened beyond it, or the whole file
          GitHub did not inline.
        </p>
        <button type="button" className="link-button small" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }
  const lines = comment.start ? `lines ${comment.start.line}–${comment.line}` : `line ${comment.line}`;
  return (
    <div className="line-note">
      <p className="muted small">
        Commenting on {lines} {comment.side === 'deletions' ? 'before' : 'after'} the change
      </p>
      <Composer
        placeholder="Leave a comment (Markdown)"
        autoFocus
        initial={written}
        onChange={onWrite}
        onCancel={onClose}
        actions={[
          {
            label: 'Comment now',
            run: async body => {
              await send(`/api/pulls/${pull.number}/line-comments`, { ...comment, body, commitId: pull.headSha });
              await refreshReview(queryClient, pull.number);
              onClose();
            }
          },
          {
            label: 'Add to review',
            primary: true,
            run: body => {
              drafts.add({ ...comment, body });
              onClose();
            }
          }
        ]}
      />
    </div>
  );
};

interface NoteViewProps {
  pull: Pull;
  note: Note;
  drafts: Drafts;
  written: string;
  onWrite(body: string): void;
  onCloseComposer(): void;
}

/** A thread, a comment waiting for its review to be submitted, or the comment being written. */
export const NoteView: FC<NoteViewProps> = ({ pull, note, drafts, written, onWrite, onCloseComposer }) => {
  if (note.kind === 'thread') return <ThreadView number={pull.number} thread={note.thread} />;
  if (note.kind === 'composer') {
    return (
      <LineComposer
        pull={pull}
        target={note.target}
        drafts={drafts}
        written={written}
        onWrite={onWrite}
        onClose={onCloseComposer}
      />
    );
  }
  const { draft } = note;
  return (
    <div className="line-note line-note-draft">
      <header>
        <span className="pending-badge">Pending</span>
        <span className="muted small">
          {draft.start ? `Lines ${draft.start.line}–${draft.line}` : `Line ${draft.line}`}
        </span>
        <button type="button" className="link-button small" onClick={() => drafts.remove(draft.id)}>
          Delete
        </button>
      </header>
      <MarkdownBody text={draft.body} />
    </div>
  );
};
