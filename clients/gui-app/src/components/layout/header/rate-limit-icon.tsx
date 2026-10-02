import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";
import {
  useStatusBarRateLimitSegments,
  useStatusBarWindowedProviders,
  type StatusBarRateLimitCluster,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { useRateLimitResolveHostScope } from "@/hooks/rate-limits/use-rate-limit-host-scope";
import {
  useRateLimitProfileSelection,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
  RUNNING_LOW_TEXT_CLASS_NAME,
  type RateLimitWindowSeverity,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";
import { StatusBarProviderMountRefresh } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";
import {
  statusBarClusterSegments,
  statusBarUsageTriggerName,
  useStatusBarUsageDisplay,
} from "@/components/layout/status-bar/status-bar-usage-display";
import type { BarReadingForm } from "@/components/layout/tabs/side-strip/side-strip-tokens";
import {
  SideStripUsageRows,
  TopStripUsageRows,
} from "@/components/layout/header/usage-profile-rows";
import { useResetCountdown } from "@/lib/relative-time";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";

const EMPTY_BAR_KEYS = ["primary", "secondary"] as const;

/** One bar of the icon forms: a window the reading draws, at its severity. */
interface GlyphBar {
  readonly key: string;
  readonly usedPercent: number;
  readonly severity: RateLimitWindowSeverity;
  readonly degraded: boolean;
}

/** The cluster the placeholder path draws: nothing to read yet. */
const NO_CLUSTER: StatusBarRateLimitCluster = { kind: "no-providers" };

/**
 * Header trigger for the provider rate-limit popover, scoped to the host the
 * popover's own picker selected.
 *
 * The scope is resolved HERE, above both the glyph and the popover, and
 * re-provided as this subtree's `HostRuntimeContext`. That one swap is what
 * re-targets the whole surface: every hook below reaches its host through
 * `useHostClient()` / `useAddressableHostId()`, and both read the binding
 * from context, so the query keys, the usage fetch scope and the
 * invalidations all move together and cannot end up describing different
 * machines. Nothing outside this subtree moves — picking a host to WATCH is
 * not picking where new work lands (`stores/rate-limits/rate-limit-popover-store`).
 *
 * `useScopedHostBinding` returns null while the pick is the active host, or
 * while it has not resolved to its own client — in both cases the value below
 * falls back to the AMBIENT binding, which is exactly what this subtree read
 * before there was a picker at all.
 *
 * The provider is rendered unconditionally, and that is load-bearing rather
 * than tidiness. Mounting it only when a scoped binding exists changes the
 * element type at this position the moment a pick resolves, so React unmounts
 * the whole subtree and mounts a fresh one — taking the popover's own `open`
 * state with it. The popover therefore closed the instant a host was chosen
 * from the picker inside it, which is to say the control could not be used.
 * The fallback re-provides the ambient binding VERBATIM (never a copy), so a
 * subtree that is not scoped still sees ambient binding updates.
 */
export function RateLimitIconButton(props: {
  /** How the button draws at the placement it sits in. */
  readonly form: BarReadingForm;
}): ReactNode {
  const { scope, hasExplicitPick } = useRateLimitResolveHostScope();
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      <ScopedRateLimitIconButton
        scope={scope}
        hasExplicitPick={hasExplicitPick}
        form={props.form}
      />
    </HostRuntimeContext.Provider>
  );
}

/**
 * Its compact outlined surface combines a recognizable gauge icon with the two
 * live usage bars, so the control still reads as an intentional button when
 * both fills are 0%. Clicking opens the popover in any glyph state, including
 * empty (which lands on the zero-provider CTA).
 *
 * Never gates on data loading: a cold provider is a segment with an empty
 * track, and no provider at all is the neutral "Usage" line or the glyph's
 * empty tracks - there is no separate loading state and no fabricated
 * placeholder usage.
 */
function ScopedRateLimitIconButton({
  scope,
  hasExplicitPick,
  form,
}: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly form: BarReadingForm;
}): ReactNode {
  const placement = useColumnOverlayPlacement("foot");
  const [open, setOpen] = useState(false);
  const chord = useBindingForAction("app.rate-limits.open");
  useEffect(
    () =>
      registerDynamicActionHandler("app.rate-limits.open", () => {
        setOpen(true);
      }),
    [],
  );
  useTitleBarDragSuppression("rate-limits", open);
  // One subscription bridge owns the checked-account + per-harness profile
  // state for both the always-mounted glyph and the lazily-mounted popover,
  // keyed by the host this surface is watching - the accounts it names are
  // that host's, not the app-wide one's.
  const profileSelection = useRateLimitProfileSelection(scope.hostId);
  // A PICK that has not resolved to its own client leaves this subtree on the
  // AMBIENT binding, so mounting the bars here would draw one host's usage
  // under a glyph that stands for another - and the glyph, unlike every panel
  // in the popover, has no room to name the host it is describing. The neutral
  // placeholder is the honest reading, and keeping the hook out of the tree
  // (rather than discarding its output) also stops it driving fetch-on-mount
  // subprocesses against the host the user did not choose.
  //
  // Without a pick there is no second host to confuse this one with: the
  // ambient binding is the only thing the glyph has ever meant, and an
  // `unreachable` active host is the routine blip the envelope's last-good
  // retention is built to ride out. Blanking the bars there would be a
  // regression paid by every single-host user for a picker they never opened.
  const scopedToOwnHost = !hasExplicitPick || isHostScopeUsable(scope.status);
  const tooltipLabel = scope.isViewingActive
    ? "Usage limits"
    : `Usage limits · ${scope.hostLabel}`;
  const tooltip =
    chord === null
      ? tooltipLabel
      : `${tooltipLabel} (${formatChordForDisplay(chord)})`;

  // The Detailed forms name themselves (R1-A3), and carry their own
  // per-profile tooltips, so only the glyph forms get the button's tooltip.
  const readings = form === "inline" || form === "rows";
  const trigger = (
    <PopoverTrigger asChild>
      <Button
        type="button"
        {...usageButtonLook(form)}
        aria-label={readings ? undefined : "Usage limits"}
        data-testid="rate-limit-header-button"
      >
        {scopedToOwnHost ? (
          <LiveRateLimitGlyph profileSelection={profileSelection} form={form} />
        ) : (
          <RateLimitTriggerContent cluster={NO_CLUSTER} form={form} />
        )}
      </Button>
    </PopoverTrigger>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {readings ? (
        trigger
      ) : (
        <TooltipWrapper
          // The host belongs in the label only when it is NOT the obvious one.
          // Naming the active host on every hover would train people to ignore
          // the one case the words exist for.
          label={tooltip}
          side={placement?.side ?? "top"}
          sideOffset={6}
          align={placement?.align}
        >
          {trigger}
        </TooltipWrapper>
      )}
      <RateLimitPopover
        side="bottom"
        align="end"
        onClose={() => setOpen(false)}
        profileSelection={profileSelection}
        scope={scope}
        hasExplicitPick={hasExplicitPick}
      />
    </Popover>
  );
}

/**
 * How the usage button draws in each form: the phone header's and the rail's
 * outlined glyph, the expanded strip's outlined tile, the top strip's ghost
 * glyph or Detailed readings (bounded by the two-profile cap, so never
 * squeezed), and the side strip's Detailed block as one full-width button.
 */
function usageButtonLook(
  form: BarReadingForm,
): Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> {
  switch (form) {
    case "glyph":
      return { variant: "outline", size: "sm", className: "shadow-xs" };
    case "tile":
    case "readout":
      return { variant: "outline", size: "sm", className: "w-full shadow-xs" };
    case "strip":
      return { variant: "ghost", size: "sm", className: undefined };
    case "inline":
      // Never shrunk: capped at two profiles, the reading is bounded already,
      // and a squeezed one would cut a name.
      return { variant: "ghost", size: "sm", className: undefined };
    case "rows":
      return { variant: "ghost", size: "inline", className: "w-full" };
  }
}

/**
 * The reading over live data, through the status bar's own selector (G6): the
 * same providers in the same order, the same hidden providers, the same limits
 * and the same checked accounts. The tab strip used to read a fixed pair of its
 * own, so every one of those settings did nothing while the reading lived
 * there. Split from the trigger so the hooks are mounted only when this subtree
 * is bound to the host being displayed - see `scopedToOwnHost` above.
 *
 * Every form owns its fetching the way the status bar's cluster does, the
 * phone header's glyph included: the phone footer is opt-in and off by
 * default, and HTTP providers are not in the background poll, so a glyph that
 * left fetching to the footer read a cold cache (G6 review A). When the footer
 * is on too, the query cache and `fetchProviderRateLimits` share one request.
 */
function LiveRateLimitGlyph({
  profileSelection,
  form,
}: {
  readonly profileSelection: RateLimitProfileSelection;
  readonly form: BarReadingForm;
}): ReactNode {
  const providers = useStatusBarWindowedProviders();
  const sample = useSampleScene();
  const { cluster, mountTargets } = useStatusBarRateLimitSegments({
    providers,
    profileSelection,
    mode: "live",
    editing: false,
    sample,
  });
  return (
    <>
      <RateLimitTriggerContent cluster={cluster} form={form} />
      {mountTargets.map((target) => (
        <StatusBarProviderMountRefresh
          key={`${target.providerId}:${target.profileId ?? ""}`}
          target={target}
        />
      ))}
    </>
  );
}

/**
 * The Detailed readings in the forms that have the room for them, or the glyph
 * (with the limit state) everywhere else.
 */
function RateLimitTriggerContent({
  cluster,
  form,
}: {
  readonly cluster: StatusBarRateLimitCluster;
  readonly form: BarReadingForm;
}): ReactNode {
  if (form === "inline" || form === "rows") {
    return <UsageReadings cluster={cluster} form={form} />;
  }
  return <UsageGlyphParts cluster={cluster} showReset={form !== "tile"} />;
}

/**
 * The Detailed reading: the top strip's two most-used profiles, or the side
 * strip's rows, over the same segments the status bar reads.
 */
function UsageReadings({
  cluster,
  form,
}: {
  readonly cluster: StatusBarRateLimitCluster;
  readonly form: "inline" | "rows";
}): ReactNode {
  const display = useStatusBarUsageDisplay();
  if (cluster.kind !== "segments") {
    return (
      <>
        <span className="sr-only">Usage limits</span>
        <Gauge className="size-3.5" aria-hidden />
        <span aria-hidden className="text-ui-xs text-muted-foreground">
          Usage
        </span>
      </>
    );
  }
  return (
    <>
      <span className="sr-only">
        {statusBarUsageTriggerName(cluster, display.percentMode)}
      </span>
      {form === "inline" ? (
        <TopStripUsageRows cluster={cluster} />
      ) : (
        <SideStripUsageRows cluster={cluster} />
      )}
    </>
  );
}

/** The glyph's two slots. */
const GLYPH_BAR_COUNT = 2;

/** What the glyph draws for a cluster: its bars, and whether a limit is hit. */
interface UsageGlyphReading {
  readonly bars: ReadonlyArray<GlyphBar>;
  /** The soonest reset among the limited windows, when any reports one. */
  readonly limitedResetsAt: number | null;
  readonly limited: boolean;
}

/**
 * The glyph's reading: the two highest-used windows among the shown profiles,
 * and the limit state across ALL shown windows (a limit past the first two
 * still turns the gauge). The icon follows the hidden providers, the order and
 * the limits; what it cannot follow is the Detailed form's text.
 */
function usageGlyphReading(
  cluster: StatusBarRateLimitCluster,
): UsageGlyphReading {
  const windows = statusBarClusterSegments(cluster).flatMap((segment) =>
    segment.state === "unavailable"
      ? []
      : segment.shown.map((window) => ({
          key: `${segment.providerId}:${segment.profileId ?? ""}:${window.windowKey}`,
          usedPercent: window.usedPercent,
          severity: window.severity,
          degraded: segment.state === "degraded",
          resetsAt: window.resetsAt,
        })),
  );
  const resets = windows.flatMap((window) =>
    window.severity === "limited" && window.resetsAt !== null
      ? [window.resetsAt]
      : [],
  );
  return {
    bars: [...windows]
      .sort((a, b) => b.usedPercent - a.usedPercent)
      .slice(0, GLYPH_BAR_COUNT),
    limitedResetsAt: resets.length === 0 ? null : Math.min(...resets),
    limited: windows.some((window) => window.severity === "limited"),
  };
}

/**
 * The usage glyph with no button around it: the gauge, the two bars of the two
 * highest-used windows, and the limit state (a destructive gauge, and the short
 * reset time after the bars). Every Compact placement draws this, inside its
 * own button or, in the status bar, unboxed.
 */
export function UsageGlyph({
  cluster,
}: {
  readonly cluster: StatusBarRateLimitCluster;
}): ReactNode {
  return <UsageGlyphParts cluster={cluster} showReset />;
}

/** `UsageGlyph`, with the reset time optional for the 40px rail tile. */
function UsageGlyphParts({
  cluster,
  showReset,
}: {
  readonly cluster: StatusBarRateLimitCluster;
  readonly showReset: boolean;
}): ReactNode {
  const { bars, limited, limitedResetsAt } = usageGlyphReading(cluster);
  const countdown = useResetCountdown(limitedResetsAt);
  const isEmpty = bars.length === 0;
  const isDegraded = !isEmpty && bars.some((bar) => bar.degraded);
  return (
    <>
      <Gauge
        data-testid="rate-limit-gauge-icon"
        className={cn(
          "size-3.5",
          isDegraded && RUNNING_LOW_TEXT_CLASS_NAME,
          limited && "text-destructive",
        )}
        aria-hidden
      />
      <span
        aria-hidden
        className="inline-flex flex-col items-start gap-[2.5px]"
      >
        {isEmpty
          ? EMPTY_BAR_KEYS.map((key) => (
              <span
                key={key}
                data-testid="rate-limit-bar-track"
                className="relative h-1 w-4 overflow-hidden rounded-xs bg-muted-foreground/35 dark:bg-muted-foreground/40"
              />
            ))
          : bars.map((bar) => (
              <span
                key={bar.key}
                data-testid="rate-limit-bar-track"
                className="relative h-1 w-4 overflow-hidden rounded-xs bg-muted-foreground/35 dark:bg-muted-foreground/40"
              >
                <span
                  data-testid="rate-limit-bar-fill"
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-xs",
                    rateLimitWindowSeverityBarClassName(bar.severity),
                  )}
                  style={{
                    width: `${rateLimitWindowFillPercent(bar.usedPercent)}%`,
                  }}
                />
              </span>
            ))}
      </span>
      {limited && showReset && countdown !== null ? (
        <span
          data-testid="rate-limit-glyph-reset"
          className="text-ui-xs text-destructive"
        >
          {shortCountdown(countdown)}
        </span>
      ) : null}
    </>
  );
}

/** `4h 15m` is `4h` here: the glyph has room for one unit. */
function shortCountdown(countdown: string): string {
  return countdown.split(" ")[0] ?? countdown;
}
