import { z } from "zod";
import type { AuthenticatedUser } from "@traycer/protocol/auth";

/**
 * authn's preview-features verdict as this client reads it: environments,
 * sandboxes and Tracy Bots, carried on the negotiated user record.
 *
 * Stands in for `@traycer/protocol/auth/preview-features` until the
 * `authenticated-user-response` 3.1 minor lands; the names and shapes are
 * that module's, so the swap is an import. Until then the record's parse
 * strips the field, and every signed-in reading is all off.
 */
export interface PreviewFeatures {
  readonly environments: boolean;
  readonly sandboxes: boolean;
  readonly bots: boolean;
}

export type PreviewFeature = keyof PreviewFeatures;

/**
 * Before the user record has been read the client holds `unread`, which is
 * not a verdict. A site whose off branch is safe on no information treats it
 * as off and says so where it does; none collapses it for another site.
 */
export type PreviewFeaturesReading =
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly verdict: PreviewFeatures };

export type PreviewFeatureState = "on" | "off" | "unread";

const PREVIEW_FEATURES_OFF: PreviewFeatures = Object.freeze({
  environments: false,
  sandboxes: false,
  bots: false,
});

/** Sandboxes and bots require environments; bots moves with environments. */
function isSupportedPreviewFeatures(verdict: PreviewFeatures): boolean {
  return verdict.environments
    ? verdict.bots
    : !verdict.sandboxes && !verdict.bots;
}

const previewFeaturesSchema = z
  .object({
    environments: z.boolean(),
    sandboxes: z.boolean(),
    bots: z.boolean(),
  })
  .refine(isSupportedPreviewFeatures)
  .catch(PREVIEW_FEATURES_OFF);

/** Never throws: an absent, malformed or unsupported value is all off. */
export function readPreviewFeatures(raw: unknown): PreviewFeatures {
  return previewFeaturesSchema.parse(raw);
}

/**
 * The record's raw field. Record 3.1 declares it; until then it is absent
 * from the type, and from the parsed record.
 */
export function rawPreviewFeatures(user: AuthenticatedUser): unknown {
  return "previewFeatures" in user ? user.previewFeatures : undefined;
}

export function previewFeatureState(
  reading: PreviewFeaturesReading,
  feature: PreviewFeature,
): PreviewFeatureState {
  if (reading.kind === "unread") return "unread";
  return reading.verdict[feature] ? "on" : "off";
}
