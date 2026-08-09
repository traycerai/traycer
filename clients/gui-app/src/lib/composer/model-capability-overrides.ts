/**
 * Client-side capability overrides for models whose host-provided metadata
 * misses a capability the model actually has. Curated family matches only;
 * an override here wins over host metadata, and overrides only ever ADD a
 * capability (never strip one the host claims).
 */

/** Structural identity this module needs — satisfied by GuiAgentModelOption. */
export interface ModelCapabilityIdentity {
  readonly harnessId: string;
  readonly slug: string;
  readonly label: string;
}

function normalizeModelText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Kimi K3 and K2.7 families accept image input, but the host model catalog
 * does not flag them, so the composer refuses image attachments for them.
 *
 * Two match shapes:
 * - Kimi harness (`harnessId === "kimi"`): the harness itself is Kimi, so the
 *   generation marker alone is enough — covers bare slugs like "k3" whose
 *   label may be just "K3".
 * - Any other harness (omp/opencode/...): require "kimi" in slug+label plus
 *   the generation marker — covers "Kimi K3 (ClinePass)", "moonshot/kimi-k3".
 */
function isKimiVisionFamily(identity: ModelCapabilityIdentity): boolean {
  const normalized = normalizeModelText(`${identity.slug} ${identity.label}`);
  const generation = normalized.includes("k3") || normalized.includes("k27");
  if (identity.harnessId === "kimi") return generation;
  return normalized.includes("kimi") && generation;
}

/**
 * Returns `true` when the model is known to accept image attachments despite
 * host metadata, `null` when this module has no opinion (caller falls back to
 * host metadata). Never returns `false`: absence of an override is not a
 * denial.
 */
export function modelImageSupportOverride(
  identity: ModelCapabilityIdentity,
): boolean | null {
  if (isKimiVisionFamily(identity)) return true;
  return null;
}
