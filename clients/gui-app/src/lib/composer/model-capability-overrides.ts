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
 * Matches slugs/labels like "kimi-k3", "kimi-k2.7-code", "Kimi K2.7",
 * "moonshot/kimi-k3-turbo" — normalized to lowercase alphanumerics first.
 */
function isKimiVisionFamily(normalized: string): boolean {
  if (!normalized.includes("kimi")) return false;
  return normalized.includes("k3") || normalized.includes("k27");
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
  const normalized = normalizeModelText(`${identity.slug} ${identity.label}`);
  if (isKimiVisionFamily(normalized)) return true;
  return null;
}
