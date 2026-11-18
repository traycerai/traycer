import {
  EXCLUDED_FALLBACK_REASONS,
  REASON_ELIGIBLE_RUNGS,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import type { HostNotificationStoppedReason } from "@traycer/protocol/host/notifications/payloads";
import { effectiveLadderFor } from "./fallback-overrides-model";
import { fallbackDisplayOrderFor } from "./fallback-policy-draft";

export const OVERRIDE_STEP_LABELS: Readonly<Record<FallbackRungKind, string>> =
  {
    profile: "Another account",
    tier: "Equivalent model",
    wait: "Wait for reset",
    notify: "Notify if needed",
  };

export const OVERRIDE_ACTION_LABELS: Readonly<
  Record<FallbackRungKind, string>
> = {
  profile: "Try another account",
  tier: "Try an equivalent model",
  wait: "Wait for the limit to reset",
  notify: "Notify me",
};

export const OVERRIDE_ACTION_HELP: Readonly<Record<FallbackRungKind, string>> =
  {
    profile: "Use another signed-in account on the same provider.",
    tier: "Use a backup model from your Equivalent models list.",
    wait: "Only when the provider gives a reset time within your longest wait.",
    notify: "Traycer notifies you and stops trying.",
  };

export interface OverrideDescription {
  readonly steps: readonly string[];
  readonly note: string | null;
}

/** Describe configured behavior, without promising that a destination exists. */
export function describeOverride(
  policy: FallbackPolicy,
  reason: HostNotificationStoppedReason,
): OverrideDescription {
  if (EXCLUDED_FALLBACK_REASONS.has(reason)) {
    return {
      steps: ["Notify you"],
      note: "Switching or waiting cannot resolve this problem.",
    };
  }
  const ladder = effectiveLadderFor(policy, reason);
  if (ladder === "off") {
    return {
      steps: ["Notify you"],
      note: "Recovery is disabled for this problem. No automatic switching, waiting, or brief retry.",
    };
  }
  const eligible = ladder.filter(
    (rung) => rung === "notify" || REASON_ELIGIBLE_RUNGS[reason].includes(rung),
  );
  const terminal = eligible.indexOf("notify");
  const reachable = terminal === -1 ? eligible : eligible.slice(0, terminal);
  const transient =
    reason === "provider_unavailable" ||
    reason === "provider_connection_failed";
  // The engine checks the narrowed sequence for emptiness. In particular,
  // a connection failure without notify has no eligible step and no retry.
  const retries = transient && eligible.length > 0;
  const steps = reachable.map((rung) => OVERRIDE_STEP_LABELS[rung]);
  if (retries) steps.unshift("Brief retry");
  if (reason === "billing") steps.push("Always notify you");
  else steps.push(steps.length === 0 ? "Notify you" : "Notify if needed");

  let note: string | null = null;
  if (eligible.every((rung) => rung === "notify")) {
    note = retries
      ? "Brief retry, then notify you if it still fails. No switching, waiting, or countdown to cancel."
      : "Notify you without switching or waiting. No countdown to cancel.";
  } else if (reachable.length === 0) {
    note = "Notify ends recovery. Actions after it won’t run.";
  } else if (reason === "auth") {
    note = "Recovery starts only after sign-out is confirmed.";
  } else if (reason === "billing") {
    note = "Billing issues always notify you, even when recovery succeeds.";
  }
  return { steps, note };
}

export function overrideRungAfterNotify(
  policy: FallbackPolicy,
  reason: HostNotificationStoppedReason,
  rung: FallbackRungKind,
): boolean {
  const ladder = effectiveLadderFor(policy, reason);
  if (ladder === "off") return false;
  const terminal = ladder.indexOf("notify");
  return terminal !== -1 && ladder.indexOf(rung) > terminal;
}

/** Keep disabled controls in place; still honor a differing stored sequence. */
export function overrideActionOrder(
  policy: FallbackPolicy,
  reason: HostNotificationStoppedReason,
  rungOrder: readonly FallbackRungKind[],
): readonly FallbackRungKind[] {
  const ladder = effectiveLadderFor(policy, reason);
  const order =
    ladder === "off" ? rungOrder : fallbackDisplayOrderFor(rungOrder, ladder);
  return order.filter((rung) => REASON_ELIGIBLE_RUNGS[reason].includes(rung));
}
