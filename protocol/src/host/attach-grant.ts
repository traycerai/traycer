import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

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
  /**
   * Present only when a user bearer mints for a `kind: sandbox` host: the
   * host-bound session grant (`typ: "session-grant"`, `hostId`, `jti`, 10
   * minute `exp`) the client presents in `OPEN.authz` v2 INSTEAD of its user
   * bearer, so no user credential ever reaches a sandbox. Absent for every
   * other target.
   */
  session_grant?: string;
  /** The session grant's lifetime in seconds; present with `session_grant`. */
  session_grant_expires_in?: number;
}

export const attachGrantResponseSchema: z.ZodType<AttachGrantResponse> =
  lazySchema(() =>
    z.object({
      grant: z.string().min(1),
      role: z.string(),
      expires_in: z.number(),
      session_grant: z.string().min(1).optional(),
      session_grant_expires_in: z.number().optional(),
    }),
  );
