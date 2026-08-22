import { useEffect, useState } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { LivePulse } from "@/components/ui/live-pulse";
import {
  useEpicHasFreshCloudSyncStatus,
  useEpicSyncPillState,
} from "@/lib/epic-selectors";
import { useLinkDownTooLong } from "@/components/epic-canvas/panels/use-link-down-too-long";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useEpicChatBackupStatus,
  type EpicChatBackupStatus,
} from "@/components/epic-canvas/panels/epic-chat-backup-status";
import {
  useCommGraphFeedHealth,
  type CommGraphFeedHealth,
} from "@/components/epic-canvas/comm-graph/use-comm-graph-feed-health";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import { cn } from "@/lib/utils";
import { useHostPlainTerminalAuthority } from "@/hooks/terminal/use-plain-terminal-authority";
import { useDelayedTerminalFleetWarning } from "@/hooks/terminal/use-delayed-terminal-fleet-warning";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";

/**
 * Small inline status pill that the active Epic header renders. It selects the
 * highest-severity signal across artifact/Yjs durability, chat publication,
 * remote-terminal discovery, and the communication-graph feed. Secondary-plane
 * failures live here rather than only in the panel whose data happened to
 * expose them - or, in the graph's case, captioned onto every agent node.
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
export interface EpicConnectionPillProps {
  readonly epicId: string;
}

export function EpicConnectionPill(props: EpicConnectionPillProps) {
  const derived = useEpicSyncPillState();
  const state = useSyncPillDisplayState(derived);
  const hasFreshCloudSyncStatus = useEpicHasFreshCloudSyncStatus();
  // The escalation clock reads the RAW verdict, not the settled display
  // state: the settle hold renames a genuine `synced` to `syncing` until the
  // claim has earned its interval - fed the settled state, a real recovery
  // inside the hold window would be invisible to it. It also reads the
  // per-cycle cloud-evidence bit directly, because `connected`/`syncing` are
  // reachable both with and without evidence (legacy hosts never move
  // `hostDirtyState` off `unknown`) and the label alone cannot end an outage.
  const linkDownTooLong = useLinkDownTooLong(derived, hasFreshCloudSyncStatus);
  const chatBackupStatus = useEpicChatBackupStatus(props.epicId);
  const commGraphFeedHealth = useCommGraphFeedHealth(props.epicId);
  const canvasHostId = useCanvasHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const terminalAuthority = useHostPlainTerminalAuthority({
    hostId: canvasHostId,
    scope: { kind: "epic", epicId: props.epicId },
  });
  const terminalCatalogUnavailable = useDelayedTerminalFleetWarning(
    terminalAuthority.coverage === "partial-serving-host",
    JSON.stringify([terminalAuthority.hostId, props.epicId]),
  );
  // Visuals use the settled state to avoid strobing; the tooltip uses the raw
  // verdict so it can truthfully say synced during the positive settle hold.
  const selected = highestSeverityIndicator(
    indicatorFor(state, linkDownTooLong),
    chatBackupStatus,
    terminalCatalogUnavailable,
    commGraphFeedHealth,
  );
  const rawSelected = highestSeverityIndicator(
    indicatorFor(derived, linkDownTooLong),
    chatBackupStatus,
    terminalCatalogUnavailable,
    commGraphFeedHealth,
  );
  const { indicator } = selected;

  return (
    <>
      <TooltipWrapper
        label={rawSelected.indicator.tooltip}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          data-testid="epic-connection-pill"
          data-status={state}
          data-source={selected.source}
          aria-label={rawSelected.indicator.ariaLabel}
          className={cn(
            "inline-flex items-center gap-1 text-ui-xs font-medium text-current focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            indicator.containerClassName,
          )}
        >
          <ConnectionPillDot indicator={indicator} />
          {indicator.label}
        </button>
      </TooltipWrapper>
      <span className="sr-only" role="status" aria-live="polite">
        {warningAnnouncement(state, rawSelected, linkDownTooLong)}
      </span>
    </>
  );
}

function warningAnnouncement(
  state: EpicSyncPillState,
  selected: SelectedIndicator,
  linkDownTooLong: boolean,
): string | null {
  if (
    selected.source !== "artifact" &&
    selected.indicator.severity === "warning"
  ) {
    return selected.indicator.ariaLabel;
  }
  switch (state) {
    case "offlineWithUnsavedChanges":
    case "offlineWithHostPending":
    case "offlineChangesSavedLocally":
    case "offline":
      return selected.indicator.ariaLabel;
    // A routine reconnect stays silent - it announces nothing a sighted user
    // would be interrupted by either. Once it has been down long enough to
    // escalate, it is worth saying: the copy tells the user their unsent work
    // depends on this window staying open.
    case "connecting":
    case "reconnecting":
      return linkDownTooLong ? selected.indicator.ariaLabel : null;
    default:
      return null;
  }
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
 * Keeps routine saving quiet and holds the positive `synced` claim long enough
 * to prevent strobing. Actionable connection and durability warnings bypass
 * this settle behavior and render immediately.
 */
function useSyncPillDisplayState(
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
  readonly severity: "steady" | "activity" | "warning" | "danger";
  readonly containerClassName: string;
  readonly dotClassName: string;
  readonly label: string | null;
  readonly showAgentSpinner: boolean;
  readonly pulse: "active" | "idle" | null;
  readonly tooltip: string | null;
  readonly ariaLabel: string;
}

interface SelectedIndicator {
  readonly source:
    "artifact" | "chat-backup" | "terminal-catalog" | "comm-graph";
  readonly indicator: PillIndicator;
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

/**
 * The two link-down states, and how each reads before and after
 * {@link LINK_DOWN_ESCALATION_MS}.
 *
 * The escalated copy says three things and no more: it is still trying, it
 * will keep trying by itself, and unsent edits live in this window. The last
 * is the load-bearing part - the same honesty the `offline` copy owes -
 * because the retry may never converge and closing the window is what loses
 * the work.
 */
const LINK_DOWN_COPY = {
  connecting: {
    label: "Connecting…",
    stalledLabel: "Still connecting…",
    message: "Connecting to server",
    stalledMessage:
      "Still connecting. This keeps retrying on its own — unsent changes stay in this window, so keep it open.",
  },
  reconnecting: {
    label: "Reconnecting…",
    stalledLabel: "Still reconnecting…",
    message: "Reconnecting to server",
    stalledMessage:
      "Still reconnecting. This keeps retrying on its own — unsent changes stay in this window, so keep it open.",
  },
} as const;

/**
 * The amber "link is down" indicator, escalated by
 * {@link useLinkDownTooLong}. Neither variant makes a durability claim: while
 * the renderer↔host stream is down the only copy of an unsent edit is in this
 * window's memory.
 */
function linkDownIndicator(
  kind: "connecting" | "reconnecting",
  linkDownTooLong: boolean,
): PillIndicator {
  const copy = LINK_DOWN_COPY[kind];
  const message = linkDownTooLong ? copy.stalledMessage : copy.message;
  return {
    severity: "warning",
    containerClassName: AMBER_CONTAINER_CLASS,
    dotClassName: "text-amber-500",
    label: linkDownTooLong ? copy.stalledLabel : copy.label,
    showAgentSpinner: true,
    pulse: null,
    tooltip: message,
    ariaLabel: message,
  };
}

const SEVERITY_RANK: Record<PillIndicator["severity"], number> = {
  steady: 0,
  activity: 1,
  warning: 2,
  danger: 3,
};

function highestSeverityIndicator(
  artifactIndicator: PillIndicator,
  chatBackupStatus: EpicChatBackupStatus | null,
  terminalCatalogUnavailable: boolean,
  commGraphFeedHealth: CommGraphFeedHealth | null,
): SelectedIndicator {
  let selected: SelectedIndicator = {
    source: "artifact",
    indicator: artifactIndicator,
  };
  if (chatBackupStatus !== null) {
    const chatIndicator = indicatorForChatBackup(chatBackupStatus);
    if (
      SEVERITY_RANK[chatIndicator.severity] >
      SEVERITY_RANK[selected.indicator.severity]
    ) {
      selected = { source: "chat-backup", indicator: chatIndicator };
    }
  }
  if (terminalCatalogUnavailable) {
    const terminalIndicator = indicatorForTerminalCatalogUnavailable();
    if (
      SEVERITY_RANK[terminalIndicator.severity] >
      SEVERITY_RANK[selected.indicator.severity]
    ) {
      selected = {
        source: "terminal-catalog",
        indicator: terminalIndicator,
      };
    }
  }
  if (commGraphFeedHealth !== null) {
    const feedIndicator = indicatorForCommGraphFeed(commGraphFeedHealth);
    if (
      SEVERITY_RANK[feedIndicator.severity] >
      SEVERITY_RANK[selected.indicator.severity]
    ) {
      selected = { source: "comm-graph", indicator: feedIndicator };
    }
  }
  // Ties stay with the earlier source. Artifact/Yjs warnings can mean the
  // newest bytes exist only in this renderer; chat backup, catalog health and
  // graph-feed health remain secondary when an equally severe durability
  // warning is active. The graph feed is checked last of the four because it is
  // the only read-only one: it costs the canvas new rows, not the user's data.
  return selected;
}

function indicatorForTerminalCatalogUnavailable(): PillIndicator {
  const message =
    "Remote terminal discovery is unavailable. Showing terminals from this host only. It will recover automatically.";
  return {
    severity: "warning",
    containerClassName: AMBER_CONTAINER_CLASS,
    dotClassName: "bg-amber-500",
    label: "Remote terminals unavailable",
    showAgentSpinner: false,
    pulse: null,
    tooltip: message,
    ariaLabel: message,
  };
}

function indicatorForChatBackup(status: EpicChatBackupStatus): PillIndicator {
  return {
    severity: status.severity,
    containerClassName: QUIET_CONTAINER_CLASS,
    dotClassName:
      status.severity === "warning" ? "bg-amber-500" : "bg-muted-foreground",
    label: null,
    showAgentSpinner: false,
    pulse: null,
    tooltip: status.tooltip,
    ariaLabel: status.ariaLabel,
  };
}

/**
 * Dot-only, like chat backup: the feed degrading is worth an amber light and a
 * sentence on hover, not a permanent label in the status row - the canvas is
 * still fully usable on the rows it already holds.
 */
function indicatorForCommGraphFeed(health: CommGraphFeedHealth): PillIndicator {
  return {
    severity: health.severity,
    containerClassName: QUIET_CONTAINER_CLASS,
    dotClassName: "bg-amber-500",
    label: null,
    showAgentSpinner: false,
    pulse: null,
    tooltip: health.tooltip,
    ariaLabel: health.ariaLabel,
  };
}

function indicatorFor(
  state: EpicSyncPillState,
  linkDownTooLong: boolean,
): PillIndicator {
  switch (state) {
    // Icon-only: the steady state is the one users see ~always, so it earns no
    // permanent copy in the status row - the pulse plus its tooltip say it.
    // Every OTHER state keeps its label: they are transient or alerting, and
    // the amber/red ones are precisely the ones that must not be reduced to a
    // glyph the user has to hover to read.
    case "synced":
      return {
        severity: "steady",
        containerClassName: QUIET_CONTAINER_CLASS,
        dotClassName: "",
        label: null,
        showAgentSpinner: false,
        pulse: "active",
        tooltip: "All changes synced",
        ariaLabel: "All changes synced",
      };
    // Normal renderer→host and host→cloud churn stays icon-only. The neutral
    // dot makes no durability claim and avoids a permanent spinner while an
    // active agent continuously updates the Epic.
    case "syncing":
    case "hostPending":
      return {
        severity: "activity",
        containerClassName: QUIET_CONTAINER_CLASS,
        dotClassName: "",
        label: null,
        showAgentSpinner: false,
        pulse: "idle",
        tooltip: "Saving changes",
        ariaLabel: "Saving changes",
      };
    case "offlineWithUnsavedChanges":
      return {
        severity: "warning",
        containerClassName: AMBER_CONTAINER_CLASS,
        dotClassName: "text-amber-500",
        label: "Offline — saving changes…",
        showAgentSpinner: true,
        pulse: null,
        tooltip:
          "The cloud connection is down, and some recent changes are still being saved on this device. Keep this window open.",
        ariaLabel:
          "Offline. Some recent changes are still being saved on this device. Keep this window open.",
      };
    case "offlineWithHostPending":
      return {
        severity: "warning",
        containerClassName: AMBER_CONTAINER_CLASS,
        dotClassName: "bg-amber-500",
        label: "Offline — changes pending",
        showAgentSpinner: false,
        pulse: null,
        tooltip:
          "The cloud connection is down. This device is still processing pending changes; keep it running.",
        ariaLabel:
          "Offline. This device is still processing pending changes; keep it running.",
      };
    // No spinner: nothing is in flight while the host's cloud link is down.
    // The durability claim in this copy is load-bearing and true - the host
    // persists the outstanding updates and replays them on reconnect.
    case "offlineChangesSavedLocally":
      return {
        severity: "warning",
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
        severity: "activity",
        containerClassName: QUIET_CONTAINER_CLASS,
        dotClassName: "bg-muted-foreground",
        label: "Connected",
        showAgentSpinner: false,
        pulse: null,
        tooltip: "Connected",
        ariaLabel: "Connected",
      };
    // The three link states below make NO durability claim. While the
    // renderer↔host stream is down the only copy of an unsent edit is in this
    // window's memory, so "saved locally" would be a lie. The first two carry
    // an escalated variant once the link has been down long enough that
    // "…ing" stops being an honest description - see `linkDownIndicator`.
    case "connecting":
      return linkDownIndicator("connecting", linkDownTooLong);
    case "reconnecting":
      return linkDownIndicator("reconnecting", linkDownTooLong);
    case "offline":
      return {
        severity: "danger",
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
