import type { ReactNode } from "react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import { SettingsSubgroup } from "@/components/settings/controls/settings-subgroup";
import {
  SettingsToggleChips,
  type SettingsToggleChip,
} from "@/components/settings/controls/settings-toggle-chips";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { StatusBarPreview } from "@/components/settings/panels/layout/status-bar-preview";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
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
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  HostRuntimeContext,
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { isMobileApp } from "@/lib/mobile-app";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
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

/**
 * Everything about the app's bottom strip, as one group whose subjects are
 * nested rather than listed.
 *
 * The flat list this replaces put a preview-less placement toggle, four display
 * switches, a switch per provider, a switch per window and four metric switches
 * at one indentation level, where the only thing saying which switch governed
 * which was reading order. Two things fix that together and neither would
 * alone: an inset card per subject, so containment is drawn instead of implied;
 * and a preview at the top, so the answer to "what does this one do" is on
 * screen rather than one placement flip and one window resize away.
 */
export function StatusBarLayoutGroup(): ReactNode {
  // The footer cannot render in the installed mobile app at all (the mobile
  // header keeps the gauge and the resource monitor), so every control about
  // the footer would configure a surface that is never drawn. The group stays
  // present rather than vanishing, because a page whose first heading differs
  // per build reads as a broken build.
  if (isMobileApp()) return <MobileStatusBarLayoutGroup />;
  return <StatusBarLayoutGroupContent />;
}

/**
 * What is left of the group on a build with no footer: the note, plus the one
 * row that was never about the footer.
 *
 * `Show resource monitor in header` governs `MobileAppHeader`'s own
 * `ResourceMonitorPopover`, which that build genuinely draws - and its store
 * key is device-local, so a flip made on a desktop never reaches the phone.
 * Collapsing it with the rest would leave the preference stuck at its default
 * on the one build where header width is scarcest. It carries no placement
 * condition here because there is no other placement to defer to.
 *
 * The preview collapses with the rest, for the same reason every other footer
 * control does: it is a picture of a surface this build never draws.
 */
function MobileStatusBarLayoutGroup(): ReactNode {
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
  const setShowGlobalResourceMonitor = useSettingsStore(
    (state) => state.setShowGlobalResourceMonitor,
  );
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
    </SettingsGroup>
  );
}

/**
 * The whole group, under ONE resolution of the watched host.
 *
 * The preview and the provider list describe the same machine, so they are
 * bound to it once, here, rather than each resolving its own scope - two
 * resolutions is how a page ends up previewing host A above a list of host B's
 * providers. The provider is mounted unconditionally so a pick resolving does
 * not change the element type at this position and remount everything below it
 * (see `RateLimitIconButton`); what the gate governs is which children are
 * mounted, never whether the context exists.
 */
function StatusBarLayoutGroupContent(): ReactNode {
  const statusBar = useLayoutStore((state) => state.statusBar);
  const setPlacement = useLayoutStore((state) => state.setStatusBarPlacement);
  const setRateLimitsEnabled = useLayoutStore(
    (state) => state.setStatusBarRateLimitsEnabled,
  );
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
  const setShowGlobalResourceMonitor = useSettingsStore(
    (state) => state.setShowGlobalResourceMonitor,
  );
  const narrowViewport = useIsMobileViewport();
  const { scope, hasExplicitPick } = useRateLimitResolveHostScope();
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const scopedToOwnHost = !hasExplicitPick || isHostScopeUsable(scope.status);
  const { rateLimits } = statusBar;

  return (
    <SettingsGroup
      title="Status bar"
      tone="default"
      dataTestId="layout-status-bar-group"
      fill={false}
    >
      <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
        {/* No preview under an unresolved pick: it would be the ambient host's
          readings drawn under the picked host's caption. The notice inside the
          provider list is the page's one explanation of that state. */}
        {scopedToOwnHost ? (
          <StatusBarPreview scope={scope} hasExplicitPick={hasExplicitPick} />
        ) : null}
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
        {/* Relocated from General, and shown whenever the HEADER is the
          surface drawing that monitor: in the status bar the group's own
          `Show resource monitor` governs the same thing, and two switches over
          one segment is one of them lying.

          The viewport is the second half of that question and not a second
          question. Below `md` the shell drops the strip whatever `placement`
          says (`AppShell`) and `MobileAppHeader` keeps this monitor, so a
          desktop window narrowed into a split screen would otherwise leave the
          only monitor on screen with no switch anywhere - the group's own
          `Show resource monitor` governs a strip that is not drawn.
          `MobileStatusBarLayoutGroup` makes exactly this argument for the
          installed app. The GROUP stays on the build rather than the viewport:
          a temporarily narrow window must not hide the placement setting.

          So below `md` under `status-bar` placement BOTH switches are on
          screen, which is the exception to the rule above and is deliberate:
          the alternative is neither. Nothing here says which one is currently
          live, because it is not this row's to say - every other control in
          the group configures that undrawn strip too, and the preview's
          caption above is the page's one answer for all of them. */}
        {statusBar.placement === "header" || narrowViewport ? (
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

        <SettingsSubgroup
          title="Usage limits"
          description="One segment per provider with a limit still reporting."
          icon={null}
          level={3}
          open={rateLimits.enabled}
          dataTestId="layout-usage-limits-subgroup"
          control={
            <Switch
              checked={rateLimits.enabled}
              onCheckedChange={(value) => {
                trackLayoutSetting("layout.statusBar.rateLimits.enabled");
                setRateLimitsEnabled(value);
              }}
              aria-label="Show usage limits"
            />
          }
        >
          <UsageDisplaySubgroup />
          <UsageProvidersBand
            hostLabel={scope.hostLabel}
            scopedToOwnHost={scopedToOwnHost}
            scope={scope}
          />
        </SettingsSubgroup>

        <ResourceMonitorSubgroup />
      </HostRuntimeContext.Provider>
    </SettingsGroup>
  );
}

// ── usage limits ▸ display ──────────────────────────────────────────────────

/**
 * How a reading is WRITTEN, as opposed to which readings there are. Every row
 * here is also a rung of the strip's collapse ladder: one already switched off
 * is a rung the strip skips, because taking away something invisible frees no
 * width.
 */
function UsageDisplaySubgroup(): ReactNode {
  const rateLimits = useLayoutStore((state) => state.statusBar.rateLimits);
  const setPercentMode = useLayoutStore(
    (state) => state.setStatusBarPercentMode,
  );
  const setShowTimer = useLayoutStore((state) => state.setStatusBarShowTimer);
  const setShowBar = useLayoutStore((state) => state.setStatusBarShowBar);
  const setShowModeWord = useLayoutStore(
    (state) => state.setStatusBarShowModeWord,
  );
  return (
    <SettingsSubgroup
      title="Display"
      description="What each reading spells out, before the strip runs out of room."
      icon={null}
      control={null}
      level={4}
      open
      dataTestId="layout-usage-display-subgroup"
    >
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
        label="Show used / remaining label"
        description="Spell out the word after each percentage. Off leaves the number alone."
        control={
          <Switch
            checked={rateLimits.showModeWord}
            onCheckedChange={(value) => {
              trackLayoutSetting("layout.statusBar.rateLimits.showModeWord");
              setShowModeWord(value);
            }}
            aria-label="Show used / remaining label"
          />
        }
      />
      <SettingsRow
        label="Show reset timer"
        description="Count down to each limit's reset. Off shows the limit's name (5h, wk)."
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
        label="Show mini bar"
        description="Draw a small fill bar ahead of each provider's limits."
        control={
          <Switch
            checked={rateLimits.showBar}
            onCheckedChange={(value) => {
              trackLayoutSetting("layout.statusBar.rateLimits.showBar");
              setShowBar(value);
            }}
            aria-label="Show mini bar"
          />
        }
      />
    </SettingsSubgroup>
  );
}

// ── usage limits ▸ providers ────────────────────────────────────────────────

/**
 * A band label rather than a third card: the providers below it are already
 * cards, and a card holding nothing but more cards adds a border for no subject
 * of its own.
 *
 * It is also where the watched host gets named. The list is read through THAT
 * host's binding, and without the name a page under an explicit pick lists one
 * machine's providers with nothing on screen saying whose they are.
 */
function UsageProvidersBand(props: {
  readonly hostLabel: string;
  readonly scopedToOwnHost: boolean;
  readonly scope: HostScope;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <>
      <h4
        className={cn(
          "border-b border-border/40 font-semibold text-ui-xs text-muted-foreground uppercase",
          compact ? "px-3 py-2" : "px-4 py-2.5",
        )}
      >
        {`Providers on ${props.hostLabel}`}
      </h4>
      {props.scopedToOwnHost ? (
        <ScopedStatusBarRateLimitProviders />
      ) : (
        <UnresolvedWatchHostRow scope={props.scope} />
      )}
    </>
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

/**
 * One card per visible provider, holding the two things that are about that
 * provider alone: whether it shows every window or only its tightest, and which
 * of its windows count as visible at all.
 */
function ScopedStatusBarRateLimitProviders(): ReactNode {
  const rows = useStatusBarProviderRows();
  const hiddenProviders = useLayoutStore(
    (state) => state.statusBar.rateLimits.hiddenProviders,
  );
  const hiddenWindowKeys = useLayoutStore(
    (state) => state.statusBar.rateLimits.hiddenWindowKeys,
  );
  const expandedProviders = useLayoutStore(
    (state) => state.statusBar.rateLimits.expandedProviders,
  );
  const toggleProvider = useLayoutStore(
    (state) => state.toggleStatusBarProvider,
  );
  const toggleWindow = useLayoutStore((state) => state.toggleStatusBarWindow);
  const toggleExpandedProvider = useLayoutStore(
    (state) => state.toggleStatusBarExpandedProvider,
  );

  if (rows.length === 0) {
    return (
      <SettingsRow
        label="Providers"
        description="No provider on the watched host reports a usage limit yet."
        control={null}
      />
    );
  }

  return (
    <>
      {rows.map((row) => (
        <SettingsSubgroup
          key={row.providerId}
          title={row.label}
          description={providerRowDescription(row)}
          icon={
            <HarnessIcon
              harnessId={providerIdToGuiHarnessId(row.providerId)}
              className="size-3.5"
            />
          }
          level={4}
          // A hidden provider collapses its rows: they govern what a segment
          // that is not drawn would have contained. Nothing is written when it
          // closes, so re-enabling brings the same windows back.
          open={!hiddenProviders.includes(row.providerId)}
          dataTestId={`layout-provider-subgroup-${row.providerId}`}
          control={
            <Switch
              checked={!hiddenProviders.includes(row.providerId)}
              onCheckedChange={() => {
                trackLayoutSetting("layout.statusBar.rateLimits.provider");
                toggleProvider(row.providerId);
              }}
              aria-label={row.label}
            />
          }
        >
          {/* Above the window chips on purpose: it decides how many of them
            reach the strip, while each of them decides whether its window
            (shown to the user as a limit) counts as visible at all - in both
            modes. */}
          <SettingsRow
            label="Show all limits"
            description="Off: only the tightest limit. On: every limit not hidden below."
            control={
              <Switch
                checked={expandedProviders.includes(row.providerId)}
                onCheckedChange={() => {
                  trackLayoutSetting(
                    "layout.statusBar.rateLimits.expandedProvider",
                  );
                  toggleExpandedProvider(row.providerId);
                }}
                aria-label={`${row.label} show all limits`}
              />
            }
          />
          <SettingsRow
            label="Limits"
            description="Which of this provider's limits the strip may show."
            control={
              <SettingsToggleChips
                chips={windowChips(row, hiddenWindowKeys)}
                onToggle={(windowKey) => {
                  trackLayoutSetting("layout.statusBar.rateLimits.window");
                  toggleWindow(windowKey);
                }}
                ariaLabel={`${row.label} limits`}
                emptyLabel="Waiting for first reading"
              />
            }
          />
        </SettingsSubgroup>
      ))}
    </>
  );
}

function windowChips(
  row: StatusBarProviderRow,
  hiddenWindowKeys: ReadonlyArray<string>,
): ReadonlyArray<SettingsToggleChip<string>> {
  return row.windows.map((window) => ({
    value: window.windowKey,
    label: window.label,
    pressed: !hiddenWindowKeys.includes(window.windowKey),
    disabled: false,
  }));
}

function providerRowDescription(row: StatusBarProviderRow): string {
  // Keys are stable, so a provider with no reading yet still toggles - the
  // chips row says why it lists none rather than the subtitle implying the
  // provider reports none.
  if (row.windows.length === 0) return row.profileLabel;
  const limits =
    row.windows.length === 1 ? "1 limit" : `${row.windows.length} limits`;
  return `${row.profileLabel} · ${limits}`;
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
 * yet renders its "waiting" chips row instead.
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

// ── resource monitor ────────────────────────────────────────────────────────

interface ResourceMetricChip {
  readonly metric: ResourceMetric;
  readonly label: string;
}

const RESOURCE_METRIC_CHIPS: ReadonlyArray<ResourceMetricChip> = [
  { metric: "cpu", label: "CPU" },
  { metric: "memory", label: "Memory" },
  { metric: "processes", label: "Processes" },
  { metric: "ramShare", label: "RAM share" },
];

function ResourceMonitorSubgroup(): ReactNode {
  const resources = useLayoutStore((state) => state.statusBar.resources);
  const setResourcesEnabled = useLayoutStore(
    (state) => state.setStatusBarResourcesEnabled,
  );
  const setResourceScope = useLayoutStore(
    (state) => state.setStatusBarResourceScope,
  );
  const toggleResourceMetric = useLayoutStore(
    (state) => state.toggleStatusBarResourceMetric,
  );
  // RAM share is the measured processes' memory against that MACHINE's total -
  // a denominator the desktop-app scope has none of, so its chip is inert
  // rather than silently reading zero.
  const desktopAppScope = resources.scope === "desktop-app";
  return (
    <SettingsSubgroup
      title="Resource monitor"
      description="The watched host's CPU, memory and process numbers."
      icon={null}
      level={3}
      open={resources.enabled}
      dataTestId="layout-resource-monitor-subgroup"
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
    >
      <SettingsRow
        label="Scope"
        description="Traycer's processes on the watched host, or this desktop app."
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
      <SettingsRow
        label="Metrics"
        description="Which numbers the segment prints, in this order."
        hint={
          desktopAppScope
            ? "RAM share is only available for the host scope."
            : undefined
        }
        control={
          <SettingsToggleChips
            chips={RESOURCE_METRIC_CHIPS.map((chip) => ({
              value: chip.metric,
              label: chip.label,
              pressed: resources.metrics.includes(chip.metric),
              disabled: chip.metric === "ramShare" && desktopAppScope,
            }))}
            onToggle={(metric) => {
              trackLayoutSetting("layout.statusBar.resources.metric");
              toggleResourceMetric(metric);
            }}
            ariaLabel="Metrics"
            emptyLabel="No metrics available"
          />
        }
      />
    </SettingsSubgroup>
  );
}
