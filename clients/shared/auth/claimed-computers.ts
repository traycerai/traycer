import { z } from "zod";
import { composeRequestAbort, untilAborted } from "./request-abort";

// Kept 30 days by authn; a non-member reads 404 `environment_not_found`.
function claimedComputersPath(environmentId: string): string {
  return `api/v3/environments/${encodeURIComponent(environmentId)}/claimed-computers`;
}

const claimedComputerSchema = z.object({
  hostId: z.string().min(1),
  computerName: z.string().nullable(),
  /** The claimant's display name; authn sends no user id of theirs. */
  claimantName: z.string(),
  claimedAt: z.iso.datetime(),
});
const claimedComputersSchema = z.object({
  claims: z.array(claimedComputerSchema),
});

export type ClaimedComputer = z.infer<typeof claimedComputerSchema>;

export type ClaimedComputersResult =
  | { readonly kind: "ok"; readonly claims: readonly ClaimedComputer[] }
  | { readonly kind: "not-found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed" };

export async function fetchClaimedComputers(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  signal: AbortSignal | null,
): Promise<ClaimedComputersResult> {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  const abort = composeRequestAbort(signal, 10_000);
  try {
    const response = await untilAborted(
      fetch(new URL(claimedComputersPath(environmentId), base), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
        },
        // Carries a credential: never follow a redirect.
        redirect: "manual",
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 404) return { kind: "not-found" };
    if (response.status !== 200) return { kind: "failed" };
    const body: unknown = await untilAborted(
      response.json(),
      abort.signal,
    ).catch(() => null);
    const parsed = claimedComputersSchema.safeParse(body);
    return parsed.success
      ? { kind: "ok", claims: parsed.data.claims }
      : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  } finally {
    abort.clear();
  }
}
