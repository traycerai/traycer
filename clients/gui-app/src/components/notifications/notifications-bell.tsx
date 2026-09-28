import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { Bell } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import { RollingNumber } from "@/components/ui/rolling-number";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { useNotificationCenter } from "@/hooks/notifications/use-notification-center";
import {
  notificationBellAccessibleLabel,
  type NotificationBellState,
} from "@/stores/notifications/merged-notifications";
import { formatChordForDisplay } from "@/lib/keybindings/chord";

/**
 * The badge's arrival and departure, at the `LeaderDigitBadge` values so every
 * small appearing pill in the app shares one timing. `0.9` rather than `0`: a
 * badge that grows from nothing reads as a pop, and the origin is the corner
 * that overlaps the bell (`origin-bottom-left` against a `-top-1 -right-1`
 * placement), so it grows out of the glyph rather than out of the page.
 */
const BADGE_HIDDEN = { opacity: 0, scale: 0.9 } as const;
const BADGE_PRESENT = { opacity: 1, scale: 1 } as const;
const BADGE_TRANSITION = { duration: 0.14, ease: "easeOut" } as const;

/**
 * Top-level notifications trigger in the app header. Shows an unread-count
 * badge and opens the `NotificationsPopover` on click. Native toast/chime
 * emission is owned by `NotificationEmissionController` so all sources share
 * the same hold/coalescing/focus policy.
 *
 * The center's Popover wiring is `useNotificationCenter`'s, shared with the
 * strip's Notifications drawer; this owns the bell trigger and its badge, so
 * `NotificationsPopover` stays purely presentational.
 */
export function NotificationsBell() {
  const placement = useColumnOverlayPlacement("foot");
  const {
    open,
    setOpen,
    bellState,
    chord,
    triggerRef,
    onTriggerPointerDown,
    onTriggerKeyDown,
    contentHandlers,
    popoverProps,
  } = useNotificationCenter();

  // The badge appears and disappears in a single frame under reduced motion,
  // with the app's "Panel animations" switch off, or in a pane that is mounted
  // but not painting. `initial={false}` is motion's own "start where you are";
  // an absent `exit` resolves the moment `AnimatePresence` asks for it.
  const motionEnabled = useMotionEnabled();
  const badgeInitial = motionEnabled ? BADGE_HIDDEN : false;
  const badgeExit = motionEnabled ? BADGE_HIDDEN : undefined;

  const ariaLabel = notificationBellAccessibleLabel(bellState);
  const bellTooltip = (state: NotificationBellState): string => {
    // The path forward the hollow `unknown` dot needs. Without it this is the
    // bare gray dot with no explanation that got `unknown` suppressed into
    // `clear` in the first place - see `useNotificationBellState`.
    //
    // Names the CONSEQUENCE, not a cause: `unknown` is reached by an
    // unreachable stream AND by a reachable one whose summary is not exact
    // yet, so naming the transport was a diagnosis this state cannot support.
    if (state.kind === "unknown") {
      return "Notifications status unavailable, so this may be out of date";
    }
    return chord === null
      ? "Notifications"
      : `Notifications (${formatChordForDisplay(chord)})`;
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label={open ? null : bellTooltip(bellState)}
        side={placement?.side ?? "top"}
        sideOffset={6}
        align={placement?.align}
      >
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            // Non-editable chrome, dimmed while a layout session is live (4.2).
            data-layout-passive
            data-testid="notifications-bell"
            aria-label={ariaLabel}
            onPointerDown={onTriggerPointerDown}
            onKeyDown={onTriggerKeyDown}
            // The open surface is `ghost`'s own `aria-expanded:` styling, which
            // the PopoverTrigger sets for us.
            className="relative"
          >
            <Bell
              className="size-4 text-muted-foreground group-hover/button:text-foreground"
              aria-hidden
            />
            <AnimatePresence initial={false}>
              {bellState.kind === "attention" ? (
                <m.span
                  key="attention-badge"
                  data-testid="notifications-attention-badge"
                  aria-hidden
                  initial={badgeInitial}
                  animate={BADGE_PRESENT}
                  exit={badgeExit}
                  transition={BADGE_TRANSITION}
                  className="absolute -right-1 -top-1 flex h-4 min-w-4 origin-bottom-left items-center justify-center rounded-md bg-destructive px-1 text-overline font-semibold leading-none text-destructive-foreground tabular-nums shadow-sm ring-2 ring-background"
                >
                  <RollingNumber
                    value={bellState.count}
                    className={undefined}
                    testId="notifications-attention-count"
                  />
                </m.span>
              ) : null}
            </AnimatePresence>
            {bellState.kind === "quietDot" && (
              <span
                data-testid="notifications-quiet-dot"
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
              />
            )}
            {/*
              `s5-parity-gaps` gap 3. `unknown` used to fall through to the
              bare bell, which is a positive claim that nothing is waiting -
              made by a UI that does not know. On the modern free tier the
              cloud summary is unavailable, so that false-clear is the STEADY
              STATE rather than a connecting blip.

              Deliberately a HOLLOW dot, not a filled one: filled is
              `quietDot`'s vocabulary and means "there is unread activity",
              which would be the opposite lie. An outline says "there may be
              something here and we cannot see it", and the trigger tooltip
              above carries the reason so the state is not a bare gray
              dot with no path forward - the objection that kept it hidden.
            */}
            {bellState.kind === "unknown" && (
              <span
                data-testid="notifications-unknown-indicator"
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-muted-foreground/70 bg-background ring-2 ring-background"
              />
            )}
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        layout="bare"
        side={placement?.side}
        align={placement?.align ?? "end"}
        className="w-auto overflow-hidden"
        {...contentHandlers}
      >
        <NotificationsPopover variant="center" {...popoverProps} />
      </PopoverContent>
    </Popover>
  );
}
