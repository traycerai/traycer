import type { ReactNode } from "react";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import {
  classifyProviderRateLimitWindow,
  isProviderRateLimitWindowLive,
} from "@traycer/protocol/host/rate-limit";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { StatusBarMiniBar } from "@/components/layout/status-bar/status-bar-mini-bar";
import { LiveSubgroup } from "@/components/settings/panels/layout/live-subgroup";
import { LiveToggleRow } from "@/components/settings/panels/layout/live-toggle-row";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  SettingsCheckboxList,
  type SettingsCheckboxListItem,
} from "@/components/settings/controls/settings-checkbox-list";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import { SettingsSubgroup } from "@/components/settings/controls/settings-subgroup";
import { SettingsToggleChips } from "@/components/settings/controls/settings-toggle-chips";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { StatusBarPreview } from "@/components/settings/panels/layout/status-bar-preview";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { Switch } from "@/components/ui/switch";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
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
} from "@/lib/rate-limits/rate-limit-window-catalog";
import {
  windowPercentText,
  windowPercentValueText,
} from "@/lib/rate-limits/status-bar-window-text";
import { tightestRateLimitWindow } from "@/lib/rate-limits/tightest-window";
import {
  rateLimitWindowSeverityTextClassName,
  type RateLimitWindowSeverity,
} from "@/lib/rate-limits/window-severity";
import { useSampledNow } from "@/lib/relative-time";
import { isStatusBarControlsAvailable } from "@/lib/settings/settings-availability";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import {
  statusBarProviderLimitSelection,
  useLayoutStore,
  type ResourceMetric,
  type StatusBarProviderLimitSelection,
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
  // per build reads as a broken build. The gate is the same predicate the
  // search index reads, so search never offers a footer control this build
  // does not draw.
  const availability = useSettingsAvailabilityContext();
  if (!isStatusBarControlsAvailable(availability)) {
    return <MobileStatusBarLayoutGroup />;
  }
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
      group={LAYOUT.definitions.statusBar}
      showTitle
      tone="default"
      dataTestId="layout-status-bar-group"
      fill={false}
    >
      <SettingsRow row={LAYOUT.definitions.desktopOnlyNote} control={null} />
      <SettingsRow
        row={LAYOUT.definitions.headerResourceMonitor}
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
      group={LAYOUT.definitions.statusBar}
      showTitle
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
          row={LAYOUT.definitions.placement}
          control={
            <SettingsSegmentedControl
              value={statusBar.placement}
              // Default first. The segment renders no default hint of its
              // own, so order is the only place the page can say which one an
              // untouched install is on.
              options={[
                { value: "status-bar", label: "Status bar" },
                { value: "header", label: "Header" },
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
            row={LAYOUT.definitions.headerResourceMonitor}
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
          group={LAYOUT.definitions.usageLimits}
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
      group={LAYOUT.definitions.usageDisplay}
      icon={null}
      control={null}
      level={4}
      open
      dataTestId="layout-usage-display-subgroup"
    >
      <SettingsRow
        row={LAYOUT.definitions.percentMode}
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
        row={LAYOUT.definitions.modeWord}
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
        row={LAYOUT.definitions.resetTimer}
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
        row={LAYOUT.definitions.miniBar}
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
      row={LAYOUT.definitions.providers}
      status={`Can't reach ${props.scope.hostLabel} right now, so its providers aren't listed. The status bar shows the same providers as soon as it answers.`}
      control={null}
    />
  );
}

interface StatusBarProviderRow {
  readonly providerId: RateLimitProviderId;
  readonly label: string;
  /** The profile whose reading this row describes, for the row's subtitle. */
  readonly profileLabel: string;
  readonly windows: ReadonlyArray<StatusBarProviderLimit>;
}

/** What this provider's retained reading currently says about one limit. */
interface StatusBarLimitReading {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly severity: RateLimitWindowSeverity;
}

/** One entry of a provider's limits list: what to call it, and what it reads. */
interface StatusBarProviderLimit {
  readonly windowKey: string;
  readonly label: string;
  /**
   * `null` for a limit with no CURRENT reading - a provider nothing has been
   * fetched for, and also a window whose reset instant has passed. Such a row
   * is drawn as it always was, label alone.
   */
  readonly reading: StatusBarLimitReading | null;
}

/**
 * A limit and its reading as one value, which is what both the gauge and the
 * tightest-of comparison want: the gauge needs the key it is drawn under, and
 * the automatic entry needs the NAME of whichever limit won.
 */
interface StatusBarLimitFigure extends StatusBarLimitReading {
  readonly windowKey: string;
  readonly label: string;
}

/**
 * One card per visible provider, holding the one thing that is about that
 * provider alone: which of its limits the segment draws - the tightest at the
 * moment, any it names explicitly, or both.
 */
function ScopedStatusBarRateLimitProviders(): ReactNode {
  const rows = useStatusBarProviderRows();
  const hiddenProviders = useLayoutStore(
    (state) => state.statusBar.rateLimits.hiddenProviders,
  );
  const selections = useLayoutStore(
    (state) => state.statusBar.rateLimits.providers,
  );
  const toggleProvider = useLayoutStore(
    (state) => state.toggleStatusBarProvider,
  );
  const setProviderAutomatic = useLayoutStore(
    (state) => state.setStatusBarProviderAutomatic,
  );
  const toggleProviderLimit = useLayoutStore(
    (state) => state.toggleStatusBarProviderLimit,
  );

  if (rows.length === 0) {
    return <SettingsRow row={LAYOUT.definitions.providers} control={null} />;
  }

  return (
    <>
      {rows.map((row) => {
        const selection = statusBarProviderLimitSelection(
          selections,
          row.providerId,
        );
        const rendered = renderedSelection(row, selection);
        return (
          <LiveSubgroup
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
            // that is not drawn would have contained. Nothing is written when
            // it closes, so re-enabling brings the same selection back.
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
            <LiveToggleRow
              label="Limits"
              description={limitsRowDescription(row, selection)}
              control={
                <SettingsCheckboxList
                  items={limitItems(row, rendered)}
                  onToggle={(value) => {
                    switch (value.kind) {
                      case "automatic":
                        trackLayoutSetting(
                          "layout.statusBar.rateLimits.providerAutomatic",
                        );
                        setProviderAutomatic(
                          row.providerId,
                          !rendered.automatic,
                        );
                        return;
                      case "limit":
                        trackLayoutSetting(
                          "layout.statusBar.rateLimits.providerLimits",
                        );
                        // The stand-in, made real. While the list is forcing
                        // the automatic entry on (`renderedSelection`) the
                        // stored flag is still off, so adding a pick would
                        // lift the force and leave the entry just clicked as
                        // the only checked one - held, blurring to `<body>`,
                        // with automatic unchecking itself in the same paint.
                        // Writing the flag the user has been looking at keeps
                        // the list saying what it said. Only ever a CHECK:
                        // the force exists precisely because no visible pick
                        // is checked. Written first, so no intermediate paint
                        // can hold the clicked box either.
                        if (rendered.automatic && !selection.automatic) {
                          setProviderAutomatic(row.providerId, true);
                        }
                        toggleProviderLimit(row.providerId, value.windowKey);
                        return;
                    }
                  }}
                  ariaLabel={`${row.label} limits`}
                />
              }
            />
          </LiveSubgroup>
        );
      })}
    </>
  );
}

/**
 * One entry of the limits list. A shape rather than a string, so the handler
 * switches on `kind` exhaustively instead of recognising the automatic entry by
 * its spelling and treating everything else as a window key.
 */
type LimitListEntry =
  | { readonly kind: "automatic" }
  | { readonly kind: "limit"; readonly windowKey: string };

/**
 * The selection AS THE LIST DRAWS IT, which is not always the selection the
 * store holds.
 *
 * `limitKeys` may name a window the current reading does not carry - a model
 * since renamed, or any pick at all before the first reading lands, which is
 * routine on this page since it never fetches. `shownWindows` stands the
 * tightest in for that, so the list has to show the automatic entry checked:
 * otherwise a migrated `Show all limits` user opening Layout cold sees nothing
 * checked while their strip is drawing something. It is the resolution the
 * segment already performs, shown rather than re-decided.
 *
 * Held (see `limitItems`) rather than clickable in that state, because the
 * stored `automatic` is still off and unchecking what was never checked could
 * only write a selection the store refuses. A pick made WHILE it is forced
 * writes the flag through with it, so the force is never lifted out from under
 * the entry that lifted it - see the `limit` arm of the list's `onToggle`.
 */
function renderedSelection(
  row: StatusBarProviderRow,
  selection: StatusBarProviderLimitSelection,
): StatusBarProviderLimitSelection {
  const limitKeys = row.windows
    .filter((window) => selection.limitKeys.includes(window.windowKey))
    .map((window) => window.windowKey);
  return {
    automatic: selection.automatic || limitKeys.length === 0,
    limitKeys,
  };
}

/**
 * The automatic entry first, then one entry per limit the provider currently
 * reports, in catalog order.
 *
 * The last checked entry ON SCREEN is held: unchecking it would leave the
 * segment with nothing to draw, and the provider switch above is the control
 * for that. Counted against the list rather than the store, because a pick the
 * store remembers for a window the provider is not reporting right now is not
 * something the user can see to re-check - and it is the rendered selection
 * that is counted, so "nothing visible is checked" is never a state this list
 * can be in.
 *
 * Each entry also carries its limit's current figure (`LimitFigure`), which is
 * how a list of names becomes a list of readings: whether a limit is worth
 * showing on the strip is a question about what it says right now.
 */
function limitItems(
  row: StatusBarProviderRow,
  rendered: StatusBarProviderLimitSelection,
): ReadonlyArray<SettingsCheckboxListItem<LimitListEntry>> {
  const checkedCount = rendered.limitKeys.length + (rendered.automatic ? 1 : 0);
  // The same comparison the strip's segment model makes
  // (`lib/rate-limits/tightest-window.ts`), so the limit this entry names is
  // the limit the strip is drawing and not a second opinion about it.
  const tightest = tightestRateLimitWindow(limitFigures(row.windows));
  return [
    {
      key: "automatic",
      value: { kind: "automatic" },
      label: "Tightest limit (automatic)",
      checked: rendered.automatic,
      disabled: rendered.automatic && checkedCount === 1,
      // This entry names the limit it is reading, where a limit's own row does
      // not: WHICH of several is tightest right now is the thing the entry is
      // for, and a bare percentage here would be the one figure in the list
      // with nothing saying what it measures.
      trailing:
        tightest === null ? null : <LimitFigure figure={tightest} showName />,
      announcement:
        tightest === null
          ? null
          : `, ${tightest.label}, ${windowPercentText(tightest.usedPercent, "used")}`,
    },
    ...row.windows.map((limit) => {
      const checked = rendered.limitKeys.includes(limit.windowKey);
      const figure = limitFigure(limit);
      return {
        key: limit.windowKey,
        value: { kind: "limit" as const, windowKey: limit.windowKey },
        label: limit.label,
        checked,
        disabled: checked && checkedCount === 1,
        trailing:
          figure === null ? null : (
            <LimitFigure figure={figure} showName={false} />
          ),
        announcement:
          figure === null
            ? null
            : `, ${windowPercentText(figure.usedPercent, "used")}`,
      };
    }),
  ];
}

function limitFigure(
  limit: StatusBarProviderLimit,
): StatusBarLimitFigure | null {
  if (limit.reading === null) return null;
  return { windowKey: limit.windowKey, label: limit.label, ...limit.reading };
}

function limitFigures(
  limits: ReadonlyArray<StatusBarProviderLimit>,
): ReadonlyArray<StatusBarLimitFigure> {
  return limits.flatMap((limit) => {
    const figure = limitFigure(limit);
    return figure === null ? [] : [figure];
  });
}

/**
 * One limit's current reading, drawn at the right edge of its row: the strip's
 * OWN gauge (`StatusBarMiniBar`) and the percentage beside it.
 *
 * The point of a figure in a control is that it is the figure the control
 * governs, so the gauge is imported rather than drawn again, and the percentage
 * carries the same severity tone the strip gives it - which is also the only
 * thing on the row saying `82%` is a different kind of news from `12%`. The
 * reset countdown is deliberately absent: this is a list of what to show, not a
 * second status bar, and the strip is where a timer means something.
 *
 * `used` rather than the strip's `percentMode`: `Percentage` is a preference
 * about how the STRIP words a reading, and the preview above it already answers
 * for it. Here the number's job is how much of this limit is gone, which is the
 * same question the gauge's fill answers - and a list whose numbers inverted
 * while their bars did not would be two readings of one fact.
 *
 * Both halves are inside the control's `aria-hidden` wrapper; the box's own
 * name carries the same reading through `announcement`.
 */
/**
 * The one width every percent cell reserves, named so the class the rows share
 * is one literal - a track whose rows were sized independently is a track only
 * until one of them disagrees.
 */
const LIMIT_PERCENT_CELL_WIDTH_CLASS_NAME = "min-w-[5ch]";

function LimitFigure(props: {
  readonly figure: StatusBarLimitFigure;
  readonly showName: boolean;
}): ReactNode {
  return (
    <>
      {props.showName ? (
        <span className="truncate text-muted-foreground text-ui-xs">
          {props.figure.label}
        </span>
      ) : null}
      <StatusBarMiniBar
        windowKey={props.figure.windowKey}
        usedPercent={props.figure.usedPercent}
        severity={props.figure.severity}
      />
      {/* A numeral track, not a layout width: `tabular-nums` makes the digits
        one width and the `ch` floor keeps every row's number ending in the same
        column, so a column of rows reads as one gauge repeated.

        The floor is sized by the WIDEST READING rather than by digit count.
        `windowPercentValueText` clamps to `100%`, and `%` advances wider than a
        tabular digit does, so `100%` is about 4.5ch - a 4ch cell grows for that
        one row and shifts its gauge left of every other row's, which is the
        misalignment the track exists to prevent. 5ch clears it with the slack
        on the left, where a right-aligned number never shows it. */}
      <span
        data-testid="layout-limit-percent"
        className={cn(
          LIMIT_PERCENT_CELL_WIDTH_CLASS_NAME,
          "shrink-0 text-right tabular-nums",
          rateLimitWindowSeverityTextClassName(props.figure.severity),
        )}
      >
        {windowPercentValueText(props.figure.usedPercent, "used")}
      </span>
    </>
  );
}

function limitsRowDescription(
  row: StatusBarProviderRow,
  selection: StatusBarProviderLimitSelection,
): string {
  // Keys are stable, so a provider with no reading yet still has its automatic
  // entry - the row says why the list stops there rather than implying the
  // provider reports nothing else. Said differently for a provider whose picks
  // are stored but unreported, where "the strip shows the tightest" is only
  // true until the reading lands.
  if (row.windows.length === 0) {
    return selection.automatic
      ? "The strip shows whichever limit is tightest. Its other limits are listed here once the first reading arrives."
      : "No reading yet, so this provider's limits aren't listed and the strip falls back to whichever is tightest. The limits you picked come back with them.";
  }
  return "The strip shows every checked limit; automatic is whichever is tightest right now. At least one stays checked - the switch above hides the provider.";
}

function providerRowDescription(row: StatusBarProviderRow): string {
  // Keys are stable, so a provider with no reading yet still toggles - the
  // limits row says why it lists only the automatic entry rather than the
  // subtitle implying the provider reports none.
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
  // The same shared 60s clock the strip samples, so a window that expires while
  // this page is open loses its figure within the minute instead of printing a
  // period that has already rolled.
  const now = useSampledNow();
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
      windows: rateLimits === null ? [] : providerLimits(rateLimits, now),
    };
  });
}

/**
 * One provider's limits, each carrying whatever its retained reading currently
 * says about it.
 *
 * Every limit the snapshot reports stays in the list - that is what makes a
 * model-scoped window checkable at all - but a READING is attached only while
 * the window is live, the same test `liveWindows` applies before the strip draws
 * one. A window whose reset instant has passed describes a period that has
 * already rolled, so its percentage is spent usage; the row keeps its checkbox
 * and simply shows no figure, which is exactly how every row of a provider with
 * no reading is drawn.
 */
function providerLimits(
  rateLimits: ProviderRateLimits,
  now: number,
): ReadonlyArray<StatusBarProviderLimit> {
  return providerWindowEntries(rateLimits).map((entry) => ({
    windowKey: entry.windowKey,
    label: entry.label,
    reading: isProviderRateLimitWindowLive(entry.window, now)
      ? {
          usedPercent: entry.window.usedPercent,
          resetsAt: entry.window.resetsAt,
          severity: classifyProviderRateLimitWindow(entry.window),
        }
      : null,
  }));
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
      group={LAYOUT.definitions.resourceMonitor}
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
        row={LAYOUT.definitions.resourceScope}
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
        row={LAYOUT.definitions.metrics}
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
