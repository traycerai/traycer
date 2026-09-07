import { z } from "zod";

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
