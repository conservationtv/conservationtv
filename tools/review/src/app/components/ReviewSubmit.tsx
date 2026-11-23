import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@conservationtv/ui/components/popover';
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" className="shrink-0" />}>
        Finish review
        {count ? (
          <Badge variant="secondary" className="h-4 min-w-4 px-1">
            {count}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(28rem,calc(100vw-1.5rem))] gap-2 p-3" aria-label="Finish review">
        <p className="text-xs text-muted-foreground">
          {count
            ? `${count} line comment${count === 1 ? '' : 's'} will be sent with this review.`
            : 'No line comments yet: use the + beside a line to add one.'}
          {own ? ' As this is your own pull request, GitHub only takes comments.' : null}
        </p>
        <Composer placeholder="Summary (Markdown)" autoFocus onCancel={() => setOpen(false)} actions={actions} />
      </PopoverContent>
    </Popover>
  );
};
