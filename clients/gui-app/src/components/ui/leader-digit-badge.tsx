import * as m from "motion/react-m";
import { cn } from "@/lib/utils";
import { leaderGlyph } from "@/lib/keybindings/platform";
import { Kbd } from "@/components/ui/kbd";

const LEADER_BADGE_TRANSITION = {
  duration: 0.14,
  ease: "easeOut",
} as const;

interface LeaderDigitBadgeProps {
  /** Pre-computed shortcut digit. Callers pick the convention (plain
   *  `leaderDigitFor` or the wraparound `singleDigitLeaderDigitFor`) that
   *  matches how their scope actually dispatches the chord, so this badge
   *  never has to know which one applies. */
  readonly digit: string;
  /** Epic tabs and the settings sidebar only ever bind a bare `mod`/`alt`
   *  leader - narrower than `LeaderModifier`, which also carries the model
   *  picker's shifted `modShift` dimension this badge never renders. */
  readonly modifier: "mod" | "alt";
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
  const { digit, modifier, ariaLabel, testId, className } = props;
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
