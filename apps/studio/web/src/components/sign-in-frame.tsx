import type { ReactNode, FC } from 'react';
import { motion } from 'motion/react';

import { BrushedBrandMark } from '@/components/brushed-brand-mark';
import { PanelCard, PanelColumn } from '@/components/panel';
import './brand-glow.css';

export interface SignInFrameProps {
  /** The card's contents: usually a PanelBody. */
  children: ReactNode;
}

/**
 * The sign-in screens' page: the conservation.tv logo and wordmark above a panel's card, on the app's warm canvas,
 * with light rising off the card behind the logo. A flow whose steps change what's in the card (sign-in) keeps one
 * frame mounted across them, so the card's entry plays once per page.
 */
export const SignInFrame: FC<SignInFrameProps> = ({ children }) => {
  return (
    // The full-screen layer carries the warm canvas behind the narrow column, and isolates its stacking so nothing
    // inside can fall behind the canvas itself.
    <div className="isolate min-h-svh bg-linear-to-b from-custom-canvas-top to-custom-canvas-bottom">
      <PanelColumn>
        <div className="flex flex-col gap-8">
          {/* Raised above the card's layer, so the uplight rising from the card passes behind the logo. */}
          <div className="relative z-10 flex flex-col items-center gap-1 self-center">
            <BrushedBrandMark />
            {/* The wordmark rises a little into place under the mark while its waves are brushed in. */}
            <motion.span
              className="text-2xl leading-none font-semibold tracking-tight"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.7, ease: [0.22, 1, 0.36, 1] }}
            >
              conservation.tv
            </motion.span>
          </div>
          {/* The card rises gently into place, carrying its uplight with it. The animation's opacity and transform make
              this a stacking context only while it runs, so it is isolated throughout: the uplight stays behind the
              card, and the logo above it, before, during and after. */}
          <motion.div
            className="relative isolate"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* The uplight: light rising off the card's top edge and fading upward behind the logo; see brand-glow.css.
                It comes up from the card's edge as the card settles into place, as though switching on. (Tailwind's
                translate is its own CSS property, so motion's transform scales alongside it rather than replacing it.) */}
            <motion.div
              aria-hidden
              className="brand-glow brand-glow-up pointer-events-none absolute inset-x-6 bottom-full -z-10 h-44 origin-bottom translate-y-px"
              initial={{ opacity: 0, scaleY: 0.4 }}
              animate={{ opacity: 1, scaleY: 1 }}
              transition={{ duration: 1.2, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
            />
            {/* Roomier than the default card. */}
            <PanelCard className="[--card-spacing:--spacing(6)]">{children}</PanelCard>
            {/* The uplight catching the card's top border: a vivid line over the card's ring (which sits just outside
                the card), lit in the middle and fading before the corners. Comes up with the uplight; see
                brand-glow.css. */}
            <motion.div
              aria-hidden
              className="brand-glow-edge pointer-events-none absolute inset-x-0 -top-px h-px"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.2, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
            />
          </motion.div>
        </div>
      </PanelColumn>
    </div>
  );
};
