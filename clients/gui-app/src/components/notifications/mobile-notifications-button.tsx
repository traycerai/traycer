import { type ReactNode } from "react";
import { Bell } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
import { RollingNumber } from "@/components/ui/rolling-number";
import { useOpenMobileNotificationCenter } from "@/hooks/notifications/use-open-mobile-notification-center";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import {
  notificationBellAccessibleLabel,
  useNotificationBellState,
} from "@/stores/notifications/merged-notifications";

/**
 * The same arrival the desktop bell's badge uses, at the `LeaderDigitBadge`
 * values, with the origin on the corner that overlaps the glyph so the badge
 * grows out of the bell rather than out of the page.
 */
const BADGE_HIDDEN = { opacity: 0, scale: 0.9 } as const;
const BADGE_PRESENT = { opacity: 1, scale: 1 } as const;
const BADGE_TRANSITION = { duration: 0.14, ease: "easeOut" } as const;

/** Above this the badge prints `99+`, which is not a number and does not roll. */
const BADGE_COUNT_CAP = 99;

/** The attention count badge shared with the desktop bell's red state. */
function MobileCountBadge(props: {
  readonly count: number;
  readonly motionEnabled: boolean;
}): ReactNode {
  return (
    <m.span
      data-testid="mobile-notifications-attention-badge"
      aria-hidden
      initial={props.motionEnabled ? BADGE_HIDDEN : false}
      animate={BADGE_PRESENT}
      exit={props.motionEnabled ? BADGE_HIDDEN : undefined}
      transition={BADGE_TRANSITION}
      className="absolute -right-1 -top-1 flex h-4 min-w-4 origin-bottom-left items-center justify-center rounded-md bg-destructive px-1 text-overline font-semibold leading-none text-destructive-foreground tabular-nums shadow-sm ring-2 ring-background"
    >
      {props.count > BADGE_COUNT_CAP ? (
        `${BADGE_COUNT_CAP}+`
      ) : (
        <RollingNumber
          value={props.count}
          className={undefined}
          testId="mobile-notifications-attention-count"
        />
      )}
    </m.span>
  );
}

/**
 * Notifications trigger for the phone header, sitting alongside the other
 * global status controls. The desktop `NotificationsBell` owns an anchored
 * Radix popover; on mobile the center is the full-screen
 * `NotificationsMobileSheet` driven by the same store, so this is a plain
 * button that flips it open.
 */
export function MobileNotificationsButton(): ReactNode {
  const handleOpen = useOpenMobileNotificationCenter();
  const bellState = useNotificationBellState();
  const motionEnabled = useMotionEnabled();

  return (
    <Button
      type="button"
      variant="muted"
      size="icon-sm"
      aria-label={notificationBellAccessibleLabel(bellState)}
      data-testid="mobile-notifications-button"
      className="relative shrink-0"
      onClick={handleOpen}
    >
      <Bell className="size-4" aria-hidden />
      <AnimatePresence initial={false}>
        {bellState.kind === "attention" ? (
          <MobileCountBadge
            count={bellState.count}
            motionEnabled={motionEnabled}
          />
        ) : null}
      </AnimatePresence>
      {bellState.kind === "quietDot" && (
        <span
          data-testid="mobile-notifications-quiet-dot"
          aria-hidden
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
        />
      )}
    </Button>
  );
}
