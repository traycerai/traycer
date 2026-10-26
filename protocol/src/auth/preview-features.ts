import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * authn's verdict on which preview features a principal may see and use:
 * environments, sandboxes and Tracy Bots. One verdict, decided by authn,
 * carried on reads every surface already makes; no surface computes it.
 *
 * ## Supported verdicts
 *
 * Exactly three, and nothing else:
 *
 * - all off;
 * - `{ environments: true, sandboxes: false, bots: true }`;
 * - `{ environments: true, sandboxes: true, bots: true }`.
 *
 * Sandboxes and bots require environments, and bots moves WITH
 * environments: `environments: true, bots: false` is not a supported
 * verdict. Every bots site on the host rides the environment projection,
 * so an independent bots-off state would leave work running that no verdict
 * names. Any other combination, a missing value, a value that is not an
 * object of three booleans, and anything unparseable all read as
 * {@link PREVIEW_FEATURES_OFF}. The parse enforces that; no reader decides
 * it again.
 *
 * Unknown keys are stripped, not refused: a fourth feature added later
 * reaches an older reader as these three, not as a refusal of the whole
 * verdict.
 *
 * ## The carriers
 *
 * Every carrier declares the field as `previewFeaturesSchema.optional()`, so
 * a bad value costs the reader the verdict and never the record around it,
 * and every read site hands its consumers {@link readPreviewFeatures}'s
 * answer, never the raw field:
 *
 * - `GET /api/v3/user/negotiated`: `authenticated-user-response` 3.1. Clients
 *   read it through `clients/shared/auth/auth-validation.ts`; traycer-server
 *   reads it in `verify-auth.ts` (`verdictFromNegotiatedRecord`). A body
 *   served below 3.1 upgrades to the off verdict.
 * - `GET /api/v3/hosts/status`: the host's own verdict, read by
 *   `readHostBinding` (internal, `hostStatusResponseSchema`).
 * - `GET /api/v3/user/host-identity`: a host's verdict as traycer-server's
 *   `authenticateHost` reads it (internal).
 * - `GET /api/v3/user/team-member`: the member's verdict beside the member
 *   verdict traycer-server reads (internal).
 * - `GET /api/v2/user`: cloud-ui. No carrier work: that route sends the true
 *   value unmapped and cloud-ui validates nothing, so the field arrives with
 *   the record. An absent key there is off.
 */
export interface PreviewFeatures {
  readonly environments: boolean;
  readonly sandboxes: boolean;
  readonly bots: boolean;
}

/** The verdict every missing, malformed or unsupported value reads as. */
export const PREVIEW_FEATURES_OFF: PreviewFeatures = Object.freeze({
  environments: false,
  sandboxes: false,
  bots: false,
});

function isSupportedPreviewFeatures(verdict: PreviewFeatures): boolean {
  return verdict.environments
    ? verdict.bots
    : !verdict.sandboxes && !verdict.bots;
}

export const previewFeaturesSchema = lazySchema(() =>
  z
    .object({
      environments: z.boolean(),
      sandboxes: z.boolean(),
      bots: z.boolean(),
    })
    .refine(isSupportedPreviewFeatures)
    .catch(PREVIEW_FEATURES_OFF),
);

/**
 * Reads a raw carrier value as a verdict. Never throws: whatever it cannot
 * read as one of the three supported verdicts is {@link PREVIEW_FEATURES_OFF}.
 */
export function readPreviewFeatures(raw: unknown): PreviewFeatures {
  return previewFeaturesSchema.parse(raw);
}

/** One of the three preview features a verdict names. */
export type PreviewFeature = keyof PreviewFeatures;

/**
 * What a surface holds before and after it has read a verdict. A surface
 * that starts before its first read (a host booting before it has reached
 * authn, a client before its identity read) holds `unread`, which is NOT a
 * verdict: "missing reads as off" means nothing unreleased is enabled without
 * a positive answer, never that an off-state action may run. A site whose
 * off branch is irreversible (a delete, a migration) waits for `read`; a site
 * whose off branch is safe on no information treats `unread` as off, and says
 * so where it does.
 */
export type PreviewFeaturesReading =
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly verdict: PreviewFeatures };

/** One feature's state in a reading: `on`, `off`, or `unread`. */
export type PreviewFeatureState = "on" | "off" | "unread";

export function previewFeatureState(
  reading: PreviewFeaturesReading,
  feature: PreviewFeature,
): PreviewFeatureState {
  if (reading.kind === "unread") return "unread";
  return reading.verdict[feature] ? "on" : "off";
}
