import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
} from "@traycer/protocol/host";
import { useHostQueriesWithResponseMap } from "@/hooks/host/use-host-queries";
import {
  providerRateLimitQueryOptions,
  type ProviderRateLimitTanstackOptions,
} from "@/hooks/host/provider-rate-limit-query-options";
import { useConfiguredRateLimitProviders } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  envelopeDegradedReason,
  mapResponseToProviderRateLimitEnvelope,
  resolveRetainedProviderRateLimits,
  type ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import {
  rateLimitWindowSeverity,
  type RateLimitWindowSeverity,
} from "@/lib/rate-limits/window-severity";

/**
 * The two windows a glyph bar can stand for, in fixed draw order: a provider's
 * 5-hour window and its Weekly window. Also the per-bar disambiguator in the
 * React key, since a single provider can own *both* bars (see below).
 */
export type HeaderRateLimitWindowLabel = "5h" | "Weekly";

export interface HeaderRateLimitBar {
  readonly providerId: RateLimitProviderId;
  readonly windowLabel: HeaderRateLimitWindowLabel;
  readonly usedPercent: number;
  readonly severity: RateLimitWindowSeverity;
  /** Most recent poll for this provider errored, but this is last-known-good data. */
  readonly degraded: boolean;
}

/**
 * The only providers that ever occupy a glyph slot, in fixed draw order (codex
 * before claude-code, matching `PROVIDER_ID_ORDER`). OpenRouter and Kilo Code
 * are popover-only and never contribute a header bar. Both of these are the
 * `ephemeralProcess` fetch lane, so the glyph needs a single
 * `useHostQueriesWithResponseMap` call and no `httpFetch` plumbing at all.
 */
const GLYPH_PROVIDER_IDS = ["codex", "claude-code"] as const;

type GlyphProviderId = (typeof GLYPH_PROVIDER_IDS)[number];

/** A glyph provider's live query state, paired with its id (in draw order). */
interface GlyphProviderReading {
  readonly providerId: GlyphProviderId;
  readonly rateLimits: ProviderRateLimits | null;
  readonly degraded: boolean;
}

/** The 5h window a glyph provider reports (Codex `primary`, Claude `fiveHour`). */
function fiveHourWindow(
  rateLimits: ProviderRateLimits | null,
): ProviderRateLimitWindow | null {
  if (rateLimits === null || !rateLimits.available) return null;
  switch (rateLimits.provider) {
    case "codex":
      return rateLimits.primary;
    case "claude-code":
      return rateLimits.fiveHour;
    // OpenRouter/Kilo Code are never queried for a glyph slot; kept for
    // exhaustiveness over the union.
    case "openrouter":
    case "kilocode":
      return null;
  }
}

/** The Weekly window a glyph provider reports (Codex `secondary`, Claude `sevenDay`). */
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
    severity: rateLimitWindowSeverity(window.usedPercent),
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
 * The glyph's two bars, or `[]` when it can't populate *both* slots:
 *
 * - Both providers configured: bar 1 is Codex's 5h window, bar 2 is Claude
 *   Code's 5h window (glyph order).
 * - Exactly one configured: that provider fills both slots with its 5h and
 *   Weekly windows.
 *
 * Partial-load policy: this returns bars only when it can fill BOTH slots;
 * anything short of that (a provider still cold, or a window the provider
 * doesn't report) collapses to `[]`, and the icon then shows its neutral 2-bar
 * placeholder. The glyph is a single fixed 2-bar unit (the CodexBar pre-filled
 * look), so it flips atomically from placeholder to fully-populated rather than
 * ever rendering a half-real / half-neutral mix - simpler and less ambiguous
 * than padding a lone real bar with a placeholder-shaped one.
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

/**
 * The header glyph's bar data: a fixed two-bar summary scoped to Codex and
 * Claude Code only. When both are configured the glyph shows each provider's 5h
 * window (codex first); when only one is configured that provider fills both
 * bars with its 5h and Weekly windows. OpenRouter/Kilo Code never appear here
 * (popover-only). See `selectGlyphBars` for the exact selection and the
 * partial-load policy; a return of `[]` means "render the neutral placeholder".
 *
 * Mounting `useHostQueriesWithResponseMap` here drives the initial
 * fetch-on-mount for the two glyph providers (both `ephemeralProcess`); the
 * serial queue only bounds their *subsequent* background/turn/manual
 * triggers. Because this hook no longer queries the `httpFetch` lane,
 * OpenRouter/Kilo Code are fetched lazily on popover / Settings open rather
 * than pre-fetched at app-shell mount - which is fine, since nothing at the
 * shell level displays their usage.
 *
 * Uses the envelope-aware `useHostQueriesWithResponseMap` (not the plain
 * `useHostQueries`) so this passive observer's declared cache shape agrees
 * with what `ephemeral-fetch-queue.ts` actually writes for these keys
 * (`ProviderRateLimitEnvelope`) - both providers here are always
 * `ephemeralProcess`, so this observer stays disabled and never issues its
 * own fetch, but the TData type still has to match reality.
 *
 * A provider still cold (no data yet) contributes nothing - callers render the
 * neutral/placeholder glyph while this returns `[]`, never a loading state, so
 * the icon never gates header render on a fetch.
 */
export function useHeaderRateLimitBars(): ReadonlyArray<HeaderRateLimitBar> {
  const client = useHostClient();
  const configured = useConfiguredRateLimitProviders();
  const configuredIds = new Set(
    configured.map((provider) => provider.providerId),
  );
  const glyphProviders = GLYPH_PROVIDER_IDS.filter((id) =>
    configuredIds.has(id),
  );

  // `useHostQueriesWithResponseMap` applies one shared `options` object to
  // every request in the batch, so it's only safe to reuse a single glyph
  // provider's options if every glyph provider actually resolves to the same
  // ones (true today: both are `ephemeralProcess`, never `httpFetch`).
  // Verified here - rather than just trusted from `GLYPH_PROVIDER_IDS`'s own
  // comment - so a future glyph provider on a different lane falls back to
  // `null` (TanStack's defaults) instead of silently borrowing an unrelated
  // provider's refetch behavior.
  const glyphOptions = glyphProviders.map(
    (providerId) => providerRateLimitQueryOptions(providerId).options,
  );
  const firstGlyphOptions: ProviderRateLimitTanstackOptions | null =
    glyphOptions.length > 0 ? glyphOptions[0] : null;
  const sharedGlyphOptions =
    firstGlyphOptions !== null &&
    glyphOptions.every(
      (options) =>
        options.refetchInterval === firstGlyphOptions.refetchInterval,
    )
      ? firstGlyphOptions
      : null;

  const results = useHostQueriesWithResponseMap<
    HostRpcRegistry,
    "host.getRateLimitUsage",
    ProviderRateLimitEnvelope
  >({
    client,
    requests: glyphProviders.map((providerId) => {
      const { method, params } = providerRateLimitQueryOptions(providerId);
      return { method, params };
    }),
    options: sharedGlyphOptions,
    mapResponse: mapResponseToProviderRateLimitEnvelope,
  });

  const readings = glyphProviders.map((providerId, index) => {
    const envelope = results[index].data ?? null;
    return {
      providerId,
      rateLimits: resolveRetainedProviderRateLimits(envelope),
      degraded:
        results[index].isError || envelopeDegradedReason(envelope) !== null,
    };
  });

  return selectGlyphBars(readings);
}
