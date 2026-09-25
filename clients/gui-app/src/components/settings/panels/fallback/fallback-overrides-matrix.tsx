import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  REASON_ELIGIBLE_RUNGS,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import { FALLBACK_REASON_LABELS } from "@traycer/protocol/host/notifications/presentation";
import type { HostNotificationStoppedReason } from "@traycer/protocol/host/notifications/payloads";
import { SettingsGroup } from "@/components/settings/settings-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { FRESH_SESSION_HELPER } from "@/components/chat/fallback/fallback-copy";
import {
  EXCLUDED_MATRIX_REASONS,
  MATRIX_REASONS,
  RUNG_INELIGIBILITY_COPY,
} from "./fallback-overrides-copy";
import {
  effectiveLadderFor,
  policyHasOverrides,
  togglePolicyOverrideRung,
} from "./fallback-overrides-model";
import {
  describeOverride,
  overrideActionOrder,
  overrideRungAfterNotify,
  OVERRIDE_ACTION_LABELS,
  OVERRIDE_ACTION_HELP,
  OVERRIDE_STEP_LABELS,
} from "./fallback-overrides-presentation";
import type { OverrideResetUndo } from "./fallback-overrides-reset";
import { FALLBACK } from "../fallback-settings.definitions";
import { cn } from "@/lib/utils";

export interface FallbackOverridesMatrixProps {
  readonly policy: FallbackPolicy;
  readonly rungOrder: readonly FallbackRungKind[];
  readonly onChange: (
    next: FallbackPolicy,
    reason: HostNotificationStoppedReason,
  ) => void;
  readonly onReset: (reason: HostNotificationStoppedReason | null) => void;
  readonly onUndo: () => void;
  readonly undo: OverrideResetUndo | null;
  readonly attentionReason: HostNotificationStoppedReason | null;
  readonly previewUnconfirmed: boolean;
  readonly status: ReactNode;
}

const EDITABLE_REASONS = MATRIX_REASONS.filter(
  (reason) => REASON_ELIGIBLE_RUNGS[reason].length > 0,
);
const FIXED_REASONS = MATRIX_REASONS.filter(
  (reason) => REASON_ELIGIBLE_RUNGS[reason].length === 0,
);

/** Per-problem choices; the wire policy and its save lifecycle stay in the parent. */
export function FallbackOverridesMatrix(
  props: FallbackOverridesMatrixProps,
): ReactNode {
  const {
    policy,
    rungOrder,
    onChange,
    onReset,
    onUndo,
    undo,
    attentionReason,
    previewUnconfirmed,
    status,
  } = props;
  const [expanded, setExpanded] =
    useState<HostNotificationStoppedReason | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const excludedNeedsAttention =
    attentionReason !== null &&
    EXCLUDED_MATRIX_REASONS.includes(attentionReason);
  const customCount = Object.keys(policy.reasonOverrides ?? {}).length;
  return (
    <SettingsGroup
      group={FALLBACK.definitions.advanced}
      showTitle={false}
      tone="default"
      dataTestId="settings-fallback-overrides-group"
      fill={false}
    >
      <div className="@container min-w-0 space-y-4 px-4 py-4 sm:px-5">
        <div className="space-y-1.5">
          <h3
            ref={heading}
            tabIndex={-1}
            className="text-ui-base font-semibold text-foreground"
          >
            When a problem happens
          </h3>
          <p className="text-ui-sm text-muted-foreground">
            Use your main plan, or choose different actions for a specific
            problem.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-border bg-foreground/3 px-3 py-2.5 text-ui-xs">
          <span className="font-medium">Your main plan</span>
          <span className="min-w-0 text-muted-foreground">
            {policy.ladder.length === 0
              ? "No recovery actions configured"
              : policy.ladder
                  .map((rung) => OVERRIDE_STEP_LABELS[rung])
                  .join(" → ")}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-ui-xs text-muted-foreground">
            {EDITABLE_REASONS.length} problems ·{" "}
            {customCount === 0
              ? "All follow main plan"
              : `${customCount} custom`}
          </p>
          <Button
            size="touch"
            variant="link"
            type="button"
            disabled={!policyHasOverrides(policy)}
            onClick={() => onReset(null)}
          >
            Reset all to main plan
          </Button>
        </div>
        {/* Save failures remain visible when the edited row is collapsed. */}
        {status}
        {undo === null ? null : (
          <div
            className="flex flex-wrap items-center gap-x-3 rounded-md border border-border px-3 text-ui-xs"
            role="status"
          >
            <span>{undo.message}</span>
            <Button
              type="button"
              variant="link"
              size="touch"
              disabled={undo.disabled}
              onClick={() => {
                onUndo();
                heading.current?.focus();
              }}
            >
              Undo
            </Button>
          </div>
        )}
        <div
          className="min-w-0 divide-y divide-border overflow-hidden rounded-lg border border-border"
          data-testid="fallback-overrides-list"
        >
          {EDITABLE_REASONS.map((reason) => (
            <OverrideRow
              key={reason}
              policy={policy}
              reason={reason}
              rungOrder={rungOrder}
              open={expanded === reason}
              onOpenChange={(open) => setExpanded(open ? reason : null)}
              onChange={onChange}
              onReset={onReset}
              needsAttention={attentionReason === reason}
              previewUnconfirmed={previewUnconfirmed}
            />
          ))}
        </div>
        <div className="space-y-2">
          <h4 className="text-ui-xs font-medium text-muted-foreground">
            No actions to choose
          </h4>
          <div className="space-y-3 rounded-lg border border-border px-4 py-3">
            {FIXED_REASONS.map((reason) => (
              <FixedReason
                key={reason}
                policy={policy}
                reason={reason}
                onReset={onReset}
                needsAttention={attentionReason === reason}
                previewUnconfirmed={previewUnconfirmed}
              />
            ))}
            <details
              className="border-t border-border pt-1"
              data-testid="fallback-override-excluded-row"
            >
              <summary className="min-h-11 cursor-pointer content-center text-ui-xs text-muted-foreground">
                {EXCLUDED_MATRIX_REASONS.length} other problems need your
                attention
                {excludedNeedsAttention ? (
                  <Badge variant="warning" className="ml-2">
                    Check save
                  </Badge>
                ) : null}
              </summary>
              <p className="mb-2 text-ui-xs text-muted-foreground">
                Traycer won’t switch or wait for these problems because
                automatic routing cannot resolve them.
              </p>
              <ul className="space-y-2">
                {EXCLUDED_MATRIX_REASONS.map((reason) => (
                  <li key={reason}>
                    <FixedReason
                      policy={policy}
                      reason={reason}
                      onReset={onReset}
                      needsAttention={attentionReason === reason}
                      previewUnconfirmed={previewUnconfirmed}
                    />
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      </div>
    </SettingsGroup>
  );
}

function OverrideRow(props: {
  readonly policy: FallbackPolicy;
  readonly reason: HostNotificationStoppedReason;
  readonly rungOrder: readonly FallbackRungKind[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChange: (
    next: FallbackPolicy,
    reason: HostNotificationStoppedReason,
  ) => void;
  readonly onReset: (reason: HostNotificationStoppedReason | null) => void;
  readonly needsAttention: boolean;
  readonly previewUnconfirmed: boolean;
}): ReactNode {
  const {
    policy,
    reason,
    rungOrder,
    open,
    onOpenChange,
    onChange,
    onReset,
    needsAttention,
    previewUnconfirmed,
  } = props;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = panel.current;
    if (!open || content === null) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      trigger.current?.focus();
    };
    content.addEventListener("keydown", closeOnEscape);
    return () => content.removeEventListener("keydown", closeOnEscape);
  }, [open, onOpenChange]);
  let previewLead = "May try available steps in this order:";
  if (!policy.enabled) previewLead = "If automatic routing is turned on:";
  if (previewUnconfirmed)
    previewLead = "Preview of these choices — save not confirmed.";
  const label = FALLBACK_REASON_LABELS[reason];
  const custom = policy.reasonOverrides?.[reason] !== undefined;
  const ladder = effectiveLadderFor(policy, reason);
  const description = describeOverride(policy, reason);
  const eligibleRungs = new Set(REASON_ELIGIBLE_RUNGS[reason]);
  const hasSwitch =
    ladder !== "off" &&
    ladder.some(
      (rung) =>
        (rung === "profile" || rung === "tier") &&
        !overrideRungAfterNotify(policy, reason, rung) &&
        eligibleRungs.has(rung),
    );
  return (
    <section
      className="min-w-0"
      data-testid={`fallback-override-row-${reason}`}
    >
      <h4>
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="disclosure-row"
          className="w-full"
          id={`${id}-trigger`}
          aria-expanded={open}
          aria-controls={`${id}-content`}
          onClick={() => onOpenChange(!open)}
        >
          <span className="min-w-0 flex-1 space-y-1 text-left">
            <span className="flex flex-wrap items-center gap-2">
              <span>{label}</span>
              <Badge variant={custom ? "info" : "muted"}>
                {custom ? "Custom" : "Main plan"}
              </Badge>
              {needsAttention ? (
                <Badge variant="warning">Check save</Badge>
              ) : null}
            </span>
            <span className="block text-ui-xs font-normal text-muted-foreground">
              {ladder === "off"
                ? "Recovery disabled for this problem · "
                : null}
              {!policy.enabled ? "When routing is on: " : null}
              {description.steps.join(" → ")}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "mt-1 size-4 shrink-0 text-muted-foreground",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </Button>
      </h4>
      <div
        ref={panel}
        id={`${id}-content`}
        hidden={!open}
        role="region"
        aria-labelledby={`${id}-trigger`}
        className="space-y-3 border-t border-border px-4 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-ui-sm font-medium">Choose recovery actions</p>
          {custom ? (
            <Button
              type="button"
              variant="link"
              size="touch"
              onClick={() => {
                onReset(reason);
                trigger.current?.focus();
              }}
            >
              Use main plan
            </Button>
          ) : null}
        </div>
        <p className="text-ui-xs text-muted-foreground">
          {custom
            ? "These choices replace the main plan for this problem."
            : "Changing a choice customizes this problem. Everything else keeps using the main plan."}
        </p>
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 @2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-2">
            <fieldset className="min-w-0 divide-y divide-border overflow-hidden rounded-md border border-border">
              <legend className="sr-only">Recovery actions for {label}</legend>
              {overrideActionOrder(policy, reason, rungOrder).map((rung) => (
                <OverrideAction
                  key={rung}
                  policy={policy}
                  reason={reason}
                  rung={rung}
                  onToggle={() =>
                    onChange(
                      togglePolicyOverrideRung({
                        policy,
                        reason,
                        rung,
                        rungOrder,
                      }),
                      reason,
                    )
                  }
                />
              ))}
            </fieldset>
            {hasSwitch ? (
              <p className="text-ui-xs text-muted-foreground">
                {FRESH_SESSION_HELPER}
              </p>
            ) : null}
          </div>
          <aside
            className="min-w-0 space-y-2 rounded-md border border-border bg-foreground/3 p-3"
            aria-label={`Outcome preview for ${label}`}
          >
            <h5 className="text-ui-xs font-medium">What happens</h5>
            <p className="text-ui-xs text-muted-foreground">{previewLead}</p>
            <ol className="list-inside list-decimal space-y-2 text-ui-xs">
              {description.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {description.note === null ? null : (
              <p className="border-t border-border pt-2 text-ui-xs text-muted-foreground">
                {description.note}
              </p>
            )}
          </aside>
        </div>
        <UnavailableActions reason={reason} />
      </div>
    </section>
  );
}

function OverrideAction(props: {
  readonly policy: FallbackPolicy;
  readonly reason: HostNotificationStoppedReason;
  readonly rung: FallbackRungKind;
  readonly onToggle: () => void;
}): ReactNode {
  const { policy, reason, rung, onToggle } = props;
  const id = useId();
  const ladder = effectiveLadderFor(policy, reason);
  const checked = ladder !== "off" && ladder.includes(rung);
  const afterNotify = overrideRungAfterNotify(policy, reason, rung);
  const offInPlan = !policy.ladder.includes(rung);
  const descriptionIds = [
    `${id}-description`,
    ...(offInPlan ? [`${id}-source`] : []),
    ...(afterNotify ? [`${id}-after-notify`] : []),
  ].join(" ");
  return (
    <div className="px-2 py-1">
      <Label variant="row" className="min-h-11 items-start" htmlFor={id}>
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={onToggle}
          className="mt-0.5"
          aria-label={`${OVERRIDE_ACTION_LABELS[rung]} for ${FALLBACK_REASON_LABELS[reason]}`}
          aria-describedby={descriptionIds}
        />
        <span className="min-w-0 flex-1 space-y-1 leading-normal">
          <span className="flex flex-wrap items-center gap-2">
            <span>{OVERRIDE_ACTION_LABELS[rung]}</span>
            {offInPlan ? (
              <Badge id={`${id}-source`} variant="muted">
                {checked ? "On here · off in plan" : "Off in main plan"}
              </Badge>
            ) : null}
          </span>
          <span
            className="block text-ui-xs text-muted-foreground"
            id={`${id}-description`}
          >
            {OVERRIDE_ACTION_HELP[rung]}
          </span>
          {afterNotify ? (
            <span
              id={`${id}-after-notify`}
              className="block text-ui-xs text-warning-foreground"
            >
              After notification · won’t run
            </span>
          ) : null}
        </span>
      </Label>
    </div>
  );
}

function UnavailableActions({
  reason,
}: {
  readonly reason: HostNotificationStoppedReason;
}): ReactNode {
  const unavailable = (["profile", "tier", "wait"] as const).filter(
    (rung) => !REASON_ELIGIBLE_RUNGS[reason].includes(rung),
  );
  if (unavailable.length === 0) return null;
  return (
    <details className="text-ui-xs text-muted-foreground">
      <summary className="min-h-11 cursor-pointer content-center">
        Why aren’t other actions available?
      </summary>
      <ul className="list-inside list-disc space-y-1">
        {unavailable.map((rung) => (
          <li key={rung}>
            {OVERRIDE_ACTION_LABELS[rung]}:{" "}
            {RUNG_INELIGIBILITY_COPY[reason][rung]}.
          </li>
        ))}
      </ul>
    </details>
  );
}

function FixedReason(props: {
  readonly policy: FallbackPolicy;
  readonly reason: HostNotificationStoppedReason;
  readonly onReset: (reason: HostNotificationStoppedReason | null) => void;
  readonly needsAttention: boolean;
  readonly previewUnconfirmed: boolean;
}): ReactNode {
  const { policy, reason, onReset, needsAttention, previewUnconfirmed } = props;
  const label = useRef<HTMLSpanElement>(null);
  const custom = policy.reasonOverrides?.[reason] !== undefined;
  const ladder = effectiveLadderFor(policy, reason);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs">
        <span ref={label} tabIndex={-1} className="font-medium">
          {FALLBACK_REASON_LABELS[reason]}
        </span>
        {custom ? (
          <>
            <Badge variant="info">Custom</Badge>
            <Button
              type="button"
              size="touch"
              variant="link"
              onClick={() => {
                onReset(reason);
                label.current?.focus();
              }}
            >
              Use main plan
            </Button>
          </>
        ) : null}
        {needsAttention ? <Badge variant="warning">Check save</Badge> : null}
      </div>
      {REASON_ELIGIBLE_RUNGS[reason].length === 0 &&
      MATRIX_REASONS.includes(reason) ? (
        <p className="text-ui-xs text-muted-foreground">
          {previewUnconfirmed ? "Save not confirmed · " : null}
          {ladder === "off" ? "Recovery disabled for this problem · " : null}
          {!policy.enabled ? "When routing is on: " : null}
          {describeOverride(policy, reason).steps.join(" → ")}
        </p>
      ) : null}
    </div>
  );
}
