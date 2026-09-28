import type { ComponentPropsWithRef, ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { HostLeaseStatus } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { UserMenu, UserMenuAvatar } from "@/components/auth/user-menu";
import { AppUpdateHeaderButton } from "@/components/layout/header/app-update-button";
import {
  HeaderResourceRegion,
  HeaderUsageRegion,
} from "@/components/layout/header/header-actions";
import { useRegionGhost } from "@/components/layout-editor/use-layout-region";
import { useBarPlacements, useRegionShown } from "@/lib/layout-overrides";
import { barClusterRegionsAt } from "@/lib/layout/layout-arrangement";
import { SignInButton } from "@/components/layout/header/sign-in-button";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { SideTabRowVariant } from "./side-tab-row";
import {
  SIDE_STRIP_ACCOUNT_ROW_CLASS,
  SIDE_STRIP_FOOT_CLASS,
  SIDE_STRIP_HOST_DOT_CLASS,
  SIDE_STRIP_NAV_TILE_CLASS,
  SIDE_TAB_HOVER_CLASS,
} from "./side-strip-tokens";

/**
 * What trails in the header, in the strip (S-03, D6): the update row while an
 * update is pending, the header-hosted readings (left cluster, then right),
 * and the account row that opens the user menu. Notifications and All tasks moved to
 * the top block. Only one of the header and the strip is ever mounted, so each
 * region's canvas node and each action registration stays single. Collapsed,
 * one centred column with the avatar tile last; all of it no-drag.
 */
export function SideStripFoot(props: {
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const collapsed = props.variant === "collapsed";
  return (
    <div
      data-testid="side-strip-foot"
      className={cn(
        SIDE_STRIP_FOOT_CLASS,
        "flex shrink-0 flex-col [-webkit-app-region:no-drag]",
        collapsed ? "items-center" : "items-stretch",
      )}
    >
      <AppUpdateHeaderButton layout={collapsed ? "icon" : "row"} />
      <SideStripReadings collapsed={collapsed} />
      <SideStripAccount variant={props.variant} />
    </div>
  );
}

/**
 * The header-hosted readings (usage, then resources, in the header's own
 * left-then-right order) as ONE row above the account row (F6): each an equal
 * share of the width, so two split it in half and one takes all of it.
 * Collapsed, they stack as rail-wide tiles. The regions stay mounted while
 * Hidden (the editor's ghost needs its host), so the row hides itself when
 * none of them draws.
 */
function SideStripReadings(props: { readonly collapsed: boolean }): ReactNode {
  const placements = useBarPlacements();
  const regions = [
    ...barClusterRegionsAt(placements, "header", "left"),
    ...barClusterRegionsAt(placements, "header", "right"),
  ];
  const drawn = {
    usageLimits: useRegionDrawn("usageLimits"),
    resourceMonitor: useRegionDrawn("resourceMonitor"),
  };
  const empty = !regions.some((region) => drawn[region]);
  // A 40px rail tile has no room for a reading, so it keeps the glyph.
  const form = props.collapsed ? "tile" : "readout";
  return (
    <div
      data-testid="side-strip-readings"
      className={cn(
        "gap-2",
        props.collapsed
          ? "flex w-10 flex-col"
          : "grid auto-cols-fr grid-flow-col",
        empty && "hidden",
      )}
    >
      {regions.map((region) =>
        region === "usageLimits" ? (
          <HeaderUsageRegion key={region} form={form} />
        ) : (
          <HeaderResourceRegion key={region} form={form} />
        ),
      )}
    </div>
  );
}

/** Whether a reading draws anything: shown, or ghosted by the editor. */
function useRegionDrawn(regionId: "usageLimits" | "resourceMonitor"): boolean {
  const shown = useRegionShown(regionId);
  const ghost = useRegionGhost(regionId);
  return shown || ghost;
}

function SideStripAccount(props: {
  readonly variant: SideTabRowVariant;
}): ReactNode {
  const profile = useAuthStore((state) => state.profile);
  const isSignedIn = useAuthStore((state) => state.status === "signed-in");
  if (!isSignedIn || profile === null) {
    return <SignInButton layout="compact" />;
  }
  const avatarUrl = profile.avatarUrl ?? null;
  return (
    <UserMenu
      userName={profile.userName}
      email={profile.email}
      avatarUrl={avatarUrl}
      showAppSettings
      trigger={
        <AccountRowButton
          variant={props.variant}
          userName={profile.userName}
          email={profile.email}
          avatarUrl={avatarUrl}
        />
      }
    />
  );
}

/**
 * The account row: the avatar with the host's health dot, the name, and the
 * host's name. Collapsed, the avatar tile alone. It is the
 * user menu's trigger, so it takes the trigger's props and ref.
 */
function AccountRowButton(
  props: ComponentPropsWithRef<"button"> & {
    readonly variant: SideTabRowVariant;
    readonly userName: string;
    readonly email: string;
    readonly avatarUrl: string | null;
  },
): ReactNode {
  const { variant, userName, email, avatarUrl, className, ...buttonProps } =
    props;
  const collapsed = variant === "collapsed";
  const host = useAccountHostReading();
  const avatar = (
    <span className="relative flex shrink-0">
      <UserMenuAvatar userName={userName} email={email} avatarUrl={avatarUrl} />
      <span
        role="img"
        aria-label={HOST_HEALTH_LABEL[host.health]}
        data-testid="side-strip-host-health"
        data-health={host.health}
        className={cn(SIDE_STRIP_HOST_DOT_CLASS, HOST_HEALTH_FILL[host.health])}
      />
    </span>
  );
  return (
    <button
      type="button"
      data-layout-passive
      data-testid="user-menu-trigger"
      aria-label={collapsed ? "Open user menu" : undefined}
      {...buttonProps}
      className={cn(
        "flex min-w-0 shrink-0 items-center text-left outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-foreground/8",
        SIDE_TAB_HOVER_CLASS,
        collapsed
          ? cn(SIDE_STRIP_NAV_TILE_CLASS, "justify-center")
          : cn(SIDE_STRIP_ACCOUNT_ROW_CLASS, "w-full"),
        className,
      )}
    >
      {avatar}
      {collapsed ? null : (
        <>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-ui-sm font-medium text-foreground">
              {userName}
            </span>
            {host.hostName === null ? null : (
              <span
                data-testid="side-strip-host-line"
                className="truncate text-ui-xs text-muted-foreground"
              >
                {host.hostName}
              </span>
            )}
          </span>
          <ChevronsUpDown
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </>
      )}
    </button>
  );
}

type HostHealth = "ready" | "pending" | "down" | "unknown";

const HOST_HEALTH_FILL: Readonly<Record<HostHealth, string>> = {
  ready: "bg-success",
  pending: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground",
};

const HOST_HEALTH_LABEL: Readonly<Record<HostHealth, string>> = {
  ready: "Host connected",
  pending: "Host connecting",
  down: "Host unavailable",
  unknown: "No host",
};

function hostHealthOf(status: HostLeaseStatus | null): HostHealth {
  switch (status) {
    case "ready":
      return "ready";
    case "connecting":
    case "degraded":
    case "restarting-expected":
      return "pending";
    case "dead":
      return "down";
    case null:
      return "unknown";
  }
}

/** The app-wide host's health and name, for the account row. */
function useAccountHostReading(): {
  readonly health: HostHealth;
  readonly hostName: string | null;
} {
  const hostId = useEffectiveHostId();
  const entry = useHostDirectoryEntry(hostId);
  const lease = useHostLease(hostId);
  return {
    health: hostHealthOf(lease?.status ?? null),
    hostName: entry?.label ?? null,
  };
}
