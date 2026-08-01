import {
  classifyProviderRateLimits,
  classifyProviderRateLimitWindow,
  isProviderRateLimitWindowLive,
  jcodeSubProviderRateLimitLabel,
  providerRateLimitWindows,
  type LiveProviderRateLimitSeverity,
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
    case "kilocode":
      return [];
    case "jcode":
      // Meta-harness: one window per connected sub-provider that reported a
      // measurable quota, named by `subProviderId` (same multi-window shape as
      // claude-code model-scoped). `usage_percent` is already percent CONSUMED
      // — no inversion. `resetsAt: null` means "not reported", not "never
      // resets"; `isProviderRateLimitWindowLive` treats null reset as live.
      //
      // Roles: peer sub-providers are not "extras" on a primary meter — each
      // is an independent quota the user tracks. Using primary (first live)
      // + secondary (rest) keeps healthy peers visible through the
      // projectProfileUsage filter that drops healthy `extra` rows; labeling
      // them all `extra` would hide a 10% OpenRouter row next to an 85%
      // Copilot bar, which is the wrong meta-harness UX.
      //
      // Error trap: a sub-provider with non-null `error` must never render as
      // a 0% bar. Schema separates `error` from `window: null` so a broken
      // credential is distinct from "no quota". We **omit** failed rows rather
      // than invent an error-window UI primitive — `ProfileUsageWindow` has no
      // error field, and a missing row is honest (severity still rolls up via
      // protocol `classifyProviderRateLimits` / `hardLimitReached` on remaining
      // live windows). Never synthesize a zero window for an error.
      return rateLimits.subProviders
        .flatMap((subProvider, index) => {
          if (subProvider.error !== null) return [];
          return [
            windowProjection({
              id: `sub:${subProvider.subProviderId}:${index}`,
              // Provisional role; reassigned on the live list below so the
              // first *surviving* window is primary even when earlier rows
              // were null/expired/errored.
              role: "extra",
              name: jcodeSubProviderRateLimitLabel(subProvider),
              window: subProvider.window,
              now,
            }),
          ];
        })
        .filter((entry): entry is ProfileUsageWindow => entry !== null)
        .map((entry, liveIndex) => ({
          ...entry,
          role: liveIndex === 0 ? "primary" : "secondary",
        }));
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
  if (rateLimits.provider === "grok" && rateLimits.period === null) {
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

  const severity =
    retained.provider === "openrouter"
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
