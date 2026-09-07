import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import {
  AgentSpinningDots,
  MutedAgentSpinner,
} from "@/components/ui/agent-spinning-dots";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { Settings } from "lucide-react";
import { useId, type ReactNode } from "react";
import type {
  HarnessOption,
  ProviderId,
} from "@/components/home/data/landing-options";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import {
  singleDigitLeaderDigitFor,
  usePickerProviderLeaderForIndex,
} from "@/providers/keybinding-context";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  harnessAvailabilityUnsettled,
  railEntryKey,
  visibleRailEntries,
  type RailEntry,
} from "@/components/home/pickers/harness-rail-providers";
import { AccentDot } from "@/components/providers/accent-dot";
import {
  providerPackBlocksExecution,
  providerPackPreparingLabel,
  providerPackPreparingShortLabel,
  providerPackRetryable,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { cn } from "@/lib/utils";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

const LOCKED_PROVIDER_TOOLTIP =
  "Provider cannot be changed while forking terminal agent";

interface ProviderRailProps {
  readonly harnesses: ReadonlyArray<HarnessOption>;
  readonly fallbackHarnesses: ReadonlyArray<HarnessOption>;
  readonly profilesByHarnessId: ReadonlyMap<
    GuiHarnessId,
    ReadonlyArray<ProviderProfile>
  >;
  readonly activeProviderId: ProviderId;
  readonly activeProfileIdByHarnessId: ReadonlyMap<GuiHarnessId, string | null>;
  readonly lockedHarnessId: ProviderId | null;
  readonly degradedHarnessIds: ReadonlySet<GuiHarnessId>;
  readonly preparingByHarnessId: ReadonlyMap<
    GuiHarnessId,
    ProviderPackPreparing
  >;
  readonly pending: boolean;
  readonly onEntryChange: (providerId: ProviderId) => void;
  readonly onRetryPack: (providerId: ProviderId) => void;
  readonly onOpenProviderSettings: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly refreshDisabledReason: string | undefined;
}

export function ProviderRail(props: ProviderRailProps) {
  const {
    harnesses,
    fallbackHarnesses,
    profilesByHarnessId,
    activeProviderId,
    activeProfileIdByHarnessId,
    lockedHarnessId,
    degradedHarnessIds,
    preparingByHarnessId,
    pending,
    onEntryChange,
    onRetryPack,
    onOpenProviderSettings,
    onRefresh,
    refreshDisabledReason,
  } = props;
  const entries = visibleRailEntries({
    harnesses,
    fallbackHarnesses,
    degradedHarnessIds,
    preparingByHarnessId,
    profilesByHarnessId,
    activeProfileIdByHarnessId,
  });
  const activeEntryKey = railEntryKey(activeProviderId);

  return (
    // The settings gear is a sibling of the tablist, not a child - only tab
    // elements belong inside `role="tablist"` for correct screen-reader nav.
    <div className="flex min-h-0 flex-col items-center border-r bg-muted/20 p-1">
      <div
        role="tablist"
        aria-label="Model providers"
        className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain px-1 pt-1"
      >
        {pending && entries.length === 0 ? (
          <span className="mt-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground">
            <MutedAgentSpinner />
          </span>
        ) : null}
        {entries.map((entry, index) => (
          <ProviderRailButton
            key={railEntryKey(entry.harness.id)}
            entry={entry}
            index={index}
            active={railEntryKey(entry.harness.id) === activeEntryKey}
            disabled={
              (lockedHarnessId !== null &&
                entry.harness.id !== lockedHarnessId) ||
              harnessAvailabilityUnsettled(entry.harness)
            }
            onEntryChange={onEntryChange}
            onRetryPack={onRetryPack}
          />
        ))}
      </div>
      <RefreshIconButton
        onRefresh={onRefresh}
        label="Refresh providers & models"
        disabledReason={refreshDisabledReason}
        className="mt-1"
      />
      <TooltipWrapper
        label="Provider CLI settings"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          aria-label="Provider CLI settings"
          onClick={onOpenProviderSettings}
          className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Settings className="size-4" />
        </button>
      </TooltipWrapper>
    </div>
  );
}

interface ProviderRailButtonProps {
  readonly entry: RailEntry;
  readonly index: number;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onEntryChange: (providerId: ProviderId) => void;
  readonly onRetryPack: (providerId: ProviderId) => void;
}

// Hover/AT title for a rail tab: surfaces the probe-in-flight state, then the fork-lock reason, then the
// managed-pack preparing state, else the plain label.
function railButtonTitle(entry: RailEntry, disabled: boolean): string {
  if (harnessAvailabilityUnsettled(entry.harness)) {
    return `${entry.harness.label} — checking availability…`;
  }
  if (disabled) return LOCKED_PROVIDER_TOOLTIP;
  if (entry.preparing !== null) {
    const status = providerPackPreparingLabel(
      entry.preparing,
      entry.harness.label,
    );
    // Only a pack whose failure a retry can actually move gets the retry sentence - a terminal `unrepairable` cell
    // would be inviting a click the host is guaranteed to no-op.
    return railEntryPackRetryable(entry) ? `${status} Click to retry.` : status;
  }
  return entry.harness.label;
}

// A pack state only gates when the provider has nowhere to fall back to (`providerPackBlocksExecution`);
// otherwise the tab stays selectable and the progress ring is pure information.
function railEntryPackGated(entry: RailEntry): boolean {
  const preparing = entry.preparing;
  return preparing !== null && providerPackBlocksExecution(preparing);
}

function railEntryPackRetryable(entry: RailEntry): boolean {
  const preparing = entry.preparing;
  if (preparing === null || !providerPackBlocksExecution(preparing)) {
    return false;
  }
  return providerPackRetryable(preparing);
}

// Accessible name for a rail tab. Mirrors `railButtonTitle`'s precedence so a
// screen reader and a hover tooltip never describe the tab differently.
function railButtonAriaLabel(entry: RailEntry): string {
  // `harnessAvailabilityUnsettled`, not `availabilityPending`: a revalidating harness keeps its verdict and
  // stays fully interactive, so announcing it as "loading…" every 30s would be noise.
  if (harnessAvailabilityUnsettled(entry.harness)) {
    return `${entry.harness.label} — loading…`;
  }
  // A gated tab keeps it in the name too, because there the sentence IS the reason the tab cannot be used.
  if (entry.preparing !== null && railEntryPackGated(entry)) {
    return providerPackPreparingLabel(entry.preparing, entry.harness.label);
  }
  return entry.harness.label;
}

// The pack-preparing reason outranks "Setup required": a provider whose bytes have not arrived cannot
// meaningfully be signed into yet, so leading with the auth prompt would be misdirection.
function railButtonDescribedBy(
  entry: RailEntry,
  ids: {
    readonly preparingDescriptionId: string;
    readonly degradedDescriptionId: string;
  },
): string | undefined {
  // Same narrowing as `railButtonAriaLabel`, for the same reason.
  if (harnessAvailabilityUnsettled(entry.harness)) return undefined;
  if (entry.preparing !== null) return ids.preparingDescriptionId;
  if (entry.degraded) return ids.degradedDescriptionId;
  return undefined;
}

function railButtonClassName(state: {
  readonly active: boolean;
  readonly degraded: boolean;
  readonly packGated: boolean;
  readonly packRetryable: boolean;
}): string {
  return cn(
    "relative flex size-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
    state.active
      ? "bg-primary/10 text-foreground shadow-sm ring-1 ring-primary/25 hover:bg-primary/15 hover:text-foreground"
      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
    state.degraded
      ? "opacity-60 hover:opacity-80 data-[active=true]:opacity-75"
      : "",
    state.packGated ? "opacity-60" : "",
    state.packRetryable ? "cursor-pointer" : "",
    "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground",
  );
}

// Split out so each can call the leader hook (hooks can't run in a `.map`). The ⌘-digit badge masks the icon's
// right edge while the leader is held; switching is pure state (no focus move), so the search box keeps focus.
function ProviderRailButton(props: ProviderRailButtonProps) {
  const { entry, index, active, disabled, onEntryChange, onRetryPack } = props;
  const leaderModifier = usePickerProviderLeaderForIndex(index);
  const degradedDescriptionId = useId();
  const preparingDescriptionId = useId();
  const harness = entry.harness;
  const preparing = entry.preparing;
  // The settled UX decision, mirroring the dictation mic: a provider that cannot run is gated and labelled,
  // never selectable and never silently missing.
  const packGated = railEntryPackGated(entry);
  // ...with one exception that is a real affordance rather than a leak: a failed pack's tab is clickable, and
  // the click means "retry", not "select".
  const packRetryable = railEntryPackRetryable(entry);
  const selectable = !disabled && !packGated;
  // A retryable (failed) tab keeps keyboard focus - the retry IS its action.
  const focusable = selectable || packRetryable;
  const handleClick = (): void => {
    if (disabled) return;
    // A failed pack's only action is retry; a downloading one has none.
    if (packGated) {
      if (packRetryable) onRetryPack(harness.id);
      return;
    }
    onEntryChange(harness.id);
  };
  const unsettled = harnessAvailabilityUnsettled(harness);
  return (
    // One wrapper, not two: `railButtonTitle` already resolves the locked reason, the "checking availability…"
    // state and the plain harness label, so a second wrapper for the locked case put two tooltips on one trigger.
    <TooltipWrapper
      label={railButtonTitle(entry, disabled)}
      side="right"
      sideOffset={6}
      align={undefined}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-disabled={selectable ? undefined : true}
        aria-label={railButtonAriaLabel(entry)}
        aria-describedby={railButtonDescribedBy(entry, {
          preparingDescriptionId,
          degradedDescriptionId,
        })}
        tabIndex={focusable ? undefined : -1}
        data-active={active}
        data-degraded={entry.degraded ? true : undefined}
        data-pack-preparing={preparing === null ? undefined : preparing.kind}
        className={railButtonClassName({
          active,
          degraded: entry.degraded,
          packGated,
          packRetryable,
        })}
        onClick={handleClick}
      >
        {unsettled ? (
          <>
            <span className="opacity-25">
              <HarnessIcon harnessId={harness.id} />
            </span>
            <span className="absolute inset-0 flex items-center justify-center">
              <AgentSpinningDots
                className="text-muted-foreground"
                testId={undefined}
                variant={undefined}
              />
            </span>
          </>
        ) : (
          <>
            <RailButtonIcon entry={entry} />
            <PreparingDescription
              id={preparingDescriptionId}
              preparing={preparing}
            />
            {entry.accentDot !== null ? (
              <AccentDot
                profileId={entry.accentDot.profileId}
                accentColor={entry.accentDot.accentColor}
                label={entry.accentDot.label}
                variant="corner"
                size="default"
                className={undefined}
              />
            ) : null}
            {entry.degraded ? (
              <span id={degradedDescriptionId} className="sr-only">
                Setup required
              </span>
            ) : null}
            <PickerLeaderBadge
              show={leaderModifier !== null && selectable}
              index={index}
              // Degraded providers stay browse-only (the leader digit browses,
              // it does not commit), so the hint must not over-promise "switch".
              hintAction={entry.degraded ? "to browse" : "to switch"}
              hintTarget={harness.label}
              testId={`model-provider-digit-${singleDigitLeaderDigitFor(index)}`}
              placement="corner"
            />
          </>
        )}
      </button>
    </TooltipWrapper>
  );
}

function PreparingDescription(props: {
  readonly id: string;
  readonly preparing: ProviderPackPreparing | null;
}): ReactNode {
  if (props.preparing === null) return null;
  return (
    <span id={props.id} className="sr-only">
      {providerPackPreparingShortLabel(props.preparing)}
    </span>
  );
}

// The tab's glyph: the plain harness icon, or the same icon inside a progress ring while its pack is being
// readied.
function RailButtonIcon(props: { readonly entry: RailEntry }): ReactNode {
  const { harness, preparing } = props.entry;
  if (preparing === null) return <HarnessIcon harnessId={harness.id} />;
  const failed = preparing.kind === "error";
  if (failed && !providerPackBlocksExecution(preparing)) {
    return <HarnessIcon harnessId={harness.id} />;
  }
  return (
    <PackProgressRing percent={preparing.percent} failed={failed}>
      <HarnessIcon harnessId={harness.id} />
    </PackProgressRing>
  );
}

/** A failed pack gets a static destructive-toned ring rather than a spinner - a stuck install must never
 * animate like a progressing one. */
function PackProgressRing(props: {
  readonly percent: number | null;
  readonly failed: boolean;
  readonly children: ReactNode;
}) {
  const radius = 8.5;
  const circumference = 2 * Math.PI * radius;
  const determinate = props.percent !== null;
  const clamped = determinate
    ? Math.min(1, Math.max(0, props.percent / 100))
    : 0;
  return (
    <span className="relative inline-flex size-5 items-center justify-center">
      <svg
        viewBox="0 0 20 20"
        className={cn(
          "absolute inset-0 size-full -rotate-90",
          !determinate && !props.failed && "animate-spin",
          props.failed && "text-destructive",
        )}
        aria-hidden
      >
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth="2"
        />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={
            determinate
              ? circumference
              : circumference * (props.failed ? 1 : 0.3)
          }
          strokeDashoffset={determinate ? circumference * (1 - clamped) : 0}
        />
      </svg>
      <span className="scale-75">{props.children}</span>
    </span>
  );
}
