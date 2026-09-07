import { z } from "zod";

/**
 * Client-side mirror of authn-v3's link-login DTOs - the confirm-gated QR "link a phone" handoff, structurally the device flow with roles permuted.
 * The desktop watches its code (`/link/status`) and must explicitly approve the claim (`/link/respond`); only then does the claimant's poll (`/link/token`, by secret) return a session-registry-backed token pair.
 */

export type MintLinkLoginCodeResponse = {
  code: string;
  /** Seconds until an unclaimed code expires; drives the QR re-mint cadence. */
  expires_in: number;
  /** Absolute expiry of the unclaimed window, epoch seconds. */
  expires_at: number;
};

export type ClaimLinkLoginCodeResponse = {
  status: "claimed";
  /**
   * The claimant's private polling secret. Exists only in this response -
   * session delivery is bound to it, never to the scanned public code.
   */
  secret: string;
  /** Server-directed minimum spacing between result polls, seconds. */
  interval: number;
  matchCode?: string;
};

export type LinkLoginTokenResponse = {
  token: string;
  refreshToken: string;
  familyId: string;
};

/**
 * The desktop's view of its own code.
 * Claimant fields are DESCRIPTIVE and partly attacker-influenced (User-Agent) or approximate (location); the trust anchor is "you minted this and someone just scanned it", never the metadata itself.
 */
export type LinkLoginStatusResponse = {
  status: "unclaimed" | "claimed" | "approved" | "denied";
  claimant: {
    address: string | null;
    userAgent: string | null;
    location: string | null;
    claimedAt: number | null;
    /**
     * The claim's match code, tri-state on purpose
     * The approver therefore renders this as a loud degraded-mode warning, never as the ordinary description prompt. - absent: the record is not `claimed`, this request did not opt in, or the server predates the code.
     */
    matchCode?: string | null;
    /**
     * When the pending claim expires unanswered (epoch ms), while the record is `claimed` and the request opted in with `acceptClaimExpiry`.
     */
    claimExpiresAt?: number;
  } | null;
};

export type RespondLinkLoginResponse = {
  ok: true;
};

export const mintLinkLoginCodeResponseSchema: z.ZodType<MintLinkLoginCodeResponse> =
  z
    .object({
      code: z.string().min(1),
      expires_in: z.number().int().positive(),
      expires_at: z.number().int().positive(),
    })
    .strict();

/** The match code's exact wire shape. */
const linkLoginMatchCodeSchema = z.string().regex(/^[0-9]{2}$/);

export const claimLinkLoginCodeResponseSchema: z.ZodType<ClaimLinkLoginCodeResponse> =
  z
    .object({
      status: z.literal("claimed"),
      secret: z.string().min(1),
      interval: z.number().int().positive(),
      matchCode: linkLoginMatchCodeSchema.optional(),
    })
    .strict();

export const linkLoginTokenResponseSchema: z.ZodType<LinkLoginTokenResponse> = z
  .object({
    token: z.string().min(1),
    refreshToken: z.string().min(1),
    familyId: z.string().min(1),
  })
  .strict();

export const linkLoginStatusResponseSchema: z.ZodType<LinkLoginStatusResponse> =
  z
    .object({
      status: z.enum(["unclaimed", "claimed", "approved", "denied"]),
      claimant: z
        .object({
          address: z.string().nullable(),
          userAgent: z.string().nullable(),
          location: z.string().nullable(),
          claimedAt: z.number().nullable(),
          matchCode: linkLoginMatchCodeSchema.nullable().optional(),
          claimExpiresAt: z.number().int().positive().optional(),
        })
        .strict()
        .nullable(),
    })
    .strict();

export const respondLinkLoginResponseSchema: z.ZodType<RespondLinkLoginResponse> =
  z
    .object({
      ok: z.literal(true),
    })
    .strict();
