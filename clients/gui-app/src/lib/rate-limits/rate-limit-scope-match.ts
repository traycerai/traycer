import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";

export type ProfileRateLimitSeverity = "near_limit" | "hard_limit";

function matchTokens(value: string): ReadonlyArray<string> {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

// Provider-generic tokens carry no model-family information: they appear both
// in family names ("Claude Opus") and in every model slug of the provider
// (`claude-fable-5[1m]`), so matching through them would gate every model.
// Stripped from the FAMILY side only - a family that is nothing but generic
// tokens falls through to the err-toward-matching path below.
const PROVIDER_GENERIC_TOKENS = new Set(["claude", "anthropic"]);

/**
 * Whether a limited scope's `family` gates `model`. `null` is a shared window
 * that gates every model. Otherwise both sides tokenize on non-alphanumerics
 * and the scope matches when ANY informative family token appears among the
 * model's slug/label tokens ("Fable" -> `claude-fable-5[1m]`, "opus" ->
 * `opus[1m]`, "Claude Opus" -> `claude-opus-4-7` but NOT
 * `claude-fable-5[1m]`). Purely numeric family tokens are version noise and
 * provider-generic tokens ("claude") match every model of the provider, so
 * both are ignored; a family with no informative token left cannot be judged
 * and errs toward matching - every uncertain path here fails toward SHOWING
 * the warning, never hiding a real one.
 */
export function rateLimitScopeAffectsModel(
  family: string | null,
  model: ModelOption,
): boolean {
  if (family === null) return true;
  const familyTokens = matchTokens(family).filter(
    (token) => /[a-z]/.test(token) && !PROVIDER_GENERIC_TOKENS.has(token),
  );
  if (familyTokens.length === 0) return true;
  const modelTokens = new Set([
    ...matchTokens(model.slug),
    ...matchTokens(model.label),
  ]);
  return familyTokens.some((token) => modelTokens.has(token));
}

/**
 * The subset of a profile's limited scopes that gate `model`, or `null` when
 * per-scope data is unavailable (an old host build, or a profile whose gauge
 * was never read / went stale) or no model is resolved - callers fall back to
 * the profile-level `rateLimitStatus` in that case.
 */
export function matchingRateLimitScopes(
  profile: ProviderProfile,
  model: ModelOption | null,
): ProviderProfile["rateLimitLimitedScopes"] {
  const scopes = profile.rateLimitLimitedScopes;
  if (scopes === null || model === null) return null;
  return scopes.filter((scope) =>
    rateLimitScopeAffectsModel(scope.family, model),
  );
}

/**
 * The profile's near/hard-limit severity as it applies to the selected model:
 * the worst severity among the scopes gating `model`, the profile-level
 * `rateLimitStatus` when per-scope data is unavailable, and `null` (not
 * limited for this model) when scopes exist but none gate it.
 */
export function effectiveProfileRateLimitSeverity(
  profile: ProviderProfile,
  model: ModelOption | null,
): ProfileRateLimitSeverity | null {
  const matching = matchingRateLimitScopes(profile, model);
  if (matching === null) {
    if (profile.rateLimitStatus === "near_limit") return "near_limit";
    if (profile.rateLimitStatus === "hard_limit") return "hard_limit";
    return null;
  }
  if (matching.length === 0) return null;
  return matching.some((scope) => scope.severity === "hard_limit")
    ? "hard_limit"
    : "near_limit";
}

/**
 * Orders severities for "is this destination in a strictly better tier than
 * the limited current profile" comparisons: not-limited (0) < near_limit (1)
 * < hard_limit (2).
 */
export function rateLimitSeverityTier(
  severity: ProfileRateLimitSeverity | null,
): number {
  if (severity === null) return 0;
  return severity === "near_limit" ? 1 : 2;
}

/**
 * Two-dimensional rate-limit evidence for destination ranking: whether the
 * profile's state is KNOWN at all, and - only when known - its severity for
 * the selected model. Unknown is incomparable, not a tier: a profile whose
 * gauge was never read, went stale, or last probed with a failure must never
 * satisfy a "strictly better" comparison, no matter how limited the current
 * profile is. (`effectiveProfileRateLimitSeverity` stays the WARNING-side
 * read, where unknown and healthy both mean "don't warn".)
 */
export type ProfileRateLimitAssessment =
  | { readonly known: false }
  | {
      readonly known: true;
      readonly severity: ProfileRateLimitSeverity | null;
    };

const UNKNOWN_ASSESSMENT: ProfileRateLimitAssessment = { known: false };

export function assessProfileRateLimit(
  profile: ProviderProfile,
  model: ModelOption | null,
): ProfileRateLimitAssessment {
  const matching = matchingRateLimitScopes(profile, model);
  if (matching !== null) {
    if (matching.length === 0) return { known: true, severity: null };
    return {
      known: true,
      severity: matching.some((scope) => scope.severity === "hard_limit")
        ? "hard_limit"
        : "near_limit",
    };
  }
  // No per-scope data (old host / never-read / stale / failed-probe gauge)
  // or no resolved model: the profile-level enum is the remaining evidence.
  // "ok" is a real derivation from a successful read - known healthy;
  // "unknown" is the absence (or failure) of evidence.
  if (profile.rateLimitStatus === "near_limit") {
    return { known: true, severity: "near_limit" };
  }
  if (profile.rateLimitStatus === "hard_limit") {
    return { known: true, severity: "hard_limit" };
  }
  if (profile.rateLimitStatus === "ok") return { known: true, severity: null };
  return UNKNOWN_ASSESSMENT;
}
