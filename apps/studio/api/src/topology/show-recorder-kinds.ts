/** The kinds of show recorder: `obs`, OBS recording the programme alongside streaming it. */
export const SHOW_RECORDER_KINDS = ['obs'] as const;
export type ShowRecorderKind = (typeof SHOW_RECORDER_KINDS)[number];
