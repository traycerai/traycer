import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Client-side mirror of `POST /api/v3/hosts/:hostId/session-grant`'s answer:
 * a local open's host-only token, minted on a person's sign-in with no
 * request body. The same two fields ride the attach-grant answer when it is
 * asked with `session_grant_version: 2` (`AttachGrantResponse`).
 *
 * Snake_case: it mirrors the wire shape verbatim.
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
