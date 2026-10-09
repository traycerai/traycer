import type { ReactNode } from "react";
import {
  SAMPLE_CONTEXT_PERCENT_LEFT,
  SAMPLE_RESOURCE_VALUES,
  sampleUsageReading,
  type SampleUsageReading,
} from "@/components/sample-workspace/sample-workspace-scene";
import {
  Bot,
  Box,
  Brain,
  ChevronRight,
  Cpu,
  FileDiff,
  History,
  ListChecks,
  Mic,
  Shield,
} from "lucide-react";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { ChatAccumulatedChangesPanel } from "@/components/chat/chat-accumulated-changes-panel";
import { ActiveAgentsHeader } from "@/components/chat/chat-active-agents-panel";
import { BackgroundItemsHeader } from "@/components/chat/chat-background-items-panel";
import {
  ChatDiffTargetContext,
  type ChatSnapshotDiffOpener,
} from "@/components/chat/chat-diff-target";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import { PinnedTodoPanel } from "@/components/chat/chat-pinned-stack";
import { contextUsageTone } from "@/components/chat/context-usage";
import {
  SAMPLE_MESSAGE_TIME_LABEL,
  SAMPLE_RESTORE,
  SAMPLE_TODO,
} from "@/components/sample-workspace/sample-workspace-scene";
import { LeftPanelRailIcon } from "@/components/epic-canvas/sidebar/left-panel-rail-icon";
import { ComposerAttachImageTrigger } from "@/components/home/toolbar/composer-attach-image-button";
import { ToolbarIconButton } from "@/components/home/toolbar/toolbar-buttons";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import { ModelFooterDepiction } from "@/components/home/pickers/model-footer-depiction";
import { PermissionsTrigger } from "@/components/home/pickers/permissions-picker";
import { StatusBarUsageReadings } from "@/components/layout/status-bar/status-bar-usage-readings";
import { TabStripHomeItemView } from "@/components/layout/tabs/tab-strip-home-item";
import { MinimapRailTick } from "@/components/minimap/minimap-rail-tick";
import { Collapsible } from "@/components/ui/collapsible";
import {
  HostContextFrame,
  type HostContextId,
} from "@/components/layout-editor/region-depiction-frame";
import { classifyProviderRateLimitWindow } from "@traycer/protocol/host/rate-limit";
import {
  asBarRegionId,
  barPlacement,
  USAGE_PROVIDER_IDS,
  type BarRegionId,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { leftPanelIdForRailRegion } from "@/lib/layout/rail";
import {
  formatCompactWindowDuration,
  isWindowedRateLimitProvider,
} from "@/lib/rate-limits/rate-limit-window-catalog";
import { tightestRateLimitWindow } from "@/lib/rate-limits/tightest-window";
import type {
  ContextUsageValues,
  LayoutValues,
  ModelValues,
  ResourceMonitorValues,
  SizedValues,
  UsageLimitsValues,
} from "@/lib/layout/layout-values";
import type {
  DockRegionId,
  RailRegionId,
  RegionId,
} from "@/lib/layout/region-id";
import { cn } from "@/lib/utils";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { StatusBarResourceMetricView } from "@/lib/resources/status-bar-resource-reading";
import { UsageGlyph } from "@/components/layout/header/rate-limit-icon";
import { StatusBarMetric } from "@/components/layout/status-bar/status-bar-resource-segment";
import { resolvedReadingDensity } from "@/lib/layout/reading-density";
import { LayoutOverrideProvider } from "@/providers/layout-override-provider";

/**
 * The only way a region is drawn outside the canvas (L-11).
 *
 * Two rules decide everything in this file.
 *
 * **The real leaf wherever it takes its answer as a prop.** Most of the app's
 * chrome is already split into an interactive mount and a drawing view -
 * `StatusBarUsageReadings`, `HarnessModelTrigger`, `PermissionsTrigger`,
 * `TabStripHomeItemView`, `MinimapRailTick`, `LeftPanelRailIcon`, the dock's
 * two headers, its changed-files and todo panels and its compact chip
 * all take what they draw from props - and
 * for those a depiction IS the shipping component under specimen data. The
 * four that read a preference through a hook of their own rather than from a
 * prop (the resource segment, the context chip, the mic button, the harness
 * label) are drawn here from their own markup, because the alternative is a
 * translation from this build's `LayoutValues` into the pre-rework preference
 * shapes - code the switch-over deletes. The parity regression (L-53) is what
 * holds those four to the real thing; nothing in the mechanism is linted.
 *
 * **A depiction never asks whether the region is shown.** The stage's job is
 * to show what a region WOULD look like, so `shown` is the one value no
 * renderer here reads; the stage dims itself instead.
 *
 * Nothing in this file fetches, writes or opens anything: it is a
 * value in, one picture out. That is the passivity contract `lib/layout-overrides.ts`
 * spells out, and it is why the specimen data below is static rather than the
 * watched host's own numbers.
 *
 * "Value in" holds for a leaf that reads through the override seam too: every
 * entry point here lays the values it was handed over its leaf, so the toolbar
 * chips' chrome, which each chip reads off `model.toolbarStyle` itself, is the
 * picture's answer and never the store's.
 */

export type { HostContextId };

/**
 * Where a region really lives, given what the arrangement says about it and
 * what its own values make of it.
 *
 * Read off the region rather than off the registry's `surface`, so the
 * depiction module owes the registry nothing and the two can be imported in
 * one direction only.
 */
function hostContextFor(
  regionId: RegionId,
  values: LayoutValues[RegionId],
  arrangement: LayoutArrangement,
): HostContextId {
  // The two regions whose bar the user can move (L-19, L-156). Everything else
  // is where it lives, which the table below states once per region.
  const barRegion = asBarRegionId(regionId);
  if (barRegion !== null) return barHostContext(arrangement, barRegion);
  const host = HOST_BY_REGION[regionId];
  // The second region that moves surface, and this one moves itself: a dock
  // member set to Chip is not a row in the dock's joined frame, it is a pill
  // in the strip above the composer (L-97, A12). Its picture is framed where
  // the real thing stands, or the chip would be drawn inside a frame it has
  // just left.
  if (host === "dock" && isChipSized(values)) return "chip-strip";
  return host;
}

/** Which bar one of the two readings is hosted in right now (L-28, L-156). */
function barHostContext(
  arrangement: LayoutArrangement,
  region: BarRegionId,
): HostContextId {
  return barPlacement(arrangement, region).host === "header"
    ? "top-bar"
    : "status-bar";
}

function isChipSized(values: LayoutValues[RegionId]): boolean {
  return "size" in values && values.size === "chip";
}

/**
 * Every region's own surface.
 *
 * A total `Record<RegionId, ...>` rather than a switch with a `default`: a
 * region added without a host is a compile error here, where a `default` used
 * to draw it in the sidebar and say nothing (G1-22).
 */
const HOST_BY_REGION: Readonly<Record<RegionId, HostContextId>> = {
  homeTab: "top-bar",
  // The two bar readings never reach this table - `hostContextFor` answers
  // them from their own placement above (L-156). The rows exist because the
  // record is total over `RegionId`, which is what makes a new region a
  // compile error here.
  usageLimits: "status-bar",
  resourceMonitor: "status-bar",
  minimap: "chat",
  toolActivity: "chat",
  thinking: "chat",
  timestamps: "chat",
  contextUsage: "composer-foot",
  runningAgents: "dock",
  changedFiles: "dock",
  background: "dock",
  todo: "dock",
  attachImage: "toolbar",
  access: "toolbar",
  model: "toolbar",
  mic: "toolbar",
  railAgents: "rail",
  railTerminals: "rail",
  railBrowsers: "rail",
  railArtifacts: "rail",
  railGitDiff: "rail",
  railPullRequests: "rail",
  railFileTree: "rail",
  railSharing: "rail",
  railComments: "rail",
};

/**
 * One region as a picture, in its host's own context.
 *
 * The frame is never an argument: {@link hostContextFor} answers from the
 * region, its own values and the arrangement. A chip-sized dock member is
 * framed as a chip because its VALUES say so, and a bar reading is framed by
 * the bar it names (L-156); a second way to say either is a second thing to
 * keep true.
 */
export function depictRegion<K extends RegionId>(
  regionId: K,
  values: LayoutValues[K],
  arrangement: LayoutArrangement,
): ReactNode {
  const depict = REGION_DEPICTIONS[regionId];
  // The leaf is drawn under the values it is a picture of, so a real
  // component that reads its own region through the override seam draws
  // them rather than the store's.
  return (
    <LayoutOverrideProvider
      value={{ values: { [regionId]: values }, arrangement }}
    >
      <HostContextFrame host={hostContextFor(regionId, values, arrangement)}>
        {depict(values, arrangement)}
      </HostContextFrame>
    </LayoutOverrideProvider>
  );
}

/**
 * {@link depictRegion}, for a caller holding a whole `LayoutValues` rather
 * than one region's bag - the inspector's sections, its Style examples and
 * the preset miniatures, which walk the map and draw whichever region is open.
 *
 * The whole map is laid over the leaf, not just its region's bag: the toolbar
 * chips all draw their chrome from `model.toolbarStyle` (`toolbar-buttons.tsx`),
 * so a picture of the mic under a preset or a Toolbar style example has to
 * carry the model's answer too, or it draws the live setting.
 *
 * It lives here and not in the registry: `regions/` is the registry layer
 * (G1-11), and a depiction import there closes a module cycle back through
 * the Settings surface (G3-08). The indirection through a locally annotated
 * parameter is what lets the two indexed accesses resolve together for every
 * region at once.
 */
export function regionDepiction<K extends RegionId>(
  region: K,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReactNode {
  return (
    <LayoutOverrideProvider value={{ values }}>
      {depictRegion(region, values[region], arrangement)}
    </LayoutOverrideProvider>
  );
}

/**
 * What one style row's examples draw: the region itself, except for Model's
 * Reasoning control, whose values change the picker's footer rather than the
 * chip, and Usage limits' Reading style, whose card has room for two profiles.
 */
export function regionStyleDepiction(
  region: RegionId,
  styleKey: string,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReactNode {
  if (region === "model" && styleKey === "reasoningControl")
    return <ModelFooterDepiction control={values.model.reasoningControl} />;
  if (region === "usageLimits" && styleKey === "readingStyle")
    return regionDepiction(region, values, {
      ...arrangement,
      usageProviders: depictedUsageProviders(arrangement).slice(
        0,
        READING_STYLE_CARD_PROFILES,
      ),
    });
  return regionDepiction(region, values, arrangement);
}

/** What a Reading style card shows of the status bar: this many profiles. */
const READING_STYLE_CARD_PROFILES = 2;

/**
 * Every full-size dock row in ONE joined frame (L-97).
 *
 * The real `ChatLowerDock` is one bordered surface tucked under the composer
 * with its panels stacked inside it and a hairline between them - never a
 * bordered card per row. Both pictures of the dock wrapped their rows in a
 * frame of their own and then drew each row through `depictRegion`, which
 * frames it again, so every row came out inside two joined frames and the
 * "separate cards" treatment L-97 dropped was back in the two surfaces whose
 * whole claim is that they are a real picture of the app (R1-01).
 *
 * It is here rather than in either picture because the frame belongs to this
 * layer: `depictRegion` is deliberately the only way a region is drawn, so a
 * caller cannot hold the leaf without the frame, and this is the one place
 * that may put several leaves in one.
 */
export function depictDockRows(
  rows: ReadonlyArray<DockRegionId>,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReactNode {
  return (
    <LayoutOverrideProvider value={{ values, arrangement }}>
      <HostContextFrame host="dock">
        {rows.map((regionId, index) => (
          <div
            key={regionId}
            // The same hairline `ChatLowerDock` gives a panel it draws below
            // another one (`separated`), which is what tells two rows apart
            // inside one frame now that the gap between two cards is gone.
            //
            // `undefined` and not `cn(null)`, which is the empty string: the
            // first row was shipping a bare `class=""` (R2-10).
            className={index === 0 ? undefined : "border-t border-border/50"}
          >
            {depictDockRow(regionId, values[regionId], arrangement)}
          </div>
        ))}
      </HostContextFrame>
    </LayoutOverrideProvider>
  );
}

/** One dock row's leaf, without a frame of its own. Private for that reason. */
function depictDockRow<K extends DockRegionId>(
  regionId: K,
  values: LayoutValues[K],
  arrangement: LayoutArrangement,
): ReactNode {
  const depict = REGION_DEPICTIONS[regionId];
  return depict(values, arrangement);
}

// ── Specimen data ───────────────────────────────────────────────────────────

/**
 * One provider's specimen reading, by its place in the CATALOG.
 *
 * `USAGE_PROVIDER_IDS` and not `arrangement.usageProviders`: the reading is a
 * fact about the provider, so dragging the strip into another order, or hiding
 * one provider, must not renumber everybody else's picture.
 */
function specimenReadingFor(
  providerId: RateLimitProviderId,
): SampleUsageReading {
  // Placed among the providers that draw at all, so two windowed providers
  // either side of a windowless one never land on the same reading (LV2-19).
  const catalogIndex = USAGE_PROVIDER_IDS.filter(
    isWindowedRateLimitProvider,
  ).indexOf(providerId);
  return sampleUsageReading(catalogIndex < 0 ? 0 : catalogIndex);
}

/**
 * That reading as the window the real segment component draws.
 *
 * Worded and tinted through the catalog's own two functions -
 * `formatCompactWindowDuration` writes every label the live strip prints, and
 * `classifyProviderRateLimitWindow` decides every severity - so a picture of a
 * reading says what that reading would say rather than something that merely
 * looks like it.
 */
function specimenWindow(
  providerId: RateLimitProviderId,
): StatusBarRateLimitWindow {
  const reading = specimenReadingFor(providerId);
  const resetsAt = Date.now() + reading.resetsInMinutes * 60 * 1000;
  return {
    windowKey: `${providerId}:specimen`,
    label: formatCompactWindowDuration(reading.durationMinutes),
    labelIsDuration: true,
    kind: reading.kind,
    usedPercent: reading.usedPercent,
    resetsAt,
    severity: classifyProviderRateLimitWindow({
      usedPercent: reading.usedPercent,
      resetsAt,
      durationMinutes: reading.durationMinutes,
    }),
  };
}

function noop(): void {}

/**
 * The scroll cap a dock panel takes from its tile. A picture never opens, so
 * nothing is ever measured against it; it is here because the real panel asks
 * for one and a picture must not invent a different geometry to hand it.
 */
export const SPECIMEN_SCROLL_REGION_CLASS = "max-h-[min(24dvh,12rem)]";

/** Every handler the changed-files header asks for, going nowhere. */
const INERT_DIFF_OPENER: ChatSnapshotDiffOpener = {
  segment: () => ({ onClick: noop, onDoubleClick: noop }),
  cumulative: () => ({ onClick: noop, onDoubleClick: noop }),
  cumulativeBundle: () => noop,
  hash: () => ({ onClick: noop, onDoubleClick: noop }),
};

// ── Per-region renderers ────────────────────────────────────────────────────

/** The segment itself, which the cluster repeats once per shown provider. */
function depictUsageProviderSegment(
  providerId: RateLimitProviderId,
  values: UsageLimitsValues,
): ReactNode {
  return (
    <StatusBarUsageReadings
      display={{
        percentMode: values.amount,
        showTimer: values.reset,
        readingStyle: values.readingStyle,
      }}
      cluster={{
        kind: "segments",
        segments: [specimenSegment(providerId)],
      }}
    />
  );
}

/** One provider's segment over its specimen window. */
function specimenSegment(
  providerId: RateLimitProviderId,
): StatusBarProviderSegmentModel {
  const drawn = [specimenWindow(providerId)];
  return {
    providerId,
    profileId: null,
    account: null,
    hidden: false,
    state: "live",
    reason: null,
    windows: drawn,
    shown: drawn,
    tightest: tightestRateLimitWindow(drawn),
  };
}

/** The providers a usage picture draws: shown, and reporting windows at all. */
function depictedUsageProviders(
  arrangement: LayoutArrangement,
): ReadonlyArray<RateLimitProviderId> {
  return arrangement.usageProviders.filter(
    (id) =>
      isWindowedRateLimitProvider(id) &&
      !arrangement.hiddenProviders.includes(id),
  );
}

/**
 * EVERY shown provider that reports windows, in the arrangement's own order
 * (P2, R3-03): Detailed as one segment each, Compact as the one glyph over all
 * of them, as the live reading resolves its density at its spot.
 *
 * The arrangement is the whole answer: a caller that wants only the watched
 * host's providers narrows it first (`useLiveUsageArrangement`), so a picture
 * reads no context of the editor's own. A provider with no limit windows has
 * nothing to draw and is left out rather than drawn as an empty segment.
 */
function depictUsageLimits(
  values: UsageLimitsValues,
  arrangement: LayoutArrangement,
): ReactNode {
  const providers = depictedUsageProviders(arrangement);
  if (
    resolvedReadingDensity(values.density, arrangement, "usageLimits") ===
    "compact"
  ) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        <UsageGlyph
          cluster={{
            kind: "segments",
            segments: providers.map((id) => specimenSegment(id)),
          }}
        />
      </span>
    );
  }
  return providers.map((providerId) => (
    <span key={providerId} className="inline-flex shrink-0 items-center">
      {depictUsageProviderSegment(providerId, values)}
    </span>
  ));
}

/**
 * The four metric readings, in the canonical order the strip prints them.
 *
 * Drawn through the strip's own `StatusBarMetric` rather than by mounting
 * `StatusBarResourceSegment`: that component resolves its readings through
 * `useStatusBarResourceMetrics`, which subscribes to the desktop sampler and
 * the resource registry, so a picture of it cannot be one of its mounts. The
 * specimen is the sample shell's, which never warns, exactly as the live sample
 * shell does not.
 */
const RESOURCE_SPECIMEN: ReadonlyArray<StatusBarResourceMetricView> = (
  [
    ["cpu", "cpu"],
    ["memory", "mem"],
    ["processes", "procs"],
    ["ramShare", "ram"],
  ] as const
).map(([metric, label]) => ({
  metric,
  label,
  value: SAMPLE_RESOURCE_VALUES[metric],
  unavailableReason: null,
}));

/**
 * Compact is the CPU icon alone whatever Metrics says; Detailed is
 * the chosen metrics, as the live reading resolves its density at its spot.
 */
function depictResourceMonitor(
  values: ResourceMonitorValues,
  arrangement: LayoutArrangement,
): ReactNode {
  const compact =
    resolvedReadingDensity(values.density, arrangement, "resourceMonitor") ===
    "compact";
  const readings = RESOURCE_SPECIMEN.filter((view) => values[view.metric]);
  return (
    <span className="inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 px-2 text-muted-foreground">
      <Cpu className="size-3 shrink-0" aria-hidden />
      {compact
        ? null
        : readings.map((view, index) => (
            <span
              key={view.metric}
              className="inline-flex min-w-0 items-center gap-1"
            >
              {index === 0 ? null : (
                <span aria-hidden className="text-muted-foreground/60">
                  ·
                </span>
              )}
              <StatusBarMetric view={view} warning={false} />
            </span>
          ))}
    </span>
  );
}

/**
 * A transcript row with a disclosure, open or folded: an activity run's
 * summary, or a reasoning block's "Thought for" line. Drawn from the rows' own
 * classes (`activity-group-segment.tsx`, `reasoning-segment.tsx`) rather than
 * through them, because both read their open state from per-chat stores a
 * picture must not mount.
 */
function depictTranscriptDisclosure(props: {
  readonly icon: typeof Box;
  readonly label: string;
  readonly detail: string;
  readonly open: boolean;
}): ReactNode {
  const Icon = props.icon;
  return (
    <span className="flex min-w-0 flex-col justify-center gap-0.5 px-2 text-ui-sm text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{props.label}</span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/65",
            props.open && "rotate-90",
          )}
          aria-hidden
        />
      </span>
      {props.open ? (
        <span className="ml-1.5 truncate border-l border-border/35 pl-3 text-ui-xs">
          {props.detail}
        </span>
      ) : null}
    </span>
  );
}

/** The sender overline's stamp, as `ChatMessageTimestamp` draws it. */
function depictTimestamp(): ReactNode {
  return (
    <span className="flex items-center px-2 text-overline font-medium text-muted-foreground/60">
      <span className="uppercase">You</span>
      <span aria-hidden> · </span>
      <span className="font-normal tabular-nums text-muted-foreground/50">
        {SAMPLE_MESSAGE_TIME_LABEL}
      </span>
    </span>
  );
}

/** Three ticks of transcript, on the edge the arrangement puts them. */
function depictMinimap(arrangement: LayoutArrangement): ReactNode {
  return (
    <span className="relative inline-block h-full w-6 min-w-0">
      {["20%", "50%", "80%"].map((top, index) => (
        <MinimapRailTick
          key={top}
          active={index === 1}
          availableWidth={24}
          hierarchical={false}
          level={1}
          open={false}
          side={arrangement.minimapSide}
          top={top}
        />
      ))}
    </span>
  );
}

/**
 * The context chip in each of its three readings.
 *
 * Drawn here rather than through `ContextUsageChipView`, which reads its style
 * and its pin from the preference seam instead of from props - see this
 * module's header. The ring is `ContextUsageRing`'s own geometry.
 */
const CONTEXT_RING_RADIUS = 8.5;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

function depictContextUsage(values: ContextUsageValues): ReactNode {
  const percent = SAMPLE_CONTEXT_PERCENT_LEFT;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm bg-transparent text-ui-sm font-normal tabular-nums whitespace-nowrap",
        values.style === "text" && "opacity-70",
        contextUsageTone(percent),
      )}
    >
      {values.style === "text" ? (
        `${percent}% context left`
      ) : (
        <span
          className={cn(
            "relative inline-flex shrink-0 items-center justify-center",
            values.style === "ring" ? "size-5" : "size-4",
          )}
        >
          <svg
            viewBox="0 0 20 20"
            aria-hidden
            className="absolute inset-0 size-full -rotate-90"
          >
            <circle
              cx="10"
              cy="10"
              r={CONTEXT_RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.25}
              strokeWidth="2"
            />
            <circle
              cx="10"
              cy="10"
              r={CONTEXT_RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
              strokeDashoffset={
                CONTEXT_RING_CIRCUMFERENCE * (1 - percent / 100)
              }
            />
          </svg>
          {values.style === "ring" ? (
            <span
              aria-hidden
              className="relative text-[0.625rem] font-semibold leading-none tabular-nums"
            >
              {percent}
            </span>
          ) : null}
        </span>
      )}
    </span>
  );
}

function depictRunningAgents(values: SizedValues): ReactNode {
  if (values.size === "chip") {
    return (
      <ChatDockCompactChip
        icon={<Bot className="size-3.5" />}
        text="1"
        working={false}
        lineDeltas={null}
        label="Active agents"
        tooltipLines={null}
        pulseToken={null}
        expanded={false}
        controls={null}
        testId="layout-depiction-running-agents"
        onClick={noop}
      />
    );
  }
  return (
    <Collapsible open={false} variant="panel">
      <ActiveAgentsHeader open={false} runningCount={1} />
    </Collapsible>
  );
}

function depictChangedFiles(values: SizedValues): ReactNode {
  if (values.size === "chip") {
    return (
      <ChatDockCompactChip
        icon={<FileDiff className="size-3.5" />}
        text="1"
        working={false}
        lineDeltas={null}
        label="Changed files"
        tooltipLines={null}
        pulseToken={null}
        expanded={false}
        controls={null}
        testId="layout-depiction-changed-files"
        onClick={noop}
      />
    );
  }
  // The real row, not a look-alike of it. This drew `FileChangeHeader` - a
  // TRANSCRIPT segment header, "Edit - path" - which is the same miss L-98
  // names in the sample dock: the changed-files row is the "N files changed"
  // panel, with its count, its `+/-` and its header actions. The panel reads
  // nothing of its own; it is handed the same `SAMPLE_RESTORE` the sample
  // workspace's dock is fed, so the canvas and the picture cannot disagree.
  //
  // The opener is what the header's "Review all" is gated on, and it is the
  // sample scene's shape: a handler that goes nowhere, so the picture is
  // complete and still opens nothing (the passivity contract above; the
  // specimen stage is `inert` besides).
  return (
    <ChatDiffTargetContext.Provider value={INERT_DIFF_OPENER}>
      <ChatAccumulatedChangesPanel
        restore={SAMPLE_RESTORE}
        separated={false}
        scrollRegionMaxHeightClass={SPECIMEN_SCROLL_REGION_CLASS}
      />
    </ChatDiffTargetContext.Provider>
  );
}

function depictBackground(values: SizedValues): ReactNode {
  if (values.size === "chip") {
    return (
      <ChatDockCompactChip
        icon={<History className="size-3.5" />}
        text="1"
        working={false}
        lineDeltas={null}
        label="Background"
        tooltipLines={null}
        pulseToken={null}
        expanded={false}
        controls={null}
        testId="layout-depiction-background"
        onClick={noop}
      />
    );
  }
  return (
    <Collapsible open={false} variant="panel">
      <BackgroundItemsHeader open={false} headerSummary="1 running" />
    </Collapsible>
  );
}

/**
 * The real Todo panel, fed the sample workspace's own todo list. It reads
 * nothing of its own beyond the snapshot it is handed, so there is no inert
 * wiring to do.
 */
function depictTodo(values: SizedValues): ReactNode {
  if (values.size === "chip") {
    return (
      <ChatDockCompactChip
        icon={<ListChecks className="size-3.5" />}
        text="1"
        working={false}
        lineDeltas={null}
        label="Todo"
        tooltipLines={null}
        pulseToken={null}
        expanded={false}
        controls={null}
        testId="layout-depiction-todo"
        onClick={noop}
      />
    );
  }
  return (
    <PinnedTodoPanel
      todo={SAMPLE_TODO}
      scrollRegionMaxHeightClass={SPECIMEN_SCROLL_REGION_CLASS}
      separated={false}
    />
  );
}

function depictModel(values: ModelValues): ReactNode {
  return (
    <HarnessModelTrigger
      selection={{ harnessId: "codex", modelSlug: "specimen", profileId: null }}
      label="Model"
      reasoningLabel="Medium"
      reasoningStep={{ index: 2, count: 4 }}
      reasoningIndicator={values.style}
      serviceTierLabel={null}
      serviceTierActive={false}
      profileLabel={null}
      profileAccentDot={null}
      isLoading={false}
      disabled={false}
      labelDisplay="responsive"
    />
  );
}

function depictRailPanel(regionId: RailRegionId): ReactNode {
  return (
    <span className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground">
      <LeftPanelRailIcon
        panelId={leftPanelIdForRailRegion(regionId)}
        hidden={false}
      />
    </span>
  );
}

/**
 * Every region's picture, by id.
 *
 * Private to this module: `depictRegion` is the only way in, so no caller can
 * draw a region without the host-context frame that makes it a picture of the
 * real surface. A region added without an entry is a compile error here.
 */
const REGION_DEPICTIONS: {
  readonly [K in RegionId]: (
    values: LayoutValues[K],
    arrangement: LayoutArrangement,
  ) => ReactNode;
} = {
  homeTab: () => <TabStripHomeItemView isActive={false} onActivate={noop} />,
  usageLimits: depictUsageLimits,
  resourceMonitor: depictResourceMonitor,
  minimap: (_values, arrangement) => depictMinimap(arrangement),
  toolActivity: (values) =>
    depictTranscriptDisclosure({
      icon: Box,
      label: "Explored 3 files, ran 1 command",
      detail: "Read src/lib/session.ts",
      open: values.size === "full",
    }),
  thinking: (values) =>
    depictTranscriptDisclosure({
      icon: Brain,
      label: "Thought for 4s",
      detail: "The token refresh races the retry...",
      open: values.size === "full",
    }),
  timestamps: depictTimestamp,
  contextUsage: depictContextUsage,
  runningAgents: depictRunningAgents,
  changedFiles: depictChangedFiles,
  background: depictBackground,
  todo: depictTodo,
  attachImage: () => <ComposerAttachImageTrigger />,
  access: (values) => (
    <PermissionsTrigger
      label="Full access"
      compact={values.size === "chip"}
      icon={<Shield className="size-4" />}
    />
  ),
  model: depictModel,
  // `ComposerMicButton`'s own button, which gates itself on the preference
  // rather than taking it as a prop - a picture must draw it either way.
  mic: () => (
    <ToolbarIconButton aria-label="Voice input">
      <Mic className="size-4" />
    </ToolbarIconButton>
  ),
  railAgents: () => depictRailPanel("railAgents"),
  railTerminals: () => depictRailPanel("railTerminals"),
  railBrowsers: () => depictRailPanel("railBrowsers"),
  railArtifacts: () => depictRailPanel("railArtifacts"),
  railGitDiff: () => depictRailPanel("railGitDiff"),
  railPullRequests: () => depictRailPanel("railPullRequests"),
  railFileTree: () => depictRailPanel("railFileTree"),
  railSharing: () => depictRailPanel("railSharing"),
  railComments: () => depictRailPanel("railComments"),
};
