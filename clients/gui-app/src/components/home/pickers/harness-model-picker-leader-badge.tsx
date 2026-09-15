import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { cn } from "@/lib/utils";
import { singleDigitLeaderDigitFor } from "@/providers/keybinding-context";

const BADGE_TRANSITION = { duration: 0.12, ease: "easeOut" } as const;

interface PickerLeaderBadgeProps {
  readonly index: number;
  /** The scope's visible modifier; null hides the badge. */
  readonly modifier: "mod" | "alt" | null;
  readonly testId: string;
  /**
   * All placements are absolute / out of flow, so revealing a badge
   * never reflows its surface. `corner` floats a tiny number in the icon's
   * top-right (rail, no label room); `trailing` floats just past a label's
   * right edge (reasoning pills), landing in the pill's existing trailing
   * whitespace; `leading` floats at the top-left, opposite `corner`; `center`
   * sits inside a slider stop or the Fast icon's slot.
   */
  readonly placement: "corner" | "trailing" | "leading" | "center";
}

/**
 * A minimal digit-only leader hint. The held key already tells you the modifier
 * (⌘ for the rail, ⌥ for reasoning), so the badge shows just the number and
 * leaves the level label visible. Compact controls replace their dot or icon
 * with a centered badge while the leader is held. All placements are
 * absolutely positioned (out of flow) so the fade-in never shifts surrounding
 * layout.
 */
export function PickerLeaderBadge(props: PickerLeaderBadgeProps) {
  const { index, modifier, testId, placement } = props;
  const digit = singleDigitLeaderDigitFor(index);
  return (
    <AnimatePresence initial={false}>
      {modifier !== null ? (
        <m.span
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={BADGE_TRANSITION}
          aria-hidden="true"
          data-testid={testId}
          className={cn(
            "pointer-events-none flex items-center justify-center rounded-[0.3rem] bg-primary font-bold tabular-nums leading-none text-primary-foreground shadow-sm ring-1 ring-primary/40",
            placement === "corner" &&
              "absolute right-0 top-0 size-[1.125rem] text-[0.6875rem]",
            placement === "leading" &&
              "absolute left-0 top-0 size-[1.125rem] text-[0.6875rem]",
            placement === "center" &&
              "absolute left-1/2 top-1/2 h-4 -translate-x-1/2 -translate-y-1/2 px-0.5 text-[0.625rem] shadow-none",
            placement === "trailing" &&
              "absolute left-full top-1/2 ml-1 h-[1.125rem] min-w-[1.125rem] -translate-y-[calc(50%+0.1rem)] px-1 text-[0.6875rem]",
          )}
        >
          {digit}
        </m.span>
      ) : null}
    </AnimatePresence>
  );
}
