import { useQueryClient } from '@tanstack/react-query';
import { useState, type FC } from 'react';
import type { ReviewEvent } from '../../shared/actions.ts';
import type { Review } from '../../shared/review.ts';
import { refreshReview, send } from '../api.ts';
import type { Drafts } from '../drafts.ts';
import { useSession } from '../session.ts';
import { Composer, type ComposerAction } from './Composer.tsx';

interface ReviewSubmitProps {
  review: Review;
  drafts: Drafts;
}

/**
 * The pending review: its line comments counted on the button, sent with a summary as a comment, an approval or a
 * request for changes. GitHub lets no one approve or request changes on their own pull request.
 */
export const ReviewSubmit: FC<ReviewSubmitProps> = ({ review, drafts }) => {
  const session = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const viewer = session?.viewer;
  if (!viewer || review.pull.state !== 'open') return null;
  const { pull } = review;
  const own = viewer.login === pull.author.login;
  const count = drafts.all.length;

  const submit = (event: ReviewEvent) => async (body: string) => {
    const comments = drafts.all.map(({ id: _id, ...comment }) => comment);
    await send(`/api/pulls/${pull.number}/reviews`, { event, body, commitId: pull.headSha, comments });
    drafts.clear();
    setOpen(false);
    await refreshReview(queryClient, pull.number);
  };
  // A comment needs something to say: a summary or a line comment.
  const comment: ComposerAction = { label: 'Comment', primary: true, allowsEmpty: count > 0, run: submit('COMMENT') };
  const verdicts: ComposerAction[] = [
    { label: 'Request changes', run: submit('REQUEST_CHANGES') },
    { label: 'Approve', allowsEmpty: true, run: submit('APPROVE') }
  ];
  const actions = own ? [comment] : [comment, ...verdicts];

  return (
    <div className="review-submit">
      <button type="button" className="button small-button primary" onClick={() => setOpen(current => !current)}>
        Finish review{count ? <span className="count">{count}</span> : null}
      </button>
      {open ? (
        <div className="review-panel" role="dialog" aria-label="Finish review">
          <p className="small muted">
            {count
              ? `${count} line comment${count === 1 ? '' : 's'} will be sent with this review.`
              : 'No line comments yet: use the + beside a line to add one.'}
            {own ? ' As this is your own pull request, GitHub only takes comments.' : null}
          </p>
          <Composer placeholder="Summary (Markdown)" autoFocus onCancel={() => setOpen(false)} actions={actions} />
        </div>
      ) : null}
    </div>
  );
};
