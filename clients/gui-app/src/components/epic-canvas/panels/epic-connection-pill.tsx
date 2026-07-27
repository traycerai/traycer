import { useEffect, useState } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { LivePulse } from "@/components/ui/live-pulse";
import { useEpicSyncPillState } from "@/lib/epic-selectors";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

/**
 * Small inline sync pill that the active Epic header renders so users can
 * tell at a glance whether their work has actually reached the cloud.
 *
 * It is deliberately NOT a connection indicator. It used to be one - it read
 * the renderer↔host stream status alone - and that is why it read "All changes
 * synced" through the incident where an Epic's artifact bodies existed nowhere
 * but the authoring host. The claim now comes from
 * {@link EpicSyncPillState}, which weighs the host↔cloud link, a fresh cloud
 * observation, and both dirtiness legs as well, and resolves every ambiguous
 * case toward "not synced".
 *
 * Transient disconnects keep edits buffered (in the host's durable store while
 * only the cloud link is down, in the per-Epic store while the host itself is
 * unreachable) and flush on reconnect; the pill is the only indicator - there
 * is no banner during reconnect.
 */
export function EpicConnectionPill() {
  const derived = useEpicSyncPillState();
  const state = useSettledSyncPillState(derived);
  const indicator = indicatorFor(state);
  // The tooltip reads the DERIVED verdict, not the settled display state. The
  // two differ in exactly one case - the 750ms hold, where the display still
  // says "Syncing…" after the verdict has already gone `synced` - and in that
  // window the `syncing` tooltip's "some changes have not reached the cloud
  // yet" is false. Holding a conservative LABEL is the anti-strobe trade; a
  // tooltip that asserts an untrue fact is not part of it.
  const tooltip = indicatorFor(derived).tooltip;

  return (
    <TooltipWrapper
      label={tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        data-testid="epic-connection-pill"
        data-status={state}
        aria-label={indicator.ariaLabel}
        className={cn(
          "inline-flex items-center gap-1 text-ui-xs font-medium text-current focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          indicator.containerClassName,
        )}
      >
        <ConnectionPillDot indicator={indicator} />
        {indicator.label}
      </button>
    </TooltipWrapper>
  );
}

/**
 * How long the derived verdict must stay `synced` before the pill is allowed
 * to say so.
 *
 * Without this the pill strobes on every keystroke. A local body edit sets the
 * replica's dirty watermark, and the host answers each `artifactRoomApplyUpdate`
 * with an ack frame carrying its post-apply state vector *specifically* so the
 * watermark can clear (`epic-stream-resolver.ts`, "emit a `artifactRoomUpdate`
 * ack back to the sender"). That round trip is milliseconds against a local
 * host, so input 4 flips true→false once per edit.
 *
 * The delay only ever holds a NON-green verdict on screen for longer. It can
 * never do the reverse, which is the direction that matters here.
 */
const SYNCED_SETTLE_MS = 750;

/**
 * Smooths the settle into `synced` without ever smoothing the way out of it.
 * A verdict that is not `synced` is displayed the instant it is derived; the
 * `synced` verdict is displayed only after it has held for
 * {@link SYNCED_SETTLE_MS}, and reads as "Syncing…" until then.
 */
function useSettledSyncPillState(
  derived: EpicSyncPillState,
): EpicSyncPillState {
  // A first render may happen before the current subscription has established
  // all of its durability facts. Start conservatively and make even an
  // initially-derived `synced` verdict earn the same settle interval.
  const [maySaySynced, setMaySaySynced] = useState(false);

  // Render-phase adjustment rather than an effect: React re-runs the render
  // before committing, so losing `synced` never paints even one frame of the
  // stale green claim.
  if (derived !== "synced" && maySaySynced) {
    setMaySaySynced(false);
  }

  useEffect(() => {
    if (derived !== "synced") return undefined;
    const timer = setTimeout(() => {
      setMaySaySynced(true);
    }, SYNCED_SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [derived]);

  if (derived !== "synced") return derived;
  return maySaySynced ? "synced" : "syncing";
}

interface PillIndicator {
  readonly containerClassName: string;
  readonly dotClassName: string;
  readonly label: string | null;
  readonly showAgentSpinner: boolean;
  readonly pulse: "active" | "idle" | null;
  readonly tooltip: string | null;
  readonly ariaLabel: string;
}

function ConnectionPillDot(props: { indicator: PillIndicator }) {
  const { indicator } = props;
  if (indicator.showAgentSpinner) {
    return (
      <AgentSpinningDots
        testId="epic-connection-pill-dot"
        variant="dots"
        className={indicator.dotClassName}
      />
    );
  }
  if (indicator.pulse !== null) {
    return (
      <LivePulse
        size="xs"
        tone={indicator.pulse}
        ariaLabel={indicator.ariaLabel}
        className={cn("shrink-0", indicator.dotClassName)}
      />
    );
  }
  return (
    <span
      data-testid="epic-connection-pill-dot"
      className={cn("size-1.5 rounded-full", indicator.dotClassName)}
      aria-hidden
    />
  );
}

const QUIET_CONTAINER_CLASS =
  "h-5 px-1.5 py-0 text-overline italic leading-none text-muted-foreground";
const AMBER_CONTAINER_CLASS =
  "rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400";

function indicatorFor(state: EpicSyncPillState): PillIndicator {
  switch (state) {
    // Icon-only: the steady state is the one users see ~always, so it earns no
    // permanent copy in the status row - the pulse plus its tooltip say it.
    // Every OTHER state keeps its label: they are transient or alerting, and
    // the amber/red ones are precisely the ones that must not be reduced to a
    // glyph the user has to hover to read.
    case "synced":
      return {
        containerClassName: QUIET_CONTAINER_CLASS,
        dotClassName: "",
        label: null,
        showAgentSpinner: false,
        pulse: "active",
        tooltip: "All changes synced",
        ariaLabel: "All changes synced",
      };
    // Same quiet treatment as `synced` rather than the amber alert styling:
    // outstanding work is the normal steady state right after an edit, and an
    // amber flash on every save would train users to ignore the pill. The
    // difference that matters is that it no longer CLAIMS synced.
    case "syncing":
      return {
        containerClassName: QUIET_CONTAINER_CLASS,
        dotClassName: "text-muted-foreground",
        label: "Syncing…",
        showAgentSpinner: true,
        pulse: null,
        tooltip: "Some changes have not reached the cloud yet.",
        ariaLabel: "Syncing changes",
      };
    // No spinner: nothing is in flight while the host's cloud link is down.
    // The durability claim in this copy is load-bearing and true - the host
    // persists the outstanding updates and replays them on reconnect.
    case "offlineChangesSavedLocally":
      return {
        containerClassName: AMBER_CONTAINER_CLASS,
        dotClassName: "bg-amber-500",
        label: "Offline — changes saved locally",
        showAgentSpinner: false,
        pulse: null,
        tooltip:
          "The cloud connection is down. Your changes are saved on this device and sync when it is back.",
        ariaLabel:
          "Offline. Changes are saved on this device and sync when the connection is back.",
      };
    // The stream is up but this cycle has not supplied enough evidence for a
    // cloud/durability claim. Keep the copy factual and intentionally avoid
    // guessing why (old host, reconnect, or pending first status are all
    // possible).
    case "connected":
      return {
        containerClassName: QUIET_CONTAINER_CLASS,
        dotClassName: "bg-muted-foreground",
        label: "Connected",
        showAgentSpinner: false,
        pulse: null,
        tooltip: null,
        ariaLabel: "Connected",
      };
    // The three link states below make NO durability claim. While the
    // renderer↔host stream is down the only copy of an unsent edit is in this
    // window's memory, so "saved locally" would be a lie.
    case "connecting":
      return {
        containerClassName: AMBER_CONTAINER_CLASS,
        dotClassName: "text-amber-500",
        label: "Connecting…",
        showAgentSpinner: true,
        pulse: null,
        tooltip: null,
        ariaLabel: "Connecting to server",
      };
    case "reconnecting":
      return {
        containerClassName: AMBER_CONTAINER_CLASS,
        dotClassName: "text-amber-500",
        label: "Reconnecting…",
        showAgentSpinner: true,
        pulse: null,
        tooltip: null,
        ariaLabel: "Reconnecting to server",
      };
    case "offline":
      return {
        containerClassName:
          "rounded-md bg-red-500/10 px-2 py-0.5 text-red-700 dark:text-red-400",
        dotClassName: "bg-red-500",
        label: "Offline",
        showAgentSpinner: false,
        pulse: null,
        // No "changes will sync when reconnected" here. This is the one state
        // where an unsent edit exists only in this window's memory, so a
        // durability promise is exactly backwards: closing the window is what
        // loses it. Say where the edits are and what keeps them.
        tooltip:
          "Disconnected. Unsent changes stay in this window until it reconnects — keep it open.",
        ariaLabel:
          "Disconnected. Unsent changes stay in this window until it reconnects — keep it open.",
      };
  }
}
