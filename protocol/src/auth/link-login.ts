import { z } from "zod";

/**
 * Client-side mirror of authn-v3's link-login DTOs — the confirm-gated QR
 * "link a phone" handoff, structurally the device flow with roles permuted.
 *
 * A signed-in desktop mints a PUBLIC code (user_code-shaped, fine for many
 * eyes) and renders it as a QR + typeable text. The phone CLAIMS it
 * (`/link/claim`, unauthenticated): the first scanner wins and receives the
 * private 256-bit polling SECRET — claiming grants nothing else. The desktop
 * watches its code (`/link/status`) and must explicitly approve the claim
 * (`/link/respond`); only then does the claimant's poll (`/link/token`, by
 * secret) return a session-registry-backed token pair.
 *
 * Schemas are strict so a backend contract drift fails closed at the HTTP
 * boundary rather than handing an unparsed credential to the sign-in path.
 */

export type MintLinkLoginCodeResponse = {
  /** The public code, display-grouped `XXXXX-XXXXX`. */
  code: string;
  /** Seconds until an unclaimed code expires; drives the QR re-mint cadence. */
  expires_in: number;
  /** Absolute expiry of the unclaimed window, epoch seconds. */
  expires_at: number;
};

export type ClaimLinkLoginCodeResponse = {
  status: "claimed";
  /**
   * The claimant's private polling secret. Exists only in this response —
   * session delivery is bound to it, never to the scanned public code.
   */
  secret: string;
  /** Server-directed minimum spacing between result polls, seconds. */
  interval: number;
  /**
   * The claim's MATCH CODE: two server-chosen digits the approver's prompt
   * shows as well, so the human can confirm the prompt on their desktop is
   * for the phone in their hand. An attention proof, not a credential — it
   * gates nothing, and the poll below is bound to `secret` alone. Present
   * only when the request opted in AND the server is new enough to mint one;
   * a surface without it falls back to the description-only prompt.
   */
  matchCode?: string;
};

export type LinkLoginTokenResponse = {
  token: string;
  refreshToken: string;
  familyId: string;
};

/**
 * The desktop's view of its own code. Claimant fields are DESCRIPTIVE and
 * partly attacker-influenced (User-Agent) or approximate (location); the
 * trust anchor is "you minted this and someone just scanned it", never the
 * metadata itself.
 */
export type LinkLoginStatusResponse = {
  status: "unclaimed" | "claimed" | "approved" | "denied";
  claimant: {
    address: string | null;
    userAgent: string | null;
    location: string | null;
    claimedAt: number | null;
    /**
     * The claim's match code — the two digits the phone is showing — while
     * the record is `claimed` and the request opted in; `null` once decided.
     * Absent altogether from a server that predates it, which the desktop
     * renders as the description-only prompt.
     */
    matchCode?: string | null;
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

/**
 * The match code's exact wire shape. Anything else is a contract drift and
 * fails the parse like any other, rather than putting an unreadable "code"
 * in front of the human who is asked to compare it.
 */
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
