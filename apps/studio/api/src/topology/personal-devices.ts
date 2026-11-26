// The kinds of device someone goes live from in the studio (docs/shows.md, Going live), each with a standing stream of
// its own for them (src/db/schemas/publishing.ts): "Ada's phone", "Ada's computer".

export const PERSONAL_DEVICES = ['phone', 'computer'] as const;
export type PersonalDevice = (typeof PERSONAL_DEVICES)[number];
