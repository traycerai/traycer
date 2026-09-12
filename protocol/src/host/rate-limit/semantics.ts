import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
  RateLimitUnavailableReason,
} from "./schemas";

/**
 * Reasons a rate-limit read can fail that describe THIS attempt rather than the
 * account: `usage_fetch_failed` is the CLI's usage HTTP fetch failing (e.g. a
 * server-side 429 on Anthropic's `/api/oauth/usage` with a multi-minute penalty
 * window), `timeout`/`connection_failed` its probe-level analogues. Every other
 * reason (`rate_limits_not_available`, `cli_not_found`, `sdk_incompatible`, ...)
 * is authoritative - it says something about the account or the setup, not "try
 * again shortly".
 *
 * The distinction is load-bearing on BOTH sides of the wire and must not drift,
 * which is why it lives here rather than in either peer: the host's gauge cache
 * keeps its last known reading across a transient failure (and lets an
 * authoritative one replace it), and the GUI's renderer envelope retains
 * `lastGood` under exactly the same rule so the two never disagree about
 * whether a reading is still worth showing.
 */
const TRANSIENT_RATE_LIMIT_UNAVAILABLE_REASONS: ReadonlySet<RateLimitUnavailableReason> =
  new Set(["usage_fetch_failed", "timeout", "connection_failed"]);

export function isTransientRateLimitUnavailableReason(
  reason: RateLimitUnavailableReason,
): boolean {
  return TRANSIENT_RATE_LIMIT_UNAVAILABLE_REASONS.has(reason);
}

/**
 * Snapshot-level form of `isTransientRateLimitUnavailableReason`: whether this
 * whole reading is a failed attempt that a previously captured reading should
 * survive. An `available: true` snapshot is never transient - it IS the reading.
 */
export function isTransientProviderRateLimitFailure(
  rateLimits: ProviderRateLimits,
): boolean {
  return (
    !rateLimits.available &&
    isTransientRateLimitUnavailableReason(rateLimits.reason)
  );
}

export type ProviderRateLimitSeverity =
  | "healthy"
  | "running_low"
  | "limited"
  | "unknown";

export type LiveProviderRateLimitSeverity = Exclude<
  ProviderRateLimitSeverity,
  "unknown"
>;

export type OpenCodeGoRateLimitWindow = Extract<
  ProviderRateLimits,
  { provider: "opencode"; available: true }
>["fiveHour"];

const SHORT_WINDOW_RUNNING_LOW_USED_PERCENT = 80;
const LONG_WINDOW_RUNNING_LOW_USED_PERCENT = 95;
const LIMITED_USED_PERCENT = 100;
const SHORT_WINDOW_MAX_DURATION_MINUTES = 24 * 60;

function runningLowUsedPercentThreshold(
  window: ProviderRateLimitWindow,
): number {
  return window.durationMinutes !== null &&
    window.durationMinutes <= SHORT_WINDOW_MAX_DURATION_MINUTES
    ? SHORT_WINDOW_RUNNING_LOW_USED_PERCENT
    : LONG_WINDOW_RUNNING_LOW_USED_PERCENT;
}

/**
 * Classifies one current provider window by consumed percentage. Short
 * (at-most-24-hour) windows warn at 80%; long or undated windows warn at 95%;
 * every window becomes limited at 100%.
 */
export function classifyProviderRateLimitWindow(
  window: ProviderRateLimitWindow,
): LiveProviderRateLimitSeverity {
  if (window.usedPercent >= LIMITED_USED_PERCENT) return "limited";
  if (window.usedPercent >= runningLowUsedPercentThreshold(window)) {
    return "running_low";
  }
  return "healthy";
}

/** Every percentage window carried by a detailed provider snapshot. */
export function providerRateLimitWindows(
  rateLimits: ProviderRateLimits,
): readonly ProviderRateLimitWindow[] {
  if (!rateLimits.available) return [];
  switch (rateLimits.provider) {
    case "claude-code":
      return [
        rateLimits.fiveHour,
        rateLimits.sevenDay,
        rateLimits.sevenDayOpus,
        rateLimits.sevenDaySonnet,
        ...rateLimits.modelScoped,
      ].filter((window): window is ProviderRateLimitWindow => window !== null);
    case "codex":
      return [
        rateLimits.primary,
        rateLimits.secondary,
        ...rateLimits.extraWindows.flatMap((window) => [
          window.primary,
          window.secondary,
        ]),
      ].filter((window): window is ProviderRateLimitWindow => window !== null);
    case "grok":
      // Hybrid arm: the synthesized billing-period window feeds the shared
      // severity/rollup path. A period-less snapshot (tier + dates only, no
      // usage percentage) carries no window.
      return rateLimits.period !== null ? [rateLimits.period] : [];
    case "cursor":
      // Hybrid arm, like grok's: the synthesized per-bucket windows ("Cursor
      // Models" / "Other Models", mirroring Cursor's Spending page) feed the
      // shared severity/rollup path. A snapshot whose usage could not be
      // measured (no bucket percentages reported) carries no windows.
      return [rateLimits.cursorModels, rateLimits.otherModels].filter(
        (window): window is ProviderRateLimitWindow => window !== null,
      );
    case "opencode":
      return [rateLimits.fiveHour, rateLimits.weekly, rateLimits.monthly];
    case "openrouter":
    case "kilocode":
    case "huggingface":
      // Credit providers: the payload is money, not a percentage of a rolling
      // window, so there is nothing the shared window primitive can describe.
      return [];
  }
}

/** A null reset is live because there is no evidence that the window rolled. */
export function isProviderRateLimitWindowLive(
  window: ProviderRateLimitWindow,
  now: number,
): boolean {
  return window.resetsAt === null || window.resetsAt > now;
}

/** OpenCode's status is authoritative only while that captured window is live. */
export function isOpenCodeGoRateLimitWindowLimited(
  window: OpenCodeGoRateLimitWindow,
  now: number,
): boolean {
  return (
    window.status === "rate-limited" &&
    isProviderRateLimitWindowLive(window, now)
  );
}

/** Detailed percentage windows that still describe the current limit period. */
export function liveProviderRateLimitWindows(
  rateLimits: ProviderRateLimits,
  now: number,
): readonly ProviderRateLimitWindow[] {
  return providerRateLimitWindows(rateLimits).filter((window) =>
    isProviderRateLimitWindowLive(window, now),
  );
}

/**
 * Classifies a whole provider snapshot. A Codex reached-type is authoritative,
 * except when every window from that same capture has expired. Missing,
 * unavailable, and fully expired detail is Unknown rather than Healthy.
 */
export function classifyProviderRateLimits(
  rateLimits: ProviderRateLimits,
  now: number,
): ProviderRateLimitSeverity {
  if (!rateLimits.available) return "unknown";
  const windows = providerRateLimitWindows(rateLimits);
  const liveWindows = windows.filter((window) =>
    isProviderRateLimitWindowLive(window, now),
  );
  if (windows.length > 0 && liveWindows.length === 0) return "unknown";
  if (
    rateLimits.provider === "codex" &&
    rateLimits.rateLimitReachedType !== null
  ) {
    return "limited";
  }
  if (
    rateLimits.provider === "opencode" &&
    [rateLimits.fiveHour, rateLimits.weekly, rateLimits.monthly].some(
      (window) => isOpenCodeGoRateLimitWindowLimited(window, now),
    )
  ) {
    return "limited";
  }
  if (liveWindows.length === 0) return "unknown";

  const severities = liveWindows.map(classifyProviderRateLimitWindow);
  if (severities.includes("limited")) return "limited";
  if (severities.includes("running_low")) return "running_low";
  return "healthy";
}

/**
 * Tokenizes a family name or a model slug/label for family matching.
 *
 * Both sides tokenize on non-alphanumerics because the two vocabularies are
 * formatted differently for the same fact: a provider names a window's family
 * with a DISPLAY name ("Claude Opus") and names the models it gates with a
 * SLUG ("claude-opus-4-7"). Comparing them as raw strings - `slug.includes(
 * family)` - fails on the space alone, which is how a real blocker came to be
 * dropped and a false readiness emitted.
 */
export function rateLimitMatchTokens(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

// Tokens that appear in family names AND in every model slug of the provider
// ("Claude Opus" / `claude-fable-5`), so matching through them would gate every
// model. Stripped from the FAMILY side; a family left with nothing errs toward
// matching.
const PROVIDER_GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "claude",
  "anthropic",
]);

// Slugs that name no particular model - a harness's "whatever is configured"
// alias. They are alphabetic and would otherwise read as informative, so a
// window for `opus` would be judged NOT to gate them, which is backwards: an
// alias proves nothing about which model runs.
const UNRESOLVED_MODEL_TOKENS: ReadonlySet<string> = new Set([
  "default",
  "auto",
  "inherit",
]);

/**
 * Whether a limited window's `family` gates the model described by
 * `modelTokens` (the union of its slug's and label's tokens).
 *
 * `null` is a shared window and gates everything. Otherwise the window applies
 * when any INFORMATIVE family token appears among the model's tokens: "Fable"
 * -> `claude-fable-5`, "opus" -> `opus[1m]`, "Claude Opus" -> `claude-opus-4-7`
 * but NOT `claude-fable-5`. Purely numeric family tokens are version noise and
 * provider-generic tokens match everything, so both are ignored.
 *
 * Every uncertain path INCLUDES the window - a family with no informative token
 * left, and a model that is only an unresolved alias. The asymmetry is
 * deliberate and means opposite things to the two callers, both of them the
 * safe direction: the GUI errs toward SHOWING a limit warning rather than
 * hiding a real one, and the host errs toward counting a blocker, which can
 * only make readiness stricter. Dropping a window on doubt would instead offer
 * the nearest reset of the windows that happened to match - the forty-minute
 * answer under an exhausted weekly window that the readiness rule exists to
 * refuse.
 *
 * Shared rather than copied because the two peers must agree: the host decides
 * from this whether to WAIT for a window, and the GUI renders from it what the
 * user is told about the same window. A divergence shows up as a chat that
 * waits on a limit the UI says does not apply.
 */
/**
 * The SLUG-side wrapper, which is the shape both peers can always form: a model
 * is named by a bare slug on the host, and by a slug plus a display label in the
 * GUI.
 *
 * This exists so the host does not keep a private copy of the two-line wrapper.
 * It used to, and the GUI's agreement suite could only reproduce that copy
 * rather than call it - so a change to the host's own token derivation would
 * have left both suites green while the peers silently stopped meaning the same
 * thing. One exported implementation makes that drift impossible instead of
 * merely detectable.
 *
 * A `null` slug is unknown and therefore INCLUDES the window, the same
 * err-toward-the-blocker direction as every other uncertain path here.
 */
export function rateLimitFamilyAffectsModelSlug(
  family: string | null,
  modelSlug: string | null,
): boolean {
  if (modelSlug === null) return true;
  return rateLimitFamilyAffectsModel(
    family,
    new Set(rateLimitMatchTokens(modelSlug)),
  );
}

export function rateLimitFamilyAffectsModel(
  family: string | null,
  modelTokens: ReadonlySet<string>,
): boolean {
  if (family === null) return true;
  const familyTokens = rateLimitMatchTokens(family).filter(
    (token) => /[a-z]/.test(token) && !PROVIDER_GENERIC_TOKENS.has(token),
  );
  if (familyTokens.length === 0) return true;
  const informativeModelTokens = [...modelTokens].filter(
    (token) =>
      /[a-z]/.test(token) &&
      !PROVIDER_GENERIC_TOKENS.has(token) &&
      !UNRESOLVED_MODEL_TOKENS.has(token),
  );
  if (informativeModelTokens.length === 0) return true;
  return familyTokens.some((token) => modelTokens.has(token));
}
