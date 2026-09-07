import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
} from "@traycer/protocol/host";
import { classifyProviderRateLimitWindow } from "@traycer/protocol/host/rate-limit";
import { useHostQueriesWithResponseMap } from "@/hooks/host/use-host-queries";
import {
  providerRateLimitQueryOptions,
  type ProviderRateLimitTanstackOptions,
} from "@/hooks/host/provider-rate-limit-query-options";
import { useVisibleRateLimitProviders } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import {
  resolveRateLimitProfileId,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  isRateLimitProfileFetchEligible,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import {
  envelopeDegradedReason,
  mapResponseToProviderRateLimitEnvelope,
  resolveRetainedProviderRateLimits,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import { type RateLimitWindowSeverity } from "@/lib/rate-limits/window-severity";

/** The two windows a glyph bar can stand for, in fixed draw order: a provider's 5-hour window and its Weekly window. */
export type HeaderRateLimitWindowLabel = "5h" | "Weekly";

export interface HeaderRateLimitBar {
  readonly providerId: RateLimitProviderId;
  readonly windowLabel: HeaderRateLimitWindowLabel;
  readonly usedPercent: number;
  readonly severity: RateLimitWindowSeverity;
  /** Most recent poll for this provider errored, but this is last-known-good data. */
  readonly degraded: boolean;
}

/** OpenRouter and Kilo Code are popover-only and never contribute a header bar. */
const GLYPH_PROVIDER_IDS = ["codex", "claude-code"] as const;

type GlyphProviderId = (typeof GLYPH_PROVIDER_IDS)[number];

interface GlyphProviderTarget {
  readonly providerId: GlyphProviderId;
  readonly profileId: string | null;
  readonly fetchEligible: boolean;
}

/** A glyph provider's live query state, paired with its id (in draw order). */
interface GlyphProviderReading {
  readonly providerId: GlyphProviderId;
  readonly rateLimits: ProviderRateLimits | null;
  readonly degraded: boolean;
}

function fiveHourWindow(
  rateLimits: ProviderRateLimits | null,
): ProviderRateLimitWindow | null {
  if (rateLimits === null || !rateLimits.available) return null;
  switch (rateLimits.provider) {
    case "codex":
      return rateLimits.primary;
    case "claude-code":
      return rateLimits.fiveHour;
    // OpenRouter/Kilo Code/Grok/Hugging Face/OpenCode/Cursor are never queried for a glyph slot (grok and cursor stay out of `GLYPH_PROVIDER_IDS` - a monthly billing cycle isn't a short rolling window, and the credit providers report money rather than a window at all); kept for exhaustiveness over the union.
    case "openrouter":
    case "kilocode":
    case "grok":
    case "huggingface":
    case "opencode":
    case "cursor":
      return null;
  }
}

function weeklyWindow(
  rateLimits: ProviderRateLimits | null,
): ProviderRateLimitWindow | null {
  if (rateLimits === null || !rateLimits.available) return null;
  switch (rateLimits.provider) {
    case "codex":
      return rateLimits.secondary;
    case "claude-code":
      return rateLimits.sevenDay;
    case "openrouter":
    case "kilocode":
    case "grok":
    case "huggingface":
    case "opencode":
    case "cursor":
      return null;
  }
}

function toBar(
  providerId: GlyphProviderId,
  windowLabel: HeaderRateLimitWindowLabel,
  window: ProviderRateLimitWindow | null,
  degraded: boolean,
): HeaderRateLimitBar | null {
  if (window === null) return null;
  return {
    providerId,
    windowLabel,
    usedPercent: window.usedPercent,
    severity: classifyProviderRateLimitWindow(window),
    degraded,
  };
}

/** Both slots or neither - the atomic "fully populated or placeholder" pair. */
function buildPair(
  first: HeaderRateLimitBar | null,
  second: HeaderRateLimitBar | null,
): ReadonlyArray<HeaderRateLimitBar> {
  return first !== null && second !== null ? [first, second] : [];
}

/**
 * Return bars only when both slots can be filled; anything short collapses to `[]` so the glyph never mixes a real bar with a placeholder.
 */
function selectGlyphBars(
  readings: ReadonlyArray<GlyphProviderReading>,
): ReadonlyArray<HeaderRateLimitBar> {
  if (readings.length >= 2) {
    const [first, second] = readings;
    return buildPair(
      toBar(
        first.providerId,
        "5h",
        fiveHourWindow(first.rateLimits),
        first.degraded,
      ),
      toBar(
        second.providerId,
        "5h",
        fiveHourWindow(second.rateLimits),
        second.degraded,
      ),
    );
  }
  if (readings.length === 1) {
    const [only] = readings;
    return buildPair(
      toBar(
        only.providerId,
        "5h",
        fiveHourWindow(only.rateLimits),
        only.degraded,
      ),
      toBar(
        only.providerId,
        "Weekly",
        weeklyWindow(only.rateLimits),
        only.degraded,
      ),
    );
  }
  return [];
}

/** [] is the neutral placeholder, never a loading gate.
 * Observe ProviderRateLimitEnvelope via useHostQueriesWithResponseMap; this observer stays disabled and does not fetch. */
export function useHeaderRateLimitBars(
  profileSelection: RateLimitProfileSelection,
): ReadonlyArray<HeaderRateLimitBar> {
  const client = useHostClient();
  const displayProviders = useVisibleRateLimitProviders();
  const glyphProviders: ReadonlyArray<GlyphProviderTarget> =
    GLYPH_PROVIDER_IDS.flatMap((providerId) => {
      const provider = displayProviders.find(
        (candidate) => candidate.providerId === providerId,
      );
      if (provider === undefined) return [];
      const profileId = resolveRateLimitProfileId(
        profileSelection,
        providerId,
        provider.profiles,
      );
      const selectedProfile = provider.profiles.find(
        (profile) =>
          (profile.kind === "ambient" ? null : profile.profileId) === profileId,
      );
      return [
        {
          providerId,
          profileId,
          fetchEligible:
            selectedProfile === undefined
              ? provider.fetchEligibility.ambient
              : isRateLimitProfileFetchEligible(
                  provider.fetchEligibility,
                  selectedProfile,
                ),
        },
      ];
    });

  // `useHostQueriesWithResponseMap` applies one shared `options` object to every request in the batch, so it's only safe to reuse a single glyph provider's options if every glyph provider actually resolves to the same ones (true today: both are `ephemeralProcess`, never `httpFetch`).
  const glyphOptions = glyphProviders.map(
    (target) =>
      providerRateLimitQueryOptions(
        target.providerId,
        target.profileId,
        target.fetchEligible,
      ).options,
  );
  const firstGlyphOptions: ProviderRateLimitTanstackOptions | null =
    glyphOptions.length > 0 ? glyphOptions[0] : null;
  const sharedGlyphOptions =
    firstGlyphOptions !== null &&
    glyphOptions.every((options) => options.poll === firstGlyphOptions.poll)
      ? firstGlyphOptions
      : null;

  const results = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    cacheKeyIdentity: undefined,
    requests: glyphProviders.map((target) => {
      const { method, params } = providerRateLimitQueryOptions(
        target.providerId,
        target.profileId,
        target.fetchEligible,
      );
      return { method, params };
    }),
    options: sharedGlyphOptions,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });

  const readings = glyphProviders.map((target, index) => {
    const envelope = results[index].data ?? null;
    return {
      providerId: target.providerId,
      rateLimits: resolveRetainedProviderRateLimits(envelope),
      degraded:
        results[index].isError || envelopeDegradedReason(envelope) !== null,
    };
  });

  return selectGlyphBars(readings);
}
