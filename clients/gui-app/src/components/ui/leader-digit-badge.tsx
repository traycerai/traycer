import * as m from "motion/react-m";
import { cn } from "@/lib/utils";
import { leaderGlyph } from "@/lib/keybindings/platform";
import type { LeaderModifier } from "@/providers/keybinding-context";
import { Kbd } from "@/components/ui/kbd";
import { leaderDigitFor } from "@/components/ui/leader-digit-shortcuts";

const LEADER_BADGE_TRANSITION = {
  duration: 0.14,
  ease: "easeOut",
} as const;

interface LeaderDigitBadgeProps {
  /** Tab / section index (0-based). Displayed as a 1-based shortcut number. */
  readonly index: number;
  readonly modifier: LeaderModifier;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly className: string | undefined;
}

/**
 * Compact `⌘1`-style badge used to hint that a given slot is reachable by
 * the leader + digit shortcut. Shared by the epic tab strip and the
 * settings section sidebar.
 */
export function LeaderDigitBadge(props: LeaderDigitBadgeProps) {
  const { index, modifier, ariaLabel, testId, className } = props;
  const digit = leaderDigitFor(index);
  const symbol = leaderGlyph(modifier);
  return (
    <m.span
      initial={false}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.86 }}
      transition={LEADER_BADGE_TRANSITION}
      className="inline-flex origin-center"
    >
      <Kbd
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn("text-overline font-semibold tabular-nums", className)}
      >
        {symbol}
        {digit}
      </Kbd>
    </m.span>
  );
}
