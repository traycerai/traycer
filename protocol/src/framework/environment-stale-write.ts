/**
 * The typed answer to a stale settings write, carried on the error envelope.
 *
 * A settings write the host forwards to the person's environment is
 * compare-and-set on the revision the editor read. When another surface
 * changed the item first, the host refuses the write with
 * `ENVIRONMENT_WRITE_STALE` and this detail: who changed it and the current
 * revision, so the page can say "changed on <host> just now" or "changed in
 * the dashboard just now" and re-read. It lives in `framework/` because the
 * error envelope does, and `host/environment-schemas.ts` re-exports
 * `environmentChangedBySchema` from here so there is one definition.
 */
import { z } from "zod";
import { lazySchema } from "./lazy-schema";

/** Who changed an item the editor last read. */
export const environmentChangedBySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("dashboard") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostLabel: z.string().nullable(),
    }),
  ]),
);
export type EnvironmentChangedBy = z.infer<typeof environmentChangedBySchema>;

export const environmentStaleWriteSchema = lazySchema(() =>
  z.object({
    changedBy: environmentChangedBySchema,
    currentRevision: z.number().int().nullable(),
  }),
);
export type EnvironmentStaleWrite = z.infer<typeof environmentStaleWriteSchema>;

/** The error code that carries `staleWrite`. */
export const ENVIRONMENT_WRITE_STALE_CODE = "ENVIRONMENT_WRITE_STALE";

/**
 * The envelope field. Optional so every `{ code, message }` that parsed before
 * still parses, and a malformed value sanitizes to absent rather than
 * rejecting the envelope: leniency on the failure path, as `holders` does.
 */
export const staleWriteWireFieldSchema = lazySchema(() =>
  environmentStaleWriteSchema.optional().catch(undefined),
);

/** The detail on `ENVIRONMENT_WRITE_STALE` only; `null` on any other code. */
export function staleWriteForCode(
  code: string,
  staleWrite: unknown,
): EnvironmentStaleWrite | null {
  if (code !== ENVIRONMENT_WRITE_STALE_CODE) return null;
  const parsed = environmentStaleWriteSchema.safeParse(staleWrite);
  return parsed.success ? parsed.data : null;
}
