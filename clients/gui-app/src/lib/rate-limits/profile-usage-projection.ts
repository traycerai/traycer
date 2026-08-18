import {
  classifyProviderRateLimits,
  classifyProviderRateLimitWindow,
  isProviderRateLimitWindowLive,
  isOpenCodeGoRateLimitWindowLimited,
  providerRateLimitWindows,
  type LiveProviderRateLimitSeverity,
  type OpenCodeGoRateLimitWindow,
  type ProviderRateLimits,
  type ProviderRateLimitSeverity,
  type ProviderRateLimitWindow,
  type RateLimitUnavailableReason,
} from "@traycer/protocol/host/rate-limit";
import type { ProviderProfileRateLimitStatus } from "@traycer/protocol/host/provider-schemas";
import {
  envelopeDegradedReason,
  resolveRetainedProviderRateLimits,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import { creditUsageSeverity } from "@/lib/rate-limits/window-severity";

export type ProfileUsageWindowRole = "primary" | "secondary" | "extra";
export type ProfileUsageFailureReason =
  RateLimitUnavailableReason | "fetch_failed";
type AvailableProviderRateLimits = Extract<
  ProviderRateLimits,
  { available: true }
>;

const PROFILE_USAGE_SEVERITY_RANK = {
  healthy: 0,
  running_low: 1,
  limited: 2,
} as const;

export interface ProfileUsageWindow {
  readonly id: string;
  readonly role: ProfileUsageWindowRole;
  readonly name: string | null;
  readonly window: ProviderRateLimitWindow;
  readonly severity: LiveProviderRateLimitSeverity;
}

interface ProfileUsageProjectionBase {
  readonly compactWindow: ProfileUsageWindow | null;
  readonly windows: ReadonlyArray<ProfileUsageWindow>;
  readonly checkedAt: number | null;
}

export type ProfileUsageProjection =
  | (ProfileUsageProjectionBase & {
      readonly kind: "detail" | "stale";
      readonly severity: LiveProviderRateLimitSeverity;
      readonly compactWindow: ProfileUsageWindow;
      readonly unavailableReason: ProfileUsageFailureReason | null;
    })
  | (ProfileUsageProjectionBase & {
      readonly kind: "semantic_only";
      readonly severity: LiveProviderRateLimitSeverity;
      readonly unavailableReason: ProfileUsageFailureReason | null;
    })
  | (ProfileUsageProjectionBase & {
      readonly kind: "not_checked";
      readonly severity: "unknown";
      readonly checkedAt: null;
    })
  | (ProfileUsageProjectionBase & {
      readonly kind: "unavailable";
      readonly severity: "unknown";
      readonly reason:
        ProfileUsageFailureReason | "expired" | "missing_windows" | "unknown";
    });

export interface ProfileUsageProjectionInput {
  readonly rateLimitStatus: ProviderProfileRateLimitStatus;
  readonly usageUpdatedAt: number | null;
  readonly envelope: ProviderRateLimitEnvelope | null;
  readonly detailError: boolean;
  readonly now: number;
  readonly staleAfterMs: number;
}

function statusSeverity(
  status: ProviderProfileRateLimitStatus,
): ProviderRateLimitSeverity {
  switch (status) {
    case "ok":
      return "healthy";
    case "near_limit":
      return "running_low";
    case "hard_limit":
      return "limited";
    case "unknown":
      return "unknown";
  }
}

function semanticProjection(
  input: ProfileUsageProjectionInput,
): ProfileUsageProjection {
  const severity = statusSeverity(input.rateLimitStatus);
  if (input.detailError && (severity === "healthy" || severity === "unknown")) {
    return {
      kind: "unavailable",
      severity: "unknown",
      reason: "fetch_failed",
      compactWindow: null,
      windows: [],
      checkedAt: input.usageUpdatedAt,
    };
  }
  if (
    input.usageUpdatedAt === null &&
    (severity === "healthy" || severity === "unknown")
  ) {
    return {
      kind: "not_checked",
      severity: "unknown",
      compactWindow: null,
      windows: [],
      checkedAt: null,
    };
  }
  if (severity !== "unknown") {
    return {
      kind: "semantic_only",
      severity,
      compactWindow: null,
      windows: [],
      checkedAt: input.usageUpdatedAt,
      unavailableReason: input.detailError ? "fetch_failed" : null,
    };
  }
  return {
    kind: "unavailable",
    severity: "unknown",
    reason: "unknown",
    compactWindow: null,
    windows: [],
    checkedAt: input.usageUpdatedAt,
  };
}

interface WindowProjectionInput {
  readonly id: string;
  readonly role: ProfileUsageWindowRole;
  readonly name: string | null;
  readonly window: ProviderRateLimitWindow | null;
  readonly now: number;
}

function windowProjection(
  input: WindowProjectionInput,
): ProfileUsageWindow | null {
  if (
    input.window === null ||
    !isProviderRateLimitWindowLive(input.window, input.now)
  ) {
    return null;
  }
  return {
    id: input.id,
    role: input.role,
    name: input.name,
    window: input.window,
    severity: classifyProviderRateLimitWindow(input.window),
  };
}

function openCodeWindowProjection(input: {
  readonly id: string;
  readonly role: ProfileUsageWindowRole;
  readonly name: string;
  readonly window: OpenCodeGoRateLimitWindow;
  readonly now: number;
}): ProfileUsageWindow | null {
  const projected = windowProjection(input);
  return projected === null ||
    !isOpenCodeGoRateLimitWindowLimited(input.window, input.now)
    ? projected
    : { ...projected, severity: "limited" };
}

function openRouterCreditProjection(
  rateLimits: Extract<
    ProviderRateLimits,
    { provider: "openrouter"; available: true }
  >,
): ProfileUsageWindow | null {
  if (
    rateLimits.limit === null ||
    rateLimits.limitRemaining === null ||
    rateLimits.limit <= 0
  ) {
    return null;
  }
  const consumed = Math.max(0, rateLimits.limit - rateLimits.limitRemaining);
  const usedPercent = (consumed / rateLimits.limit) * 100;
  const window = {
    usedPercent,
    durationMinutes: null,
    resetsAt: null,
  };
  return {
    id: "credits",
    role: "primary",
    name: "Credits",
    window,
    severity: creditUsageSeverity(usedPercent),
  };
}

// Hugging Face's only computable percentage is against the included
// allowance - the same pair the settings credit bar renders - so an account
// without one projects no window at all rather than a fabricated zero. `used`
// can exceed the allowance once an account spends past it, so the consumed
// figure is clamped to keep the projected percentage inside 0-100.
function huggingFaceCreditProjection(
  rateLimits: Extract<
    ProviderRateLimits,
    { provider: "huggingface"; available: true }
  >,
): ProfileUsageWindow | null {
  if (rateLimits.includedUsd === null || rateLimits.includedUsd <= 0) {
    return null;
  }
  const consumed = Math.min(
    Math.max(0, rateLimits.usedUsd),
    rateLimits.includedUsd,
  );
  const usedPercent = (consumed / rateLimits.includedUsd) * 100;
  const window = {
    usedPercent,
    durationMinutes: null,
    resetsAt: null,
  };
  return {
    id: "credits",
    role: "primary",
    name: "Included credits",
    window,
    severity: creditUsageSeverity(usedPercent),
  };
}

function projectedLiveWindows(
  rateLimits: ProviderRateLimits,
  now: number,
): ReadonlyArray<ProfileUsageWindow> {
  if (!rateLimits.available) return [];
  switch (rateLimits.provider) {
    case "codex":
      return [
        windowProjection({
          id: "primary",
          role: "primary",
          name: null,
          window: rateLimits.primary,
          now,
        }),
        windowProjection({
          id: "secondary",
          role: "secondary",
          name: null,
          window: rateLimits.secondary,
          now,
        }),
        ...rateLimits.extraWindows.flatMap((extra) => [
          windowProjection({
            id: `extra:${extra.limitId}:primary`,
            role: "extra",
            name: extra.limitName ?? extra.limitId,
            window: extra.primary,
            now,
          }),
          windowProjection({
            id: `extra:${extra.limitId}:secondary`,
            role: "extra",
            name: extra.limitName ?? extra.limitId,
            window: extra.secondary,
            now,
          }),
        ]),
      ].filter((window): window is ProfileUsageWindow => window !== null);
    case "claude-code":
      return [
        windowProjection({
          id: "five-hour",
          role: "primary",
          name: null,
          window: rateLimits.fiveHour,
          now,
        }),
        windowProjection({
          id: "seven-day",
          role: "secondary",
          name: null,
          window: rateLimits.sevenDay,
          now,
        }),
        windowProjection({
          id: "seven-day-opus",
          role: "extra",
          name: "Opus",
          window: rateLimits.sevenDayOpus,
          now,
        }),
        windowProjection({
          id: "seven-day-sonnet",
          role: "extra",
          name: "Sonnet",
          window: rateLimits.sevenDaySonnet,
          now,
        }),
        ...rateLimits.modelScoped.map((model, index) =>
          windowProjection({
            id: `model:${model.displayName}:${index}`,
            role: "extra",
            name: model.displayName,
            window: model,
            now,
          }),
        ),
      ].filter((window): window is ProfileUsageWindow => window !== null);
    case "openrouter": {
      const credits = openRouterCreditProjection(rateLimits);
      return credits === null ? [] : [credits];
    }
    case "grok":
      // Grok rides the shared window path via its synthesized billing-period
      // window - not the OpenRouter-style credit projection - so its severity
      // and compact bar come straight from `classifyProviderRateLimits` with
      // no special-casing. A period-less snapshot (tier + dates only) carries
      // no window.
      return [
        windowProjection({
          id: "period",
          role: "primary",
          name: null,
          window: rateLimits.period,
          now,
        }),
      ].filter((window): window is ProfileUsageWindow => window !== null);
    case "opencode":
      return [
        openCodeWindowProjection({
          id: "five-hour",
          role: "primary",
          name: "5-hour",
          window: rateLimits.fiveHour,
          now,
        }),
        openCodeWindowProjection({
          id: "weekly",
          role: "secondary",
          name: "Weekly",
          window: rateLimits.weekly,
          now,
        }),
        openCodeWindowProjection({
          id: "monthly",
          role: "extra",
          name: "Monthly",
          window: rateLimits.monthly,
          now,
        }),
      ].filter((window): window is ProfileUsageWindow => window !== null);
    case "huggingface": {
      const credits = huggingFaceCreditProjection(rateLimits);
      return credits === null ? [] : [credits];
    }
    case "cursor":
      // Cursor rides the shared window path via its synthesized billing-cycle
      // bucket windows, exactly like grok - NOT the credit projection its
      // money-shaped fields might suggest - so severity and the compact bar
      // come straight from `classifyProviderRateLimits`. This is also why
      // cursor is absent from the credit-provider severity exception below:
      // that exception exists for providers whose `providerRateLimitWindows`
      // is empty by design, and cursor's is not.
      //
      // The two windows mirror Cursor's Spending page buckets; the compact
      // bar picks the most consumed of the two via `mostConstrainedWindow`,
      // so the headline number always matches one of the dashboard's bars.
      return [
        windowProjection({
          id: "cursor-models",
          role: "primary",
          name: "Cursor Models",
          window: rateLimits.cursorModels,
          now,
        }),
        windowProjection({
          id: "other-models",
          role: "secondary",
          name: "Other Models",
          window: rateLimits.otherModels,
          now,
        }),
      ].filter((window): window is ProfileUsageWindow => window !== null);
    case "kilocode":
      return [];
  }
}

function mostConstrainedWindow(
  windows: ReadonlyArray<ProfileUsageWindow>,
): ProfileUsageWindow | null {
  return windows.reduce<ProfileUsageWindow | null>((selected, candidate) => {
    if (selected === null) return candidate;
    if (
      PROFILE_USAGE_SEVERITY_RANK[candidate.severity] !==
      PROFILE_USAGE_SEVERITY_RANK[selected.severity]
    ) {
      return PROFILE_USAGE_SEVERITY_RANK[candidate.severity] >
        PROFILE_USAGE_SEVERITY_RANK[selected.severity]
        ? candidate
        : selected;
    }
    return candidate.window.usedPercent > selected.window.usedPercent
      ? candidate
      : selected;
  }, null);
}

function emptyDetailProjection(
  rateLimits: AvailableProviderRateLimits,
  envelope: ProviderRateLimitEnvelope,
  input: ProfileUsageProjectionInput,
): ProfileUsageProjection {
  const checkedAt = envelope.lastGoodAt ?? input.usageUpdatedAt;
  // Grok's zero-usage snapshot is `available` with tier + billing-period bounds
  // but no usage percentage, so it synthesizes no `period` window. That is
  // "unmeasured", not "unavailable": the account is reachable and healthy, it
  // just reports nothing to meter this period (the same snapshot the Settings
  // card renders as tier + billing period, no severity). Project it as the
  // percentage-free unmeasured state so its severity stays `unknown` -
  // consistent with protocol `classifyProviderRateLimits` and the (parallel)
  // host-gauge fix - instead of the alarming unavailable/`missing_windows`
  // framing, which reads as a fetch/account failure. A grok snapshot whose
  // period merely rolled (window present but expired) still falls through to
  // `expired` below, the correct stale framing.
  //
  // Cursor is the same case for the same reason: its bucket windows are
  // synthesized only when the payload reports the bucket percentages, and
  // proto3 JSON omits zero-valued fields, so a reachable account can
  // legitimately arrive with both windows null. Without this arm that account
  // renders as unavailable (`missing_windows`) purely because Cursor reported
  // nothing to meter. A cursor snapshot whose cycle merely rolled still falls
  // through to `expired`, exactly as grok's does.
  if (
    (rateLimits.provider === "grok" && rateLimits.period === null) ||
    (rateLimits.provider === "cursor" &&
      rateLimits.cursorModels === null &&
      rateLimits.otherModels === null)
  ) {
    return {
      kind: "not_checked",
      severity: "unknown",
      compactWindow: null,
      windows: [],
      checkedAt: null,
    };
  }
  const severity = classifyProviderRateLimits(rateLimits, input.now);
  if (severity === "limited") {
    return {
      kind: "semantic_only",
      severity,
      compactWindow: null,
      windows: [],
      checkedAt,
      unavailableReason: input.detailError ? "fetch_failed" : null,
    };
  }
  return {
    kind: "unavailable",
    severity: "unknown",
    reason:
      providerRateLimitWindows(rateLimits).length > 0
        ? "expired"
        : "missing_windows",
    compactWindow: null,
    windows: [],
    checkedAt,
  };
}

function detailFailureReason(
  envelope: ProviderRateLimitEnvelope,
  detailError: boolean,
): ProfileUsageFailureReason | null {
  return detailError ? "fetch_failed" : envelopeDegradedReason(envelope);
}

function isStaleDetail(
  failureReason: ProfileUsageFailureReason | null,
  checkedAt: number | null,
  now: number,
  staleAfterMs: number,
): boolean {
  if (failureReason !== null) return true;
  return checkedAt !== null && now - checkedAt >= staleAfterMs;
}

/**
 * Pure picker-facing projection of one profile's cached usage evidence. It
 * never synthesizes a percentage: only `detail`/`stale` states carry a compact
 * window, while semantic-only, not-checked, and unavailable states remain
 * explicitly percentage-free.
 */
export function projectProfileUsage(
  input: ProfileUsageProjectionInput,
): ProfileUsageProjection {
  const envelope = input.envelope;
  if (envelope === null || envelope.latest === null) {
    return semanticProjection(input);
  }

  const retained = resolveRetainedProviderRateLimits(envelope);
  if (retained === null) return semanticProjection(input);
  if (!retained.available) {
    return {
      kind: "unavailable",
      severity: "unknown",
      reason: retained.reason,
      compactWindow: null,
      windows: [],
      checkedAt: input.usageUpdatedAt,
    };
  }

  const liveWindows = projectedLiveWindows(retained, input.now);
  const compactWindow = mostConstrainedWindow(liveWindows);
  if (compactWindow === null) {
    return emptyDetailProjection(retained, envelope, input);
  }

  // The credit providers derive severity from the PROJECTED window, not from
  // `classifyProviderRateLimits`: that helper reads `providerRateLimitWindows`,
  // which is empty for a credit provider by design, so it answers "unknown" and
  // the branch below would discard the credit bar we just projected.
  const severity =
    retained.provider === "openrouter" || retained.provider === "huggingface"
      ? compactWindow.severity
      : classifyProviderRateLimits(retained, input.now);
  if (severity === "unknown") {
    return {
      kind: "unavailable",
      severity,
      reason: "unknown",
      compactWindow: null,
      windows: [],
      checkedAt: envelope.lastGoodAt ?? input.usageUpdatedAt,
    };
  }

  const windows = liveWindows.filter(
    (candidate) =>
      candidate.role !== "extra" ||
      candidate.id === compactWindow.id ||
      candidate.severity !== "healthy",
  );
  const checkedAt = envelope.lastGoodAt ?? input.usageUpdatedAt;
  const failureReason = detailFailureReason(envelope, input.detailError);
  const stale = isStaleDetail(
    failureReason,
    checkedAt,
    input.now,
    input.staleAfterMs,
  );
  return {
    kind: stale ? "stale" : "detail",
    severity,
    compactWindow,
    windows,
    checkedAt,
    unavailableReason: failureReason,
  };
}
