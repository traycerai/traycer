import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ProfileUsageWindow } from "@/lib/rate-limits/profile-usage-projection";
import { AccentDot } from "@/components/providers/accent-dot";
import type { ProfileDropdownUsageEntry } from "@/components/providers/profile-dropdown-usage";
import {
  deriveProfileUsageSidecarPosition,
  type ProfileUsageSidecarPosition,
} from "@/components/providers/profile-usage-sidecar-position";
import { waitForAnchorReady } from "@/components/providers/profile-usage-sidecar-anchor-readiness";
import { MeterRow } from "@/components/settings/panels/traycer-subscription-views";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  formatRelativeTimestamp,
  formatResetCountdown,
  formatResetDateTime,
  isFarReset,
  useSampledNow,
} from "@/lib/relative-time";
import { cn } from "@/lib/utils";

const SIDECAR_GAP = 8;
const VIEWPORT_PADDING = 12;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = MINUTES_PER_HOUR * 24;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
const MINUTES_PER_SESSION = MINUTES_PER_HOUR * 5;

interface ProfileUsageSidecarProps {
  readonly anchor: HTMLElement | null;
  readonly profile: ProviderProfile;
  readonly entry: ProfileDropdownUsageEntry;
  readonly isHostReady: boolean;
}

function samePosition(
  left: ProfileUsageSidecarPosition | null,
  right: ProfileUsageSidecarPosition | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.side === right.side &&
    left.left === right.left &&
    left.top === right.top
  );
}

export function ProfileUsageSidecar(
  props: ProfileUsageSidecarProps,
): ReactNode {
  const { anchor, profile, entry, isHostReady } = props;
  const [sidecarNode, setSidecarNode] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<ProfileUsageSidecarPosition | null>(
    null,
  );
  const now = useSampledNow();

  useLayoutEffect(() => {
    if (anchor === null || sidecarNode === null) return;
    // Gates `update()` until the anchor has a real Radix placement (not the
    // off-screen measuring position) and its entrance animation, if any, has
    // settled - so a measurement is never taken, and nothing ever painted,
    // mid placement or mid transform. See `waitForAnchorReady` for why.
    let ready = false;
    const update = () => {
      if (!ready) return;
      const anchorRect = anchor.getBoundingClientRect();
      const sidecarRect = sidecarNode.getBoundingClientRect();
      const next = deriveProfileUsageSidecarPosition({
        anchor: anchorRect,
        sidecarWidth: sidecarRect.width,
        sidecarHeight: sidecarRect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap: SIDECAR_GAP,
        padding: VIEWPORT_PADDING,
      });
      setPosition((current) => (samePosition(current, next) ? current : next));
    };
    const controller = new AbortController();
    void waitForAnchorReady(anchor, controller.signal).then(() => {
      if (controller.signal.aborted) return;
      ready = true;
      update();
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    observer.observe(sidecarNode);
    return () => {
      controller.abort();
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, entry.projection, sidecarNode]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <aside
      ref={setSidecarNode}
      aria-label={`Usage details for ${profile.label}`}
      aria-live="off"
      data-profile-usage-sidecar=""
      data-side={position?.side}
      data-visible={position === null ? "false" : "true"}
      className={cn(
        "fixed z-60 w-[min(88vw,20rem)] max-h-[min(70dvh,24rem)] overflow-y-auto rounded-lg border border-border/70 bg-popover p-3 text-popover-foreground shadow-xl ring-1 ring-foreground/5",
        position === null && "pointer-events-none invisible",
      )}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
    >
      <ProfileUsageSidecarContent
        profile={profile}
        entry={entry}
        isHostReady={isHostReady}
        now={now}
      />
    </aside>,
    document.body,
  );
}

function isRetryEntry(entry: ProfileDropdownUsageEntry): boolean {
  const projection = entry.projection;
  if (projection.kind === "stale") {
    return projection.unavailableReason === "fetch_failed";
  }
  if (projection.kind === "unavailable") {
    return projection.reason === "fetch_failed";
  }
  return false;
}

function ProfileUsageSidecarContent({
  profile,
  entry,
  isHostReady,
  now,
}: {
  readonly profile: ProviderProfile;
  readonly entry: ProfileDropdownUsageEntry;
  readonly isHostReady: boolean;
  readonly now: number;
}): ReactNode {
  const refreshing = entry.refreshStatus !== "idle";
  const refreshLabel = isRetryEntry(entry) ? "Retry" : "Refresh";
  return (
    <>
      <div className="flex min-w-0 items-start gap-2 border-b border-border/60 pb-2.5">
        <AccentDot
          profileId={profile.profileId}
          accentColor={profile.accentColor}
          label={null}
          variant="inline"
          size="default"
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-sm font-semibold">
            {profile.label}
          </div>
          <FreshnessLine entry={entry} now={now} />
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`${refreshLabel} usage for ${profile.label}`}
          aria-keyshortcuts="R"
          disabled={!isHostReady || refreshing}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void entry.refresh()}
        >
          {refreshing ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId="profile-usage-refresh-spinner"
              variant={undefined}
            />
          ) : null}
          {refreshLabel}
          <Kbd className="ml-0.5 font-mono">R</Kbd>
        </Button>
      </div>
      {!isHostReady ? (
        <p className="mt-2.5 rounded-md bg-muted/60 px-2 py-1.5 text-ui-xs text-muted-foreground">
          Run host unavailable. Cached usage is shown when available.
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-3">
        <ProfileUsageDetail entry={entry} now={now} />
      </div>
    </>
  );
}

function ProfileUsageDetail({
  entry,
  now,
}: {
  readonly entry: ProfileDropdownUsageEntry;
  readonly now: number;
}): ReactNode {
  const projection = entry.projection;
  switch (projection.kind) {
    case "detail":
      return <ProfileUsageWindows entry={entry} now={now} />;
    case "stale":
      return (
        <>
          <p className="text-ui-xs text-muted-foreground">
            {projection.unavailableReason === "fetch_failed"
              ? "Refresh failed. Showing last-known usage."
              : "Showing last-known usage."}
          </p>
          <ProfileUsageWindows entry={entry} now={now} />
        </>
      );
    case "semantic_only":
      return (
        <ProfileUsageEmptyState
          title={projection.severity === "limited" ? "Limited" : "Running low"}
          body="Detailed usage not loaded."
          tone={projection.severity === "limited" ? "destructive" : "warning"}
        />
      );
    case "not_checked":
      return (
        <ProfileUsageEmptyState
          title="Not checked yet"
          body="Refresh to load detailed usage for this profile."
          tone="neutral"
        />
      );
    case "unavailable":
      return (
        <ProfileUsageEmptyState
          title={
            projection.reason === "fetch_failed"
              ? "Couldn't refresh usage"
              : "Usage unavailable"
          }
          body="No detailed usage is available. Retry when the provider is reachable."
          tone="neutral"
        />
      );
  }
}

function ProfileUsageWindows({
  entry,
  now,
}: {
  readonly entry: ProfileDropdownUsageEntry;
  readonly now: number;
}): ReactNode {
  const projection = entry.projection;
  if (projection.kind !== "detail" && projection.kind !== "stale") return null;
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        projection.kind === "stale" && "opacity-60",
      )}
    >
      {projection.windows.map((window) => (
        <ProfileUsageWindowRow key={window.id} window={window} now={now} />
      ))}
    </div>
  );
}

function FreshnessLine({
  entry,
  now,
}: {
  readonly entry: ProfileDropdownUsageEntry;
  readonly now: number;
}): ReactNode {
  const checkedAt = entry.projection.checkedAt;
  let freshness = "Not checked";
  if (checkedAt !== null) {
    const prefix =
      entry.projection.kind === "stale" ? "Last checked" : "Checked";
    freshness = `${prefix} ${formatRelativeTimestamp(checkedAt, now)}`;
  }
  let activity: "Queued" | "Refreshing" | null = null;
  if (entry.refreshStatus === "queued") activity = "Queued";
  else if (entry.refreshStatus === "refreshing") activity = "Refreshing";
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-ui-xs text-muted-foreground">
      <span>{freshness}</span>
      {activity !== null ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{activity}</span>
        </>
      ) : null}
    </div>
  );
}

function formatWindowDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "Usage";
  if (minutes === MINUTES_PER_WEEK) return "Weekly";
  if (minutes === MINUTES_PER_SESSION) return "Current session";
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
  return `${minutes}m`;
}

function windowLabel(window: ProfileUsageWindow): string {
  const duration = formatWindowDuration(window.window.durationMinutes);
  return window.name === null ? duration : `${window.name} · ${duration}`;
}

function ProfileUsageWindowRow({
  window,
  now,
}: {
  readonly window: ProfileUsageWindow;
  readonly now: number;
}): ReactNode {
  const resetsAt = window.window.resetsAt;
  const percent = Math.round(
    Math.min(100, Math.max(0, window.window.usedPercent)),
  );
  const reset = formatWindowReset(resetsAt, now);
  return (
    <MeterRow
      label={windowLabel(window)}
      usedPercent={window.window.usedPercent}
      severity={window.severity}
      detail={
        <span className="flex flex-wrap items-center justify-end gap-1 text-right">
          <span>{percent}% used</span>
          {reset !== null ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{reset}</span>
            </>
          ) : null}
        </span>
      }
    />
  );
}

function formatWindowReset(
  resetsAt: number | null,
  now: number,
): string | null {
  if (resetsAt === null) return null;
  if (isFarReset(resetsAt, now))
    return `Resets ${formatResetDateTime(resetsAt)}`;
  return `Resets in ${formatResetCountdown(resetsAt, now)}`;
}

function ProfileUsageEmptyState({
  title,
  body,
  tone,
}: {
  readonly title: string;
  readonly body: string;
  readonly tone: "warning" | "destructive" | "neutral";
}): ReactNode {
  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-muted/35 px-2.5 py-2",
        tone === "warning" && "border-warning/30 bg-warning/10",
        tone === "destructive" && "border-destructive/30 bg-destructive/10",
      )}
    >
      <div
        className={cn(
          "text-ui-sm font-medium",
          tone === "warning" && "text-warning-foreground",
          tone === "destructive" && "text-destructive",
        )}
      >
        {title}
      </div>
      <p className="mt-0.5 text-ui-xs text-muted-foreground">{body}</p>
    </div>
  );
}
