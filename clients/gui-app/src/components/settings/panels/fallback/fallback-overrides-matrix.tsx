import { Fragment, type ReactNode } from "react";
import type {
  FallbackPolicy,
  FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import { FALLBACK_REASON_LABELS } from "@traycer/protocol/host/notifications/presentation";
import type { HostNotificationStoppedReason } from "@traycer/protocol/host/notifications/payloads";
import { SettingsGroup } from "@/components/settings/settings-group";
import { HostSettingsDisclosure } from "@/components/settings/panels/host-settings-disclosure";
import { Button } from "@/components/ui/button";
import {
  FALLBACK_MATRIX_RUNGS,
  FALLBACK_RUNG_COPY,
} from "@/components/settings/panels/fallback/fallback-rung-copy";
import {
  EXCLUDED_MATRIX_REASONS,
  FALLBACK_OVERRIDES_DISCLOSURE,
  MATRIX_REASONS,
  REASON_ROW_NOTES,
  RUNG_INELIGIBILITY_COPY,
} from "@/components/settings/panels/fallback/fallback-overrides-copy";
import {
  clearPolicyOverrides,
  effectiveLadderFor,
  overrideChipState,
  policyHasOverrides,
  togglePolicyOverrideRung,
  type OverrideChipState,
} from "@/components/settings/panels/fallback/fallback-overrides-model";
import { cn } from "@/lib/utils";

export interface FallbackOverridesMatrixProps {
  readonly policy: FallbackPolicy;
  /** The editor's four-row order, so a step turned ON here lands in place. */
  readonly rungOrder: readonly FallbackRungKind[];
  readonly onChange: (next: FallbackPolicy) => void;
  readonly status: ReactNode;
}

/**
 * Advanced ▸ per-failure overrides.
 *
 * One row per failure, one chip per step. The row set is DERIVED from the
 * shared taxonomy rather than written out, so "covers every failure exactly"
 * stays true when a reason is added instead of being true on the day it was
 * written.
 *
 * Collapsed by default. It is the only part of this page a user never has to
 * touch: the seeded matrix is the plan's own table, and the ladder already
 * narrows itself per failure without anyone configuring anything.
 */
export function FallbackOverridesMatrix(
  props: FallbackOverridesMatrixProps,
): ReactNode {
  const { policy, rungOrder, onChange, status } = props;
  return (
    <SettingsGroup
      title="Advanced"
      tone="default"
      dataTestId="settings-fallback-overrides-group"
      fill={false}
    >
      {/* The Host panel's disclosure, reused as-is. Its name records where it
          was first needed, not a scope - it is a label-plus-chevron row, and
          the doctor card already reuses it from outside that panel. */}
      <HostSettingsDisclosure label="Per-failure overrides" defaultOpen={false}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="max-w-[68ch] text-ui-sm text-muted-foreground">
            Which steps may run for each kind of failure. Where you change a
            row, those steps replace your main order for that failure - so a
            step can run here while it is off above. Dashed steps can&apos;t
            help with that failure, whatever you prefer.
          </p>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-ui-sm"
            disabled={!policyHasOverrides(policy)}
            onClick={() => {
              onChange(clearPolicyOverrides(policy));
            }}
          >
            Reset overrides only
          </Button>
        </div>
        <p className="mt-3 text-ui-sm text-muted-foreground">
          {FALLBACK_OVERRIDES_DISCLOSURE}
        </p>
        {/* ONE grid for the whole table, not a stack of flex rows: the chip
            columns then align by construction rather than by a fixed label
            width, which is also what keeps this off a px/rem layout size. The
            label column is `minmax(0,1fr)` so it absorbs the slack and its
            contents can wrap; each chip column sizes to its own widest cell. */}
        <div
          className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-2"
          data-testid="fallback-overrides-grid"
        >
          {MATRIX_REASONS.map((reason) => (
            <OverrideRow
              key={reason}
              policy={policy}
              reason={reason}
              rungOrder={rungOrder}
              onChange={onChange}
            />
          ))}
        </div>
        <ExcludedReasonsRow />
        {status}
      </HostSettingsDisclosure>
    </SettingsGroup>
  );
}

/** Exactly four grid cells - the label and the three chip columns. */
function OverrideRow(props: {
  readonly policy: FallbackPolicy;
  readonly reason: HostNotificationStoppedReason;
  readonly rungOrder: readonly FallbackRungKind[];
  readonly onChange: (next: FallbackPolicy) => void;
}): ReactNode {
  const { policy, reason, rungOrder, onChange } = props;
  const note = REASON_ROW_NOTES[reason];
  const ladder = effectiveLadderFor(policy, reason);
  return (
    <Fragment>
      <div className="min-w-0" data-testid={`fallback-override-row-${reason}`}>
        <span className="text-ui-sm text-foreground">
          {FALLBACK_REASON_LABELS[reason]}
        </span>
        {note === null ? null : (
          <span className="ml-1.5 text-ui-xs text-muted-foreground">
            {note}
          </span>
        )}
        {ladder === "off" ? (
          // Only a programmatic writer can produce this; the matrix has no
          // control that writes it. Saying so beats rendering three ordinary
          // grey chips, which would read as a preference the user set - and
          // would be restored wholesale by turning any one of them back on.
          <span className="ml-1.5 text-ui-xs text-muted-foreground">
            Nothing runs for this failure.
          </span>
        ) : null}
      </div>
      {FALLBACK_MATRIX_RUNGS.map((rung) => (
        <OverrideChip
          key={rung}
          reason={reason}
          rung={rung}
          state={overrideChipState(policy, reason, rung)}
          onToggle={() => {
            onChange(
              togglePolicyOverrideRung({ policy, reason, rung, rungOrder }),
            );
          }}
        />
      ))}
    </Fragment>
  );
}

const CHIP_BASE =
  "justify-self-start rounded-full border px-2.5 py-0.5 text-ui-xs transition-colors";

const CHIP_STATE_CLASS: Record<OverrideChipState, string> = {
  runs: "border-emerald-600/60 text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400",
  off: "border-border text-muted-foreground hover:bg-foreground/5",
  impossible: "border-dashed border-border/70 text-muted-foreground/60",
};

function OverrideChip(props: {
  readonly reason: HostNotificationStoppedReason;
  readonly rung: FallbackRungKind;
  readonly state: OverrideChipState;
  readonly onToggle: () => void;
}): ReactNode {
  const { reason, rung, state, onToggle } = props;
  const label = FALLBACK_RUNG_COPY[rung].chipLabel;
  const why = RUNG_INELIGIBILITY_COPY[reason][rung];

  if (state === "impossible") {
    // A `<span>`, not a disabled `<button>`. A disabled control says "not right
    // now"; this is "never, for this failure". It must not sit in the tab order
    // offering an action that does not exist. The why is part of the chip's own
    // text rather than a `title`, so a screen reader gets it with the label
    // instead of from an attribute it may never announce.
    return (
      <span className={cn(CHIP_BASE, CHIP_STATE_CLASS.impossible)}>
        {label}
        {why === null ? null : <span> - {why}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={state === "runs"}
      // Six rows carry a chip reading "other profile"; without this they are
      // six identically-named buttons to anyone not looking at the grid. The
      // visible text stays the START of the accessible name, so a voice-control
      // user saying what they can see still matches.
      aria-label={`${label} for ${FALLBACK_REASON_LABELS[reason]}`}
      className={cn(CHIP_BASE, CHIP_STATE_CLASS[state])}
    >
      {label}
      {state === "runs" ? <span aria-hidden> ✓</span> : null}
    </button>
  );
}

/**
 * The five failures no step can ever help, as one read-only line.
 *
 * Read-only by design: exclusion is not a preference. Two different arguments
 * put a reason here - the same request reproduces the failure on any provider
 * (a context limit, a refused request), or the failure is this host's own view
 * of a run that stopped rather than the provider's capacity - and neither is
 * something a switch could change. A control here would invite someone to turn
 * on a step that cannot run and then wonder why it never does.
 */
function ExcludedReasonsRow(): ReactNode {
  const labels = EXCLUDED_MATRIX_REASONS.map(
    (reason) => FALLBACK_REASON_LABELS[reason],
  );
  return (
    <p
      className="mt-3 max-w-[68ch] text-ui-xs text-muted-foreground"
      data-testid="fallback-override-excluded-row"
    >
      {labels.length} more - {labels.join(", ")} - never switch or wait. Either
      the same request would fail the same way on any provider, or what failed
      was the run itself rather than the provider.
    </p>
  );
}
