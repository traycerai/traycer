import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { cn } from "@/lib/utils";
import { leaderHint } from "@/components/ui/leader-digit-shortcuts";
import { singleDigitLeaderDigitFor } from "@/providers/keybinding-context";

const BADGE_TRANSITION = { duration: 0.12, ease: "easeOut" } as const;

interface PickerLeaderBadgeProps {
  /** True while this surface's leader is held (the picker owns the modifier). */
  readonly show: boolean;
  readonly index: number;
  readonly hintAction: string;
  readonly hintTarget: string;
  readonly testId: string;
  /** All three placements are absolute / out of flow, so revealing a badge never reflows its surface. */
  readonly placement: "corner" | "trailing" | "leading";
}

/** All placements are absolutely positioned (out of flow) so the fade-in never shifts surrounding layout. */
export function PickerLeaderBadge(props: PickerLeaderBadgeProps) {
  const { show, index, hintAction, hintTarget, testId, placement } = props;
  const digit = singleDigitLeaderDigitFor(index);
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <m.span
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={BADGE_TRANSITION}
          aria-label={leaderHint(digit, hintAction, hintTarget)}
          data-testid={testId}
          className={cn(
            "pointer-events-none flex items-center justify-center rounded-[0.3rem] bg-primary font-bold tabular-nums leading-none text-primary-foreground shadow-sm ring-1 ring-primary/40",
            placement === "corner" &&
              "absolute right-0 top-0 size-[1.125rem] text-[0.6875rem]",
            placement === "leading" &&
              "absolute left-0 top-0 size-[1.125rem] text-[0.6875rem]",
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
