/**
 * The single producer of rate-limit `windowKey`s: the identity a visibility
 * toggle is keyed by, plus the static copy that names each window.
 *
 * One caveat governs the whole module. A FIXED window's key is a literal and is
 * stable for the life of the app. A MODEL-SCOPED window's is not: the protocol
 * carries a `displayName` and no id, so the name is the only identity there is.
 * A model renamed upstream reads as a new window (a hidden one returns to
 * visible), and two windows reported under one name in a single snapshot are
 * told apart only by position. Both are accepted: the cost is one re-toggle,
 * and a key derived from anything else would not survive the next reading.
 */
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
} from "@traycer/protocol/host";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * What a window IS, independent of how any one provider names it. Rendering
 * groups by it (a session window is the one a status bar keeps when it has room
 * for only one), and it is the one part of an entry a caller can switch on
 * without knowing which provider produced it.
 */
export type RateLimitWindowKind =
  | "session"
  | "weekly"
  | "monthly"
  | "period"
  | "bucket"
  | "model";

export interface RateLimitWindowEntry {
  /**
   * Stable identity a visibility toggle is keyed by. It survives the provider
   * reporting nothing for a while, so a hidden window stays hidden across a
   * cold start, and it is the reason model-scoped windows can be toggled at all
   * without being enumerated anywhere in the build.
   *
   * Stable for every FIXED window, whose key is a literal. Model-scoped windows
   * are the exception and their key is BEST-EFFORT: the wire carries a
   * `displayName` and no id, so the name is the only identity available.
   * Renaming a model therefore reads as a new window and returns it to visible,
   * and two entries sharing a name within one snapshot are told apart only by
   * their position (see `withUniqueWindowKeys`). Both are accepted rather than
   * papered over: a deny-list entry that stops matching costs one re-toggle,
   * while a key invented from anything else would not survive the next reading.
   */
  readonly windowKey: string;
  /**
   * The window's name with no live data in it — what the Settings list shows,
   * and what the bar falls back to when the reset countdown is off or the
   * provider reported no reset instant.
   */
  readonly label: string;
  readonly kind: RateLimitWindowKind;
  readonly window: ProviderRateLimitWindow;
}

/**
 * Whether a provider reports ROLLING WINDOWS at all, as opposed to a credit
 * balance. Answerable without a reading, which is what the difference is for: a
 * surface that lists providers before any data has arrived (the Settings
 * toggle list) must not offer a row for a provider whose entries would be empty
 * no matter what it reports. `providerWindowEntries` returns `[]` for the same
 * three, but only once a snapshot exists to ask.
 */
export function isWindowedRateLimitProvider(
  providerId: RateLimitProviderId,
): boolean {
  switch (providerId) {
    case "claude-code":
    case "codex":
    case "opencode":
    case "grok":
    case "cursor":
      return true;
    case "openrouter":
    case "kilocode":
    case "huggingface":
      return false;
  }
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = MINUTES_PER_HOUR * 24;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
const MINUTES_PER_MONTH = MINUTES_PER_DAY * 30;

/**
 * A duration as the shortest thing that still reads as that duration — `5h`,
 * `1d`, `wk`, `mo`. Deliberately not the popover's `formatWindowDuration`,
 * which spells the same windows out as "Current session" / "Weekly": a strip
 * that shows every visible window of every provider at once cannot afford the
 * words, and a provider-reported duration nobody has a short name for still
 * falls back to the generic form rather than to prose.
 */
export function formatCompactWindowDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "usage";
  if (minutes === MINUTES_PER_WEEK) return "wk";
  if (minutes === MINUTES_PER_MONTH) return "mo";
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
  return `${minutes}m`;
}

function entry(
  windowKey: string,
  label: string,
  kind: RateLimitWindowKind,
  window: ProviderRateLimitWindow | null,
): RateLimitWindowEntry[] {
  return window === null ? [] : [{ windowKey, label, kind, window }];
}

/**
 * Make one provider's keys unique, in place, without ever moving a first
 * occurrence off the key a toggle was written under.
 *
 * Two windows can share a key inside one snapshot: Claude's model windows are
 * identified only by `displayName`, and nothing on the wire forbids two Codex
 * `extraWindows` entries carrying the same `limitId`. Two entries under one key
 * would make a single toggle govern both, and hand React a duplicate list key.
 *
 * Every RAW key is reserved BEFORE any suffix is handed out, so a generated
 * `…#2` can never land on a name a provider already reports literally — a
 * payload of `Fable, Fable#2, Fable` allocates `Fable`, `Fable#2`, `Fable#3`,
 * not a second `Fable#2`. A repeat then takes the first unused `#n`, which is
 * deterministic for a given snapshot. Labels are left alone: the duplication is
 * the provider's, and inventing a distinction in the copy would state something
 * untrue.
 *
 * Applied to a provider's WHOLE list rather than to the model windows alone, so
 * every arm's keys are covered by the same guarantee.
 */
function withUniqueWindowKeys(
  entries: ReadonlyArray<RateLimitWindowEntry>,
): ReadonlyArray<RateLimitWindowEntry> {
  const reserved = new Set(entries.map((candidate) => candidate.windowKey));
  const allocated = new Set<string>();
  return entries.map((candidate) => {
    if (!allocated.has(candidate.windowKey)) {
      allocated.add(candidate.windowKey);
      return candidate;
    }
    let occurrence = 2;
    let windowKey = `${candidate.windowKey}#${occurrence}`;
    while (reserved.has(windowKey) || allocated.has(windowKey)) {
      occurrence += 1;
      windowKey = `${candidate.windowKey}#${occurrence}`;
    }
    allocated.add(windowKey);
    return { ...candidate, windowKey };
  });
}

/**
 * Codex names its extra limits itself, so the label carries that name ahead of
 * the duration. A window whose limit went unnamed is the bare duration — the
 * key still tells the two apart, which is all a toggle needs.
 */
function codexExtraLabel(
  limitName: string | null,
  durationMinutes: number | null,
): string {
  const duration = formatCompactWindowDuration(durationMinutes);
  return limitName === null ? duration : `${limitName} ${duration}`;
}

/**
 * Every window a provider snapshot carries, as toggleable entries in the order
 * they are meant to render.
 *
 * The single producer of `windowKey`, which is what makes a deny-list possible
 * at all: a key invented at a second site would silently stop matching the one
 * a toggle was written under. Credit providers (openrouter, kilocode,
 * huggingface) report money rather than a percentage of a rolling window, so
 * they have no entries — the same reason `providerRateLimitWindows` returns
 * nothing for them — and neither does a snapshot that failed to read.
 */
export function providerWindowEntries(
  rateLimits: ProviderRateLimits,
): ReadonlyArray<RateLimitWindowEntry> {
  // Candidates are built in protocol order first and made unique afterwards, so
  // the allocator sees the whole list at once - the only way it can reserve
  // every raw key before handing out a suffix.
  return withUniqueWindowKeys(providerWindowCandidates(rateLimits));
}

/**
 * The keys and copy each provider arm reports, in render order, BEFORE
 * uniqueness is enforced. Two candidates may share a `windowKey` here; that is
 * `withUniqueWindowKeys`'s problem and nothing else's.
 */
function providerWindowCandidates(
  rateLimits: ProviderRateLimits,
): ReadonlyArray<RateLimitWindowEntry> {
  if (!rateLimits.available) return [];
  switch (rateLimits.provider) {
    case "claude-code":
      return [
        ...entry("claude-code:fiveHour", "5h", "session", rateLimits.fiveHour),
        ...entry("claude-code:sevenDay", "wk", "weekly", rateLimits.sevenDay),
        ...entry(
          "claude-code:sevenDayOpus",
          "Opus wk",
          "weekly",
          rateLimits.sevenDayOpus,
        ),
        ...entry(
          "claude-code:sevenDaySonnet",
          "Sonnet wk",
          "weekly",
          rateLimits.sevenDaySonnet,
        ),
        // Model-scoped windows are discovered from the payload, never
        // hardcoded: the set of models a plan reports changes without a client
        // release, and the display name is the only identity they carry.
        ...rateLimits.modelScoped.map((window) => ({
          windowKey: `claude-code:model:${window.displayName}`,
          label: window.displayName,
          kind: "model" as const,
          window,
        })),
      ];
    case "codex":
      return [
        ...entry(
          "codex:primary",
          formatCompactWindowDuration(
            rateLimits.primary?.durationMinutes ?? null,
          ),
          "session",
          rateLimits.primary,
        ),
        ...entry(
          "codex:secondary",
          formatCompactWindowDuration(
            rateLimits.secondary?.durationMinutes ?? null,
          ),
          "weekly",
          rateLimits.secondary,
        ),
        ...rateLimits.extraWindows.flatMap((extra) => [
          ...entry(
            `codex:extra:${extra.limitId}:primary`,
            codexExtraLabel(
              extra.limitName,
              extra.primary?.durationMinutes ?? null,
            ),
            "session",
            extra.primary,
          ),
          ...entry(
            `codex:extra:${extra.limitId}:secondary`,
            codexExtraLabel(
              extra.limitName,
              extra.secondary?.durationMinutes ?? null,
            ),
            "weekly",
            extra.secondary,
          ),
        ]),
      ];
    case "opencode":
      return [
        ...entry("opencode:fiveHour", "5h", "session", rateLimits.fiveHour),
        ...entry("opencode:weekly", "wk", "weekly", rateLimits.weekly),
        ...entry("opencode:monthly", "mo", "monthly", rateLimits.monthly),
      ];
    case "grok":
      // One synthesized billing-period window. xAI names the period itself
      // ("monthly", "annual", ...), and there is no generic short form for a
      // period whose length the payload never states.
      return entry(
        "grok:period",
        rateLimits.periodType ?? "period",
        "period",
        rateLimits.period,
      );
    case "cursor":
      // Two synthesized buckets, named for the rows Cursor's own Spending page
      // renders. Both reset on the billing cycle, so neither is a duration.
      return [
        ...entry(
          "cursor:cursorModels",
          "Cursor models",
          "bucket",
          rateLimits.cursorModels,
        ),
        ...entry(
          "cursor:otherModels",
          "Other models",
          "bucket",
          rateLimits.otherModels,
        ),
      ];
    case "openrouter":
    case "kilocode":
    case "huggingface":
      return [];
  }
}
