/** The kinds of output recorder: `obs`, OBS recording the programme alongside streaming it. */
export const OUTPUT_RECORDER_KINDS = ['obs'] as const;
export type OutputRecorderKind = (typeof OUTPUT_RECORDER_KINDS)[number];

/** How an output's scenes are driven: by the show it follows, or by something outside the studio altogether. */
export const OUTPUT_CONTROLS = ['show', 'external'] as const;
export type OutputControl = (typeof OUTPUT_CONTROLS)[number];
