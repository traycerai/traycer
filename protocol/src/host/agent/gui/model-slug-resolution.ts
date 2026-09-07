import type { GuiAgentModelOption } from "./unary-schemas";

/**
 * Which catalog row a persisted model slug denotes.
 * Exact-first is load-bearing, not a preference - rows DUPLICATE `resolvedModel` (Claude's `default` and `opus[1m]` both resolve to the same canonical id), so alias matching alone cannot be a unique index.
 */
export type ModelMatch =
  | { readonly kind: "exact"; readonly model: GuiAgentModelOption }
  | {
      readonly kind: "alias";
      /**
       * First tied row in catalog order.
       * An alias match must never be written back into a stored `modelSlug`.
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
 * Use it to find a row; never persist it, key durable state on it, or treat two rows sharing one as interchangeable for anything but a capability read.
 */
export const RESOLVED_MODEL_METADATA_KEY = "resolvedModel";

/** A row's canonical wire id, or `null` when the adapter doesn't publish one. */
export function modelResolvedModel(model: GuiAgentModelOption): string | null {
  const resolved = model.metadata[RESOLVED_MODEL_METADATA_KEY];
  if (typeof resolved !== "string") return null;
  return resolved.length === 0 ? null : resolved;
}

/**
 * Metadata flag marking rows that came from a retained catalog rather than a live provider read, because the live read failed.
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
 * `models` must already be scoped to one harness - slugs are only unique within a harness's catalog.
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
 * The row a READ-ONLY consumer should use - one that reads capability or configuration off the row and discards it.
 * Callers that read a field which could differ across tied rows should check {@link aliasTieDisagreement} rather than silently taking the first.
 */
export function readableModelMatch(
  match: ModelMatch,
): GuiAgentModelOption | null {
  return match.kind === "none" ? null : match.model;
}

/**
 * Whether the catalog covers this slug (true for a held alias). Not a license to rewrite the stored slug.
 */
export function modelMatchIsCovered(match: ModelMatch): boolean {
  return match.kind !== "none";
}

/**
 * Whether the rows tied on an ambiguous alias match disagree on a field the caller actually consumes.
 * `project` must return a primitive - comparison is `Object.is`, so a caller reading an array or object field should project it to a stable string.
 */
export function aliasTieDisagreement<T>(
  match: ModelMatch,
  project: (model: GuiAgentModelOption) => T,
): boolean {
  if (match.kind !== "alias" || !match.ambiguous) return false;
  const first = project(match.model);
  return match.tied.some((candidate) => !Object.is(project(candidate), first));
}
