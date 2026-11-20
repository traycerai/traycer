import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Mirrors `POST /api/v3/hosts/:hostId/session-grant`'s answer verbatim: a local open's
 * host-only token, minted on a sign-in. The same fields ride `AttachGrantResponse`
 * asked with `session_grant_version: 2`.
 */
export interface HostSessionGrantResponse {
  readonly session_grant: string;
  /** The token's lifetime in seconds. */
  readonly session_grant_expires_in: number;
}

export const hostSessionGrantResponseSchema: z.ZodType<HostSessionGrantResponse> =
  lazySchema(() =>
    z.object({
      session_grant: z.string().min(1),
      session_grant_expires_in: z.number().positive(),
    }),
  );
