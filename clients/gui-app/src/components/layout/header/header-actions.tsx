import type { ReactNode } from "react";
import { UserMenu } from "@/components/auth/user-menu";
import { SignInButton } from "@/components/layout/header/sign-in-button";
import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { GhostRegionPicture } from "@/components/layout-editor/ghost-region";
import { LayoutRegionContextMenu } from "@/components/layout-editor/region-quick-verbs";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import {
  useBarPlacements,
  useRegionShown,
  useRegionValues,
} from "@/lib/layout-overrides";
import {
  barClusterRegionsAt,
  type EdgeSide,
} from "@/lib/layout/layout-arrangement";
import { cn } from "@/lib/utils";
import type { BarReadingForm } from "@/components/layout/tabs/side-strip/side-strip-tokens";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

/**
 * One end of the header's own row: the readings that named THIS bar and this
 * side (L-156).
 *
 * The header's half of "each reading picks its bar and its side". Under the
 * shipped arrangement both are in the strip and both clusters are empty; a
 * reading moved up draws here, and the other one stays exactly where it was,
 * which is the whole point of the four fields.
 *
 * The DESKTOP header's half only: `MobileAppHeader` keeps both controls
 * unconditionally, because a mobile viewport does not answer this question
 * with a host at all - the footer there is its own opt-in switch (L-51), and a
 * header that respected `status-bar` would leave a phone with neither control
 * until someone found that switch.
 */
export function HeaderBarCluster(props: {
  readonly side: EdgeSide;
}): ReactNode {
  const placements = useBarPlacements();
  // The header has the room for the readings, so `inline` is the default;
  // each region's own Display fine-tune row (only offered while Location is
  // the Tab strip) can still ask for the icon-only glyph instead (G6
  // overturned in part).
  return barClusterRegionsAt(placements, "header", props.side).map((region) =>
    region === "usageLimits" ? (
      <HeaderUsageRegion key={region} form="inline" />
    ) : (
      <HeaderResourceRegion key={region} form="inline" />
    ),
  );
}

/**
 * The usage gauge in the header.
 *
 * `display: contents` generates no box, so `getBoundingClientRect()` answers
 * 0,0,0,0 and the travelling ring collapsed to a 6px dot at the top-left of
 * the window while the hover outline had nothing to paint on (C-06). A session
 * needs a real box here and the header needs none of its own, so this is the
 * mic slot's pattern: the region's children keep laying out in the header's
 * own cluster at rest, and become a box of their own exactly while the editor
 * is open.
 *
 * The span is this region's canvas node in BOTH bars, named by region id, so
 * the ring, the chip and the quick verbs follow it up here unchanged - the
 * button it wraps registers nothing of its own, which is why the picture below
 * is the un-registering one (two elements on one key displace each other).
 */
export function HeaderUsageRegion(props: {
  /** How the button draws: the header's readings, or the strip's (F6). */
  readonly form: BarReadingForm;
}): ReactNode {
  const shown = useRegionShown("usageLimits");
  const display = useRegionValues("usageLimits").display;
  const { ref, editing } = useLayoutRegion({
    regionId: "usageLimits",
    instanceId: null,
  });
  // Icon only downgrades the header's `inline` readings, and the expanded
  // side strip's `readout` readings (F6), to the glyph; the collapsed rail's
  // own `tile` form is untouched - it is already the compact one.
  const form =
    display === "icon" && (props.form === "inline" || props.form === "readout")
      ? "glyph"
      : props.form;
  return (
    // The cluster has no menu of its own, so this is the whole menu (L-19); it
    // names `usageLimits` because that is the region this element registers.
    <LayoutRegionContextMenu regionId="usageLimits">
      <span
        ref={ref}
        className={cn(
          editing ? "inline-flex items-center gap-2 empty:hidden" : "contents",
        )}
      >
        {shown ? <RateLimitIconButton form={form} /> : null}
        {/* Hidden and pointed at: the passive depiction in place, never the
          live control - it fetches (L-14, L-62). */}
        {shown ? null : <GhostRegionPicture regionId="usageLimits" />}
      </span>
    </LayoutRegionContextMenu>
  );
}

/**
 * The resource monitor in the header, which since L-156 is its own decision
 * rather than a passenger on the usage cluster's.
 *
 * Its own `shown` still gates the button on top of the placement: the two
 * answer different questions ("do I want a resource monitor at all" vs "where
 * do I want it"), and one switch owns the first everywhere the monitor is
 * drawn (L-48).
 *
 * Unconditionally the owner of `app.resources.open`: the strip draws the
 * monitor only while `resourceHost` names the strip, so the two can never both
 * be mounted on a desktop viewport.
 */
export function HeaderResourceRegion(props: {
  /** How the button draws: the header's readings, or the strip's (F6). */
  readonly form: BarReadingForm;
}): ReactNode {
  const shown = useRegionShown("resourceMonitor");
  const display = useRegionValues("resourceMonitor").display;
  const { ref, editing } = useLayoutRegion({
    regionId: "resourceMonitor",
    instanceId: null,
  });
  // Icon only downgrades the header's `inline` readings, and the expanded
  // side strip's `readout` readings (F6), to the glyph; the collapsed rail's
  // own `tile` form is untouched - it is already the compact one.
  const form =
    display === "icon" && (props.form === "inline" || props.form === "readout")
      ? "glyph"
      : props.form;
  return (
    <LayoutRegionContextMenu regionId="resourceMonitor">
      <span
        ref={ref}
        className={cn(
          editing ? "inline-flex items-center gap-2 empty:hidden" : "contents",
        )}
      >
        {shown ? (
          <ResourceMonitorPopover
            trigger="header-button"
            form={form}
            claimsOpenAction
          />
        ) : null}
        {/* The passive depiction, never the live segment - it streams (L-62). */}
        {shown ? null : <GhostRegionPicture regionId="resourceMonitor" />}
      </span>
    </LayoutRegionContextMenu>
  );
}

// Hiding the bell when signed-out keeps the notifications-store +
// runner-host subscriptions from mounting for a signed-out session.
//
// `admitsLocalPlane`, not `status === "signed-in"`: the notification centre
// is a LOCAL-plane surface with cloud lanes inside it. For an `unverified`
// session the session provider deliberately keeps the host-notification and
// agent-activity lanes running and withholds only the cloud-backed ones
// behind its own verdict gate - and on a desktop-width header this bell is
// the ONLY entry point to those lanes, so gating it on the cloud verdict left
// locally served failures, approvals and agent activity accumulating with no
// way to see or act on them. Found in review.
export function HeaderNotificationsBell(): ReactNode {
  const admitted = useAuthStore((state) => admitsLocalPlane(state.status));
  if (!admitted) {
    return null;
  }
  return <NotificationsBell />;
}

export interface HeaderIdentityProps {
  readonly showAppSettings: boolean;
}

export function HeaderIdentity(props: HeaderIdentityProps): ReactNode {
  const profile = useAuthStore((state) => state.profile);
  const isSignedIn = useAuthStore((state) => state.status === "signed-in");
  if (isSignedIn && profile !== null) {
    return (
      <UserMenu
        userName={profile.userName}
        email={profile.email}
        avatarUrl={profile.avatarUrl ?? null}
        showAppSettings={props.showAppSettings}
        trigger={null}
      />
    );
  }
  return <SignInButton layout="compact" />;
}
