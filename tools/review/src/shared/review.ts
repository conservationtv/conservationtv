import { z } from 'zod';

// What the Worker serves the app. The Worker builds these from GitHub's public data; the app parses them back.

export const CategorySchema = z.enum(['source', 'migration', 'contract', 'generated', 'lockfile']);
export type Category = z.output<typeof CategorySchema>;

export const PersonSchema = z.object({ login: z.string(), avatarUrl: z.url(), url: z.url() });
export type Person = z.output<typeof PersonSchema>;

export const FileStatusSchema = z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);
export type FileStatus = z.output<typeof FileStatusSchema>;

export const ReviewFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: FileStatusSchema,
  /** The file's blob at the head commit; a file marked viewed stays viewed until this changes. */
  blob: z.string(),
  additions: z.int(),
  deletions: z.int(),
  /** GitHub's hunks without the file header; null for binary files and diffs too large for GitHub to inline. */
  patch: z.string().nullable(),
  category: CategorySchema,
  /** What writes the file, for anything but source code. */
  generator: z.string().nullable()
});
export type ReviewFile = z.output<typeof ReviewFileSchema>;

export const CheckStateSchema = z.enum(['success', 'failure', 'pending', 'neutral', 'skipped']);
export type CheckState = z.output<typeof CheckStateSchema>;

export const CheckSchema = z.object({
  name: z.string(),
  /** `signoff` for `gh signoff`'s commit statuses, `status` for other commit statuses, `run` for Actions check runs. */
  kind: z.enum(['signoff', 'status', 'run']),
  state: CheckStateSchema,
  description: z.string().nullable(),
  url: z.url().nullable()
});
export type Check = z.output<typeof CheckSchema>;

export const ReviewStateSchema = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']);
export type ReviewState = z.output<typeof ReviewStateSchema>;

export const ConversationEntrySchema = z.object({
  id: z.int(),
  author: PersonSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  url: z.url(),
  /** Set for reviews; plain comments have none. */
  review: ReviewStateSchema.nullable()
});
export type ConversationEntry = z.output<typeof ConversationEntrySchema>;

export const ThreadCommentSchema = z.object({
  id: z.int(),
  author: PersonSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  url: z.url()
});
export type ThreadComment = z.output<typeof ThreadCommentSchema>;

export const ThreadSchema = z.object({
  path: z.string(),
  /** The line the thread is on at the head commit: null when the code it was left on has since changed. */
  line: z.int().nullable(),
  side: z.enum(['additions', 'deletions']),
  comments: z.array(ThreadCommentSchema)
});
export type Thread = z.output<typeof ThreadSchema>;

export const PullStateSchema = z.enum(['open', 'draft', 'merged', 'closed']);
export type PullState = z.output<typeof PullStateSchema>;

export const PullSummarySchema = z.object({
  number: z.int(),
  title: z.string(),
  state: PullStateSchema,
  author: PersonSchema,
  baseRef: z.string(),
  headRef: z.string(),
  updatedAt: z.iso.datetime()
});
export type PullSummary = z.output<typeof PullSummarySchema>;

export const StackEntrySchema = PullSummarySchema.extend({
  /** 0 for the pull request based on the default branch; each pull request based on another's branch is one deeper. */
  depth: z.int()
});
export type StackEntry = z.output<typeof StackEntrySchema>;

export const ContractChangeSchema = z.object({
  /** The API's committed document, such as `apps/studio/api/contracts/openapi.json`. */
  document: z.string(),
  /** `operationId@version`, as the contract checks name it. */
  operation: z.string(),
  kind: z.enum(['added', 'changed', 'removed']),
  /** Where it is served, such as `GET` `/device/configuration`. */
  method: z.string(),
  path: z.string(),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  /**
   * The contract as the checks compare it, before and after: every reference resolved, prose left out, laid out as
   * JSON. Null on the side it does not exist on.
   */
  before: z.string().nullable(),
  after: z.string().nullable()
});
export type ContractChange = z.output<typeof ContractChangeSchema>;

export const PullSchema = PullSummarySchema.extend({
  body: z.string(),
  url: z.url(),
  createdAt: z.iso.datetime(),
  baseSha: z.string(),
  headSha: z.string(),
  /** Where the head branch left the base: the old side of every file. */
  mergeBaseSha: z.string(),
  /** Null while GitHub is still working it out. */
  mergeable: z.boolean().nullable(),
  mergeableState: z.string(),
  commits: z.int(),
  labels: z.array(z.object({ name: z.string(), color: z.string() }))
});
export type Pull = z.output<typeof PullSchema>;

export const ReviewSchema = z.object({
  repository: z.string(),
  pull: PullSchema,
  files: z.array(ReviewFileSchema),
  checks: z.array(CheckSchema),
  conversation: z.array(ConversationEntrySchema),
  threads: z.array(ThreadSchema),
  stack: z.array(StackEntrySchema),
  contracts: z.array(ContractChangeSchema)
});
export type Review = z.output<typeof ReviewSchema>;

export const PullListSchema = z.object({
  repository: z.string(),
  /** Open pull requests, each stack's members together, bottom first. */
  open: z.array(StackEntrySchema),
  recent: z.array(PullSummarySchema)
});
export type PullList = z.output<typeof PullListSchema>;

export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.output<typeof ApiErrorSchema>;
