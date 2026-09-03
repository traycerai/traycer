import type { ReactNode } from "react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useHostQueriesWithResponseMap } from "@/hooks/host/use-host-queries";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";
import {
  PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS,
  useVisibleRateLimitProviders,
  type ConfiguredRateLimitProvider,
} from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useRateLimitResolveHostScope } from "@/hooks/rate-limits/use-rate-limit-host-scope";
import {
  resolveRateLimitProfileId,
  useRateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";
import {
  HostRuntimeContext,
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { isMobileApp } from "@/lib/mobile-app";
import {
  providerDisplayName,
  sortProviderStatesByProviderOrder,
} from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  mapResponseToProviderRateLimitEnvelope,
  resolveRetainedProviderRateLimits,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import {
  isWindowedRateLimitProvider,
  providerWindowEntries,
  type RateLimitWindowEntry,
} from "@/lib/rate-limits/rate-limit-window-catalog";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import {
  useLayoutStore,
  type ResourceMetric,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

function trackLayoutSetting(setting: AnalyticsSetting): void {
  trackSettingChanged("layout", setting);
}

/**
 * Where the app's own chrome sits and how much of it shows, one group per
 * surface.
 *
 * The page exists because these controls answer a different question from
 * Appearance's ("where does this live", not "what does it look like") and
 * because they accumulate: a per-provider, per-window visibility list needs
 * room, and General and Appearance were already collecting layout toggles one
 * at a time. Group order is fixed - Status bar, then Composer when it has rows,
 * then Chat, then Sidebar - so a control keeps its place as groups arrive.
 */
export function LayoutSettingsPanel(): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <SettingsPanelShell
      title="Layout"
      description="Where the app's chrome sits and how much of it shows."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <StatusBarLayoutGroup />
        <ChatLayoutGroup />
        <SidebarLayoutGroup />
      </div>
    </SettingsPanelShell>
  );
}

// ── status bar ──────────────────────────────────────────────────────────────

function StatusBarLayoutGroup(): ReactNode {
  // The footer cannot render in the installed mobile app at all (the mobile
  // header keeps the gauge and the resource monitor), so every control in this
  // group would configure a surface that is never drawn. The group stays
  // present rather than vanishing, because a page whose first heading differs
  // per build reads as a broken build.
  if (isMobileApp()) {
    return (
      <SettingsGroup
        title="Status bar"
        tone="default"
        dataTestId="layout-status-bar-group"
        fill={false}
      >
        <SettingsRow
          label="Status bar is desktop-only"
          description="The mobile app keeps usage limits and the resource monitor in its header."
          control={null}
        />
      </SettingsGroup>
    );
  }
  return <StatusBarLayoutGroupContent />;
}

function StatusBarLayoutGroupContent(): ReactNode {
  const statusBar = useLayoutStore((state) => state.statusBar);
  const setPlacement = useLayoutStore((state) => state.setStatusBarPlacement);
  const setRateLimitsEnabled = useLayoutStore(
    (state) => state.setStatusBarRateLimitsEnabled,
  );
  const setPercentMode = useLayoutStore(
    (state) => state.setStatusBarPercentMode,
  );
  const setShowTimer = useLayoutStore((state) => state.setStatusBarShowTimer);
  const setShowBar = useLayoutStore((state) => state.setStatusBarShowBar);
  const setResourcesEnabled = useLayoutStore(
    (state) => state.setStatusBarResourcesEnabled,
  );
  const setResourceScope = useLayoutStore(
    (state) => state.setStatusBarResourceScope,
  );
  const toggleResourceMetric = useLayoutStore(
    (state) => state.toggleStatusBarResourceMetric,
  );
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
  const setShowGlobalResourceMonitor = useSettingsStore(
    (state) => state.setShowGlobalResourceMonitor,
  );
  const { rateLimits, resources } = statusBar;
  const desktopAppScope = resources.scope === "desktop-app";

  return (
    <SettingsGroup
      title="Status bar"
      tone="default"
      dataTestId="layout-status-bar-group"
      fill={false}
    >
      <SettingsRow
        label="Placement"
        description="Where usage limits and the resource monitor live."
        control={
          <SettingsSegmentedControl
            value={statusBar.placement}
            options={[
              { value: "header", label: "Header" },
              { value: "status-bar", label: "Status bar" },
            ]}
            onChange={(placement) => {
              trackLayoutSetting("layout.statusBar.placement");
              setPlacement(placement);
            }}
            ariaLabel="Placement"
          />
        }
      />
      {/* Relocated from General, and shown only in header placement: in the
        status bar the footer's own `Show resource monitor` governs the same
        thing, and two switches over one segment is one of them lying. */}
      {statusBar.placement === "header" ? (
        <SettingsRow
          label="Show resource monitor in header"
          description="Show the app-wide resource monitor beside the usage gauge."
          control={
            <Switch
              checked={showGlobalResourceMonitor}
              onCheckedChange={(value) => {
                trackLayoutSetting("showGlobalResourceMonitor");
                setShowGlobalResourceMonitor(value);
              }}
              aria-label="Show resource monitor in header"
            />
          }
        />
      ) : null}

      <StatusBarSubheading label="Rate limits" />
      <SettingsRow
        label="Show rate limits"
        description="Show one segment per provider with a window still reporting."
        control={
          <Switch
            checked={rateLimits.enabled}
            onCheckedChange={(value) => {
              trackLayoutSetting("layout.statusBar.rateLimits.enabled");
              setRateLimitsEnabled(value);
            }}
            aria-label="Show rate limits"
          />
        }
      />
      <SettingsRow
        label="Percentage"
        description="Show how much is used, or how much remains."
        control={
          <SettingsSegmentedControl
            value={rateLimits.percentMode}
            options={[
              { value: "used", label: "Used" },
              { value: "remaining", label: "Remaining" },
            ]}
            onChange={(percentMode) => {
              trackLayoutSetting("layout.statusBar.rateLimits.percentMode");
              setPercentMode(percentMode);
            }}
            ariaLabel="Percentage"
          />
        }
      />
      <SettingsRow
        label="Show reset timer"
        description="Count down to each window's reset. Off shows the window's name (5h, wk)."
        control={
          <Switch
            checked={rateLimits.showTimer}
            onCheckedChange={(value) => {
              trackLayoutSetting("layout.statusBar.rateLimits.showTimer");
              setShowTimer(value);
            }}
            aria-label="Show reset timer"
          />
        }
      />
      <SettingsRow
        label="Show usage bar"
        description="Draw a small fill bar ahead of each provider's windows."
        control={
          <Switch
            checked={rateLimits.showBar}
            onCheckedChange={(value) => {
              trackLayoutSetting("layout.statusBar.rateLimits.showBar");
              setShowBar(value);
            }}
            aria-label="Show usage bar"
          />
        }
      />
      <StatusBarRateLimitProviders />

      <StatusBarSubheading label="Resource monitor" />
      <SettingsRow
        label="Show resource monitor"
        description="Show the watched host's CPU, memory and process numbers."
        control={
          <Switch
            checked={resources.enabled}
            onCheckedChange={(value) => {
              trackLayoutSetting("layout.statusBar.resources.enabled");
              setResourcesEnabled(value);
            }}
            aria-label="Show resource monitor"
          />
        }
      />
      <SettingsRow
        label="Scope"
        description="Traycer's processes on the watched host, or this desktop app. RAM share is only available for the host scope."
        control={
          <SettingsSegmentedControl
            value={resources.scope}
            options={[
              { value: "host-tree", label: "Host" },
              { value: "desktop-app", label: "Desktop app" },
            ]}
            onChange={(scope) => {
              trackLayoutSetting("layout.statusBar.resources.scope");
              setResourceScope(scope);
            }}
            ariaLabel="Scope"
          />
        }
      />
      {RESOURCE_METRIC_ROWS.map((metric) => {
        // RAM share is this host's processes measured against that machine's
        // total memory - a number the desktop-app scope has no denominator
        // for, so the switch is disabled rather than silently reading zero.
        const unavailable = metric.metric === "ramShare" && desktopAppScope;
        return (
          <SettingsRow
            key={metric.metric}
            label={metric.label}
            description={metric.description}
            hint={
              unavailable
                ? "RAM share is only available for the host scope."
                : undefined
            }
            control={
              <Switch
                checked={resources.metrics.includes(metric.metric)}
                disabled={unavailable}
                onCheckedChange={() => {
                  trackLayoutSetting("layout.statusBar.resources.metric");
                  toggleResourceMetric(metric.metric);
                }}
                aria-label={metric.label}
              />
            }
          />
        );
      })}
    </SettingsGroup>
  );
}

interface ResourceMetricRow {
  readonly metric: ResourceMetric;
  readonly label: string;
  readonly description: string;
}

const RESOURCE_METRIC_ROWS: ReadonlyArray<ResourceMetricRow> = [
  {
    metric: "cpu",
    label: "CPU",
    description: "Processor share across the measured processes.",
  },
  {
    metric: "memory",
    label: "Memory",
    description: "Resident memory across the measured processes.",
  },
  {
    metric: "processes",
    label: "Processes",
    description: "How many processes are being measured.",
  },
  {
    metric: "ramShare",
    label: "RAM share of host",
    description: "Measured memory as a share of the host machine's total.",
  },
];

/**
 * A named band inside one group's card. The status bar is a single layout
 * slice, so its controls belong to one `SettingsGroup`; rate limits and the
 * resource monitor are two subjects inside it, and an `h3` says so without
 * splitting the slice into groups that would then read as separate surfaces.
 */
function StatusBarSubheading(props: { readonly label: string }): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <h3
      className={cn(
        "border-b border-border/40 font-semibold text-ui-xs text-muted-foreground uppercase",
        compact ? "px-4 py-2" : "px-5 py-2.5",
      )}
    >
      {props.label}
    </h3>
  );
}

// ── rate-limit provider list ────────────────────────────────────────────────

/**
 * The provider rows, read through the WATCHED host rather than the app-wide
 * one - the same binding swap the header gauge makes, for the same reason: the
 * list must be what the footer can actually show, and a page listing host A's
 * providers under a footer reading host B is the failure this scoping exists
 * to prevent.
 *
 * The provider is mounted unconditionally so a pick resolving does not change
 * the element type at this position and remount the rows (see
 * `RateLimitIconButton`), and the rows themselves are only mounted while the
 * subtree is genuinely bound to the host being described.
 */
function StatusBarRateLimitProviders(): ReactNode {
  const { scope, hasExplicitPick } = useRateLimitResolveHostScope();
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const scopedToOwnHost = !hasExplicitPick || isHostScopeUsable(scope.status);
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      {scopedToOwnHost ? (
        <ScopedStatusBarRateLimitProviders />
      ) : (
        <UnresolvedWatchHostRow scope={scope} />
      )}
    </HostRuntimeContext.Provider>
  );
}

function UnresolvedWatchHostRow(props: {
  readonly scope: HostScope;
}): ReactNode {
  return (
    <SettingsRow
      label="Providers"
      description={`Can't reach ${props.scope.hostLabel} right now, so its providers aren't listed. The status bar shows the same providers as soon as it answers.`}
      control={null}
    />
  );
}

interface StatusBarProviderRow {
  readonly providerId: RateLimitProviderId;
  readonly label: string;
  /** The profile whose reading this row describes, for the row's subtitle. */
  readonly profileLabel: string;
  readonly windows: ReadonlyArray<RateLimitWindowEntry>;
}

function ScopedStatusBarRateLimitProviders(): ReactNode {
  const rows = useStatusBarProviderRows();
  const hiddenProviders = useLayoutStore(
    (state) => state.statusBar.rateLimits.hiddenProviders,
  );
  const hiddenWindowKeys = useLayoutStore(
    (state) => state.statusBar.rateLimits.hiddenWindowKeys,
  );
  const toggleProvider = useLayoutStore(
    (state) => state.toggleStatusBarProvider,
  );
  const toggleWindow = useLayoutStore((state) => state.toggleStatusBarWindow);

  if (rows.length === 0) {
    return (
      <SettingsRow
        label="Providers"
        description="No provider on the watched host reports a usage window yet."
        control={null}
      />
    );
  }

  return (
    <>
      {rows.map((row) => {
        const hidden = hiddenProviders.includes(row.providerId);
        return (
          <div key={row.providerId}>
            <SettingsRow
              label={row.label}
              description={providerRowDescription(row)}
              control={
                <Switch
                  checked={!hidden}
                  onCheckedChange={() => {
                    trackLayoutSetting(
                      "layout.statusBar.rateLimits.provider",
                    );
                    toggleProvider(row.providerId);
                  }}
                  aria-label={row.label}
                />
              }
            />
            {/* A hidden provider collapses its windows: those toggles govern
              what a segment that is not drawn would have contained. */}
            {hidden ? null : (
              <div className="pl-4">
                {row.windows.map((window) => (
                  <SettingsRow
                    key={window.windowKey}
                    label={window.label}
                    control={
                      <Switch
                        checked={!hiddenWindowKeys.includes(window.windowKey)}
                        onCheckedChange={() => {
                          trackLayoutSetting(
                            "layout.statusBar.rateLimits.window",
                          );
                          toggleWindow(window.windowKey);
                        }}
                        aria-label={`${row.label} ${window.label}`}
                      />
                    }
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function providerRowDescription(row: StatusBarProviderRow): string {
  // Keys are stable, so a provider with no reading yet still toggles - the
  // subtitle says why its windows are missing rather than the row implying
  // the provider reports none.
  if (row.windows.length === 0) {
    return `${row.profileLabel} · waiting for first reading`;
  }
  const windows =
    row.windows.length === 1 ? "1 window" : `${row.windows.length} windows`;
  return `${row.profileLabel} · ${windows}`;
}

/**
 * One row per visible provider that reports rolling windows, in
 * `ORDERED_PROVIDERS` order, each carrying whatever windows its retained
 * envelope holds.
 *
 * Every query here is a passive observer (`PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS`):
 * opening this page, and toggling anything on it, must never spawn a provider
 * read. The footer and the popover own the fetching; this list reflects what
 * they already wrote into the shared cache, and a provider with nothing there
 * yet renders its "waiting" subtitle instead.
 */
function useStatusBarProviderRows(): ReadonlyArray<StatusBarProviderRow> {
  const client = useHostClient();
  const profileSelection = useRateLimitProfileSelection();
  const visibleProviders = useVisibleRateLimitProviders();
  const providers = sortProviderStatesByProviderOrder(
    visibleProviders.filter((provider) =>
      isWindowedRateLimitProvider(provider.providerId),
    ),
  );
  const targets = providers.map((provider) => ({
    provider,
    profileId: resolveRateLimitProfileId(
      profileSelection,
      provider.providerId,
      provider.profiles,
    ),
  }));

  const results = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    requests: targets.map((target) => {
      const { method, params } = providerRateLimitQueryOptions(
        target.provider.providerId,
        target.profileId,
        false,
      );
      return { method, params };
    }),
    options: PASSIVE_PROVIDER_RATE_LIMIT_OPTIONS,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });

  return targets.map((target, index) => {
    const rateLimits = resolveRetainedProviderRateLimits(
      results[index].data ?? null,
    );
    return {
      providerId: target.provider.providerId,
      label: providerDisplayName(target.provider.providerId),
      profileLabel: profileLabelFor(target.provider, target.profileId),
      windows: rateLimits === null ? [] : providerWindowEntries(rateLimits),
    };
  });
}

function profileLabelFor(
  provider: ConfiguredRateLimitProvider,
  profileId: string | null,
): string {
  if (profileId === null) return "ambient";
  return (
    provider.profiles.find(
      (profile) =>
        profile.kind === "managed" && profile.profileId === profileId,
    )?.label ?? "ambient"
  );
}

// ── chat & sidebar ──────────────────────────────────────────────────────────

/**
 * The message pane's own layout. Both controls describe the pane rather than
 * the composer bar, which is why they are here and not in the composer group
 * that lands beside this one later.
 */
function ChatLayoutGroup(): ReactNode {
  const pinContextUsageBreakdown = useSettingsStore(
    (state) => state.pinContextUsageBreakdown,
  );
  const setPinContextUsageBreakdown = useSettingsStore(
    (state) => state.setPinContextUsageBreakdown,
  );
  const chatTurnMinimapSide = useSettingsStore(
    (state) => state.chatTurnMinimapSide,
  );
  const setMinimapSide = useSettingsStore((state) => state.setMinimapSide);
  return (
    <SettingsGroup
      title="Chat"
      tone="default"
      dataTestId="layout-chat-group"
      fill={false}
    >
      <SettingsRow
        label="Pin context breakdown"
        description="Keep the context window breakdown visible near the chat composer when usage data is available."
        control={
          <Switch
            checked={pinContextUsageBreakdown}
            onCheckedChange={(value) => {
              trackLayoutSetting("pinContextUsageBreakdown");
              setPinContextUsageBreakdown(value);
            }}
            aria-label="Pin context breakdown"
          />
        }
      />
      <SettingsRow
        label="Minimap side"
        description="Place chat and artifact minimaps on the left or right, or hide both."
        control={
          <Select
            value={chatTurnMinimapSide}
            onValueChange={(value) => {
              if (value !== "left" && value !== "right" && value !== "hide") {
                return;
              }
              trackLayoutSetting("chatTurnMinimapSide");
              setMinimapSide(value);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Minimap side"
              className="w-[min(40vw,8rem)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="right">Right</SelectItem>
              <SelectItem value="left">Left</SelectItem>
              <SelectItem value="hide">Hide</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroup>
  );
}

/**
 * The sidebar's own layout. One row today; panel visibility and order join it
 * from the same store the rail's right-click menu writes.
 */
function SidebarLayoutGroup(): ReactNode {
  const showNavigatorResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const setShowNavigatorResourceStats = useSettingsStore(
    (state) => state.setShowNavigatorResourceStats,
  );
  return (
    <SettingsGroup
      title="Sidebar"
      tone="default"
      dataTestId="layout-sidebar-group"
      fill={false}
    >
      <SettingsRow
        label="Show resource chips on sidebar rows"
        description="Show compact live CPU and memory chips in task navigator rows."
        control={
          <Switch
            checked={showNavigatorResourceStats}
            onCheckedChange={(value) => {
              trackLayoutSetting("showNavigatorResourceStats");
              setShowNavigatorResourceStats(value);
            }}
            aria-label="Show resource chips on sidebar rows"
          />
        }
      />
    </SettingsGroup>
  );
}
