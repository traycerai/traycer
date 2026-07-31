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
 * Resolution is therefore two passes: exact `slug` first, then the row whose
 * `metadata.resolvedModel` (the adapter-published canonical wire id) equals
 * the input. Exact-first is load-bearing, not a preference - rows DUPLICATE
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
 * Two-pass resolution of `slug` against `models`.
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
  if (first === undefined) return NO_MATCH;
  return { kind: "alias", model: first, ambiguous: tied.length > 1, tied };
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
