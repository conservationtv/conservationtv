import { createContext } from 'react';

/**
 * Whether someone watching asked to hear the show (src/components/shows/broadcast-stage.tsx). The studio's stage is a
 * monitor: a source hands its sound to the stream's mixer only once they have, so opening a show never starts sound
 * by itself, even where the page already had a gesture that would let it. A source outside a stage that offers this
 * stays silent.
 */
export const MonitorSoundContext = createContext(false);
