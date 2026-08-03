import { z } from "zod";

/**
 * Client-side mirror of `POST /api/v3/hosts/:hostId/attach-grant`'s response
 * (Architecture §4b, R4-A5; ticket T9) — see `authn-v3/.../hosts/_hostId/
 * attach-grant/index.ts` for the source of truth.
 *
 * Deliberately snake_case: this mirrors the wire shape verbatim (exactly what
 * authn-v3 serializes), not a camelCase DTO.
 */
export interface AttachGrantResponse {
  /** The signed attach-grant JWS presented to the relay's `/attach`. */
  grant: string;
  /** `"client"` or `"host"`; the client leg ignores this and only presents
   *  the opaque `grant`. */
  role: string;
  /** Grant lifetime in seconds (the relay enforces its own `exp ≤ 5m`). */
  expires_in: number;
}

export const attachGrantResponseSchema: z.ZodType<AttachGrantResponse> =
  z.object({
    grant: z.string().min(1),
    role: z.string(),
    expires_in: z.number(),
  });
