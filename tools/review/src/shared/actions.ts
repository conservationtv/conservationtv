import { z } from 'zod';

// What a signed-in reviewer asks the Worker to do on GitHub, as themselves, and who they are signed in as.

export const ViewerSchema = z.object({ login: z.string(), avatarUrl: z.url() });
export type Viewer = z.output<typeof ViewerSchema>;

export const SessionSchema = z.object({
  /** False until the Worker has a GitHub OAuth app to sign in with: then this tool only reads. */
  enabled: z.boolean(),
  viewer: ViewerSchema.nullable()
});
export type Session = z.output<typeof SessionSchema>;

export const MergeMethodSchema = z.enum(['merge', 'squash', 'rebase']);
export type MergeMethod = z.output<typeof MergeMethodSchema>;

export const MergeRequestSchema = z.object({
  method: MergeMethodSchema,
  /** The head commit the reviewer saw: GitHub refuses the merge if the branch has moved since. */
  sha: z.string()
});
export type MergeRequest = z.output<typeof MergeRequestSchema>;

export const CommentRequestSchema = z.object({ body: z.string().trim().min(1) });
export type CommentRequest = z.output<typeof CommentRequestSchema>;

export const LineSideSchema = z.enum(['additions', 'deletions']);
export type LineSide = z.output<typeof LineSideSchema>;

/** A comment on a line of a file's diff, or on a range of lines ending at it. */
export const LineCommentSchema = z.object({
  path: z.string(),
  body: z.string().trim().min(1),
  side: LineSideSchema,
  line: z.int().positive(),
  /** Where a range starts; null for a single line. */
  start: z.object({ side: LineSideSchema, line: z.int().positive() }).nullable()
});
export type LineComment = z.output<typeof LineCommentSchema>;

/** A line comment sent on its own, outside a review. */
export const LineCommentRequestSchema = LineCommentSchema.extend({ commitId: z.string() });
export type LineCommentRequest = z.output<typeof LineCommentRequestSchema>;

export const ReviewEventSchema = z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
export type ReviewEvent = z.output<typeof ReviewEventSchema>;

export const ReviewRequestSchema = z.object({
  event: ReviewEventSchema,
  body: z.string(),
  /** The head commit the comments' lines are on. */
  commitId: z.string(),
  comments: z.array(LineCommentSchema)
});
export type ReviewRequest = z.output<typeof ReviewRequestSchema>;
