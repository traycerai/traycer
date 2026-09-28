import { type ReactNode } from "react";
import { Bell } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
import { RollingNumber } from "@/components/ui/rolling-number";
import {
  Analytics,
  AnalyticsEvent,
  analyticsCountBucket,
} from "@/lib/analytics";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { cn } from "@/lib/utils";
import {
  notificationBellAccessibleLabel,
  useMergedNotificationUnreadCount,
  useNotificationBellState,
  useNotificationCenterHostState,
} from "@/stores/notifications/merged-notifications";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";

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

/**
 * Which of the two badges the bell is wearing, or `null` for none.
 *
 * One model rather than two independent renders, because the two badges are
 * one slot: the same 16px box at the same corner, and at most one of them is
 * ever on screen.
 */
interface MobileBadgeModel {
  /** The badge KIND, which is what makes a swap read as a swap to presence. */
  readonly key: string;
  readonly count: number;
  readonly testId: string;
  readonly countTestId: string;
  readonly toneClassName: string;
}

/**
 * One count badge, at whichever of the two tones the state asks for. Both wear
 * the same box and the same arrival; only the fill and the count differ, and
 * writing the motion twice is how the two drift apart.
 */
function MobileCountBadge(props: {
  readonly count: number;
  readonly testId: string;
  readonly countTestId: string;
  readonly toneClassName: string;
  readonly motionEnabled: boolean;
}): ReactNode {
  return (
    <m.span
      data-testid={props.testId}
      aria-hidden
      initial={props.motionEnabled ? BADGE_HIDDEN : false}
      animate={BADGE_PRESENT}
      exit={props.motionEnabled ? BADGE_HIDDEN : undefined}
      transition={BADGE_TRANSITION}
      className={cn(
        "absolute -right-1 -top-1 flex h-4 min-w-4 origin-bottom-left items-center justify-center rounded-md px-1 text-overline font-semibold leading-none tabular-nums shadow-sm ring-2 ring-background",
        props.toneClassName,
      )}
    >
      {props.count > BADGE_COUNT_CAP ? (
        `${BADGE_COUNT_CAP}+`
      ) : (
        <RollingNumber
          value={props.count}
          className={undefined}
          testId={props.countTestId}
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
  const setOpen = useNotificationsPopoverStore((state) => state.setOpen);
  const unread = useMergedNotificationUnreadCount();
  const bellState = useNotificationBellState();
  const hostState = useNotificationCenterHostState();
  const motionEnabled = useMotionEnabled();
  const showsUnreadBadge = bellState.kind === "quietDot" && unread > 0;
  // The attention badge outranks the unread one, and only one of them is ever
  // drawn - which is why they share a single presence below.
  const attentionBadge: MobileBadgeModel | null =
    bellState.kind === "attention"
      ? {
          key: "attention",
          count: bellState.count,
          testId: "mobile-notifications-attention-badge",
          countTestId: "mobile-notifications-attention-count",
          toneClassName: "bg-destructive text-destructive-foreground",
        }
      : null;
  // Unlike the desktop bell's quiet dot, show the unread count - this is the
  // only notifications surface on phones, so the count carries real signal
  // here. Dot only when the merged count hasn't resolved to a number yet.
  const unreadBadge: MobileBadgeModel | null = showsUnreadBadge
    ? {
        key: "unread",
        count: unread,
        testId: "mobile-notifications-unread-badge",
        countTestId: "mobile-notifications-unread-count",
        toneClassName: "bg-primary text-primary-foreground",
      }
    : null;
  const badge = attentionBadge ?? unreadBadge;

  const handleOpen = () => {
    // Mirror the desktop bell's open telemetry (notifications-bell.tsx). That
    // bell isn't mounted on mobile, so its edge-triggered open effect never
    // fires - this button is the sole open path here, and it's a direct UI
    // interaction, hence entry_point "direct_ui".
    const attentionCount = bellState.kind === "attention" ? bellState.count : 0;
    Analytics.getInstance().track(AnalyticsEvent.NotificationCenterOpened, {
      entry_point: "direct_ui",
      host_state: hostState.isPartial ? "unknown" : "exact",
      attention_bucket:
        bellState.kind === "unknown"
          ? "unknown"
          : analyticsCountBucket(attentionCount),
      unread_bucket:
        bellState.kind === "unknown" ? "unknown" : analyticsCountBucket(unread),
    });
    setOpen(true);
  };

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
      {/* ONE presence for one box. The two badges are `absolute -right-1
          -top-1` on the same corner, so two presence blocks made a swap play
          both at once - the outgoing badge's 140ms exit underneath the
          incoming one's 140ms enter, two differently toned pills overlapping
          in a 16px box for about eight frames, where the old code swapped in a
          frame. One presence with one child keyed by the badge KIND lets the
          machinery see a swap; `mode="wait"` is what makes it one, by holding
          the arrival until the departure is done. A badge arriving on its own,
          or leaving on its own, is unchanged. */}
      <AnimatePresence initial={false} mode="wait">
        {badge === null ? null : (
          <MobileCountBadge
            key={badge.key}
            count={badge.count}
            testId={badge.testId}
            countTestId={badge.countTestId}
            toneClassName={badge.toneClassName}
            motionEnabled={motionEnabled}
          />
        )}
      </AnimatePresence>
      {bellState.kind === "quietDot" && unread === 0 && (
        <span
          data-testid="mobile-notifications-quiet-dot"
          aria-hidden
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
        />
      )}
    </Button>
  );
}
