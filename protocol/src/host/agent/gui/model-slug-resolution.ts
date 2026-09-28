import type { GuiAgentModelOption } from "./unary-schemas";

/**
 * Which catalog row a persisted model slug denotes.
 *
 * Traycer identifies a model by a persisted string (`ChatRunSettings.model`)
 * and then has to find it again in a LIVE, account-scoped catalog. Those two
 * things drift: a row's `slug` carries account-entitlement decoration
 * (`opus[1m]`, `claude-fable-5[1m]`), so a slug persisted when the account
 * listed the undecorated id - or a canonical id supplied by an A2A caller -
 * no longer string-equals any row. Exact equality answers "absent" and every
 * caller reads that as "the model is gone".
 *
 * Resolution is therefore three passes: exact `slug` first, then the row whose
 * `metadata.resolvedModel` (the adapter-published canonical wire id) equals
 * the input, then a match that tolerates a trailing tier marker (`[1m]`)
 * present on only one side.
 * Exact-first is load-bearing, not a preference - rows DUPLICATE
 * `resolvedModel` (Claude's `default` and `opus[1m]` both resolve to the same
 * canonical id), so alias matching alone cannot be a unique index.
 */
export type ModelMatch =
  | { readonly kind: "exact"; readonly model: GuiAgentModelOption }
  | {
      readonly kind: "alias";
      /**
       * First tied row in catalog order. Only ever a READ.
       *
       * An alias match must never be written back into a stored `modelSlug`.
       * Ambiguity is the obvious reason - `default` and `opus[1m]` tie, so
       * first-in-order picks by catalog accident - but the rule holds for a
       * UNIQUE alias too, because the matched row's own slug may itself be a
       * floating pointer: `sonnet` publishes `claude-sonnet-5`, so healing a
       * pinned `claude-sonnet-5` onto `sonnet` trades a version pin for a
       * pointer that follows the account to the next Sonnet. An alias proves
       * current ROUTING equivalence, never durable identity.
       *
       * Holding the input costs nothing - the row still renders, still answers
       * capability questions, and still runs.
       */
      readonly model: GuiAgentModelOption;
      /** `true` when more than one row publishes this canonical id. */
      readonly ambiguous: boolean;
      /** Every tied row, `model` first. Length 1 unless `ambiguous`. */
      readonly tied: readonly GuiAgentModelOption[];
    }
  | { readonly kind: "none" };

/**
 * Metadata key carrying the id a row's provider reports it currently routes to.
 *
 * A MATCHING KEY, never an identity. Measured against a real account, Claude's
 * `default` and `opus[1m]` BOTH report `claude-opus-5[1m]` - so the value is
 * itself entitlement-decorated, is duplicated across rows, and FLOATS: that
 * same value read `claude-opus-4-8[1m]` eight provider-CLI patch releases
 * earlier. Use it to find a row; never persist it, key durable state on it, or
 * treat two rows sharing one as interchangeable for anything but a capability
 * read.
 *
 * Free-form `metadata` deliberately, not a schema field: it costs no protocol
 * version bump, and a host that doesn't publish it degrades to exact-only
 * matching, which is exactly today's behaviour.
 */
export const RESOLVED_MODEL_METADATA_KEY = "resolvedModel";

/**
 * A row's canonical wire id, or `null` when the adapter doesn't publish one.
 *
 * Optional by construction: only adapters whose catalog can decorate a slug
 * populate it. Every consumer must survive its absence.
 */
export function modelResolvedModel(model: GuiAgentModelOption): string | null {
  const resolved = model.metadata[RESOLVED_MODEL_METADATA_KEY];
  if (typeof resolved !== "string") return null;
  return resolved.length === 0 ? null : resolved;
}

/**
 * Metadata flag marking rows that came from a retained catalog rather than a
 * live provider read, because the live read failed.
 *
 * A property of the READ, not of the model, so an adapter serving stale stamps
 * it on every row of that response and a caller may read it off any one of them
 * (including `models.at(0)` when the row it wanted is absent). Diagnostics
 * only - no behaviour keys off it - but without it "the model was missing" and
 * "the model was missing from a catalog we already knew was old" are the same
 * telemetry event.
 */
export const CATALOG_SERVED_STALE_METADATA_KEY = "catalogServedStale";

/** Whether this catalog read was answered from a retained (stale) catalog. */
export function catalogServedStale(
  models: readonly GuiAgentModelOption[],
): boolean {
  return models.at(0)?.metadata[CATALOG_SERVED_STALE_METADATA_KEY] === true;
}

const NO_MATCH: ModelMatch = { kind: "none" };

/**
 * The bracketed tier grammar: digits plus at most one unit letter (`[1m]`,
 * `[200k]`). Deliberately NOT "any trailing bracket" - `model[preview]` is a
 * real, distinct id and must not fold onto `model`. The same grammar as the
 * host's rate-catalog tier fallback; private here so this module's exported
 * surface is unchanged.
 */
const TIER_MARKER_PATTERN = /\[\d+[a-z]?\]$/i;

interface TierSplit {
  readonly bare: string;
  /** Lowercased, since the grammar is case-insensitive; `null` when absent. */
  readonly marker: string | null;
}

function splitTierMarker(value: string): TierSplit {
  const match = TIER_MARKER_PATTERN.exec(value);
  if (match === null) return { bare: value, marker: null };
  return {
    bare: value.slice(0, match.index),
    marker: match[0].toLowerCase(),
  };
}

/**
 * How closely `candidate` names the model `input` names, once markers are set
 * aside: `2` for the same marker on both sides (reachable only through a
 * case-only difference, since identical strings match in pass 1 or 2), `1` for
 * a marker on one side only, `0` for no match. Two different markers (`[1m]`,
 * `[200k]`) name two different tiers and never match.
 */
function tierMatchRank(input: TierSplit, candidate: string): number {
  const other = splitTierMarker(candidate);
  if (other.bare !== input.bare) return 0;
  if (input.marker === null || other.marker === null) return 1;
  return input.marker === other.marker ? 2 : 0;
}

/**
 * The rows whose `field` is the closest tier match for `input`. Only a row that
 * publishes `resolvedModel` takes part: that is the signal of an adapter whose
 * catalog decorates slugs, and every other row stays on exact-only matching.
 */
function closestTierMatches(
  models: readonly GuiAgentModelOption[],
  input: TierSplit,
  field: (model: GuiAgentModelOption) => string | null,
): GuiAgentModelOption[] {
  let bestRank = 0;
  let best: GuiAgentModelOption[] = [];
  for (const candidate of models) {
    if (modelResolvedModel(candidate) === null) continue;
    const value = field(candidate);
    if (value === null) continue;
    const rank = tierMatchRank(input, value);
    if (rank === 0 || rank < bestRank) continue;
    if (rank > bestRank) {
      bestRank = rank;
      best = [];
    }
    best.push(candidate);
  }
  return best;
}

/**
 * Three-pass resolution of `slug` against `models`.
 *
 * 1. exact `slug`;
 * 2. the row whose `metadata.resolvedModel` equals `slug`;
 * 3. the rows that agree with `slug` once a trailing tier marker (`[1m]`) is
 *    set aside - provided the marker is on at most one side or is the same on
 *    both. Two different markers are two different tiers and never match. It
 *    keeps the earlier passes' precedence: rows matching on `slug` before rows
 *    matching on `resolvedModel`, and within each, the same marker before a
 *    missing one. Only rows that publish `resolvedModel` take part: that is the
 *    signal of an adapter whose catalog decorates slugs, and every other row
 *    keeps exact-only matching.
 *
 * Pass 3 exists because a catalog can gain or lose the marker between two
 * provider CLI releases: Claude's 2.1.280 listed `opus[1m]` and
 * `claude-fable-5-1[1m]`, and 2.1.282 lists `opus` and `claude-fable-5-1` for
 * the same account. A slug persisted under either form is in neither field of
 * the other, so passes 1 and 2 answer "the model is gone" for a model that is
 * still listed. It only runs after both earlier passes miss, so a match they
 * would have made is unchanged. Its result is an `alias` like pass 2's: held
 * verbatim, never written back, and the CLI still receives the persisted slug.
 *
 * `models` must already be scoped to one harness - slugs are only unique
 * within a harness's catalog. Use {@link modelsForHarness} when the caller
 * holds a mixed list.
 *
 * An empty `slug` means "nothing selected", not "unknown model", and resolves
 * to `none` rather than accidentally alias-matching a row with no canonical id.
 */
export function resolveModelBySlug(
  models: readonly GuiAgentModelOption[],
  slug: string,
): ModelMatch {
  if (slug.length === 0) return NO_MATCH;
  const exact = models.find((candidate) => candidate.slug === slug);
  if (exact !== undefined) return { kind: "exact", model: exact };
  const tied = models.filter(
    (candidate) => modelResolvedModel(candidate) === slug,
  );
  const first = tied.at(0);
  if (first !== undefined) {
    return { kind: "alias", model: first, ambiguous: tied.length > 1, tied };
  }
  const input = splitTierMarker(slug);
  if (input.bare.length === 0) return NO_MATCH;
  // Slug before resolvedModel, as in passes 1 and 2: merging the two into one
  // tie would pick between different models by catalog order.
  const bySlug = closestTierMatches(models, input, (row) => row.slug);
  const tierTied =
    bySlug.length > 0
      ? bySlug
      : closestTierMatches(models, input, modelResolvedModel);
  const tierFirst = tierTied.at(0);
  if (tierFirst === undefined) return NO_MATCH;
  return {
    kind: "alias",
    model: tierFirst,
    ambiguous: tierTied.length > 1,
    tied: tierTied,
  };
}

/** Scope a mixed catalog to one harness before resolving. */
export function modelsForHarness(
  models: readonly GuiAgentModelOption[],
  harnessId: string,
): GuiAgentModelOption[] {
  return models.filter((candidate) => candidate.harnessId === harnessId);
}

/**
 * The row a READ-ONLY consumer should use - one that reads capability or
 * configuration off the row and discards it.
 *
 * An ambiguous alias match is usable here: the tied rows are, by definition,
 * the same underlying model, so any of them answers a capability question.
 * Callers that read a field which could differ across tied rows should check
 * {@link aliasTieDisagreement} rather than silently taking the first.
 */
export function readableModelMatch(
  match: ModelMatch,
): GuiAgentModelOption | null {
  return match.kind === "none" ? null : match.model;
}

/**
 * Whether the catalog covers this slug at all, by either pass.
 *
 * This is "is the selection valid?" - answered `true` for a held alias. It is
 * NOT "may I rewrite the stored slug?", which no alias ever licenses (see
 * {@link ModelMatch}). Conflating the two strands a working selection in the
 * same unconfirmed state as a dead one.
 */
export function modelMatchIsCovered(match: ModelMatch): boolean {
  return match.kind !== "none";
}

/**
 * Whether the rows tied on an ambiguous alias match disagree on a field the
 * caller actually consumes.
 *
 * `project` must return a primitive - comparison is `Object.is`, so a caller
 * reading an array or object field should project it to a stable string.
 */
export function aliasTieDisagreement<T>(
  match: ModelMatch,
  project: (model: GuiAgentModelOption) => T,
): boolean {
  if (match.kind !== "alias" || !match.ambiguous) return false;
  const first = project(match.model);
  return match.tied.some((candidate) => !Object.is(project(candidate), first));
}
