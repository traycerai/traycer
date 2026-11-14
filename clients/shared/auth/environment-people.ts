import { z } from "zod";
import { composeRequestAbort, untilAborted } from "./request-abort";

/**
 * Someone who is or was a member of an environment, as authn's person read
 * names them (`GET /api/v3/environments/:environmentId/people/:userId`). It
 * answers for a member who has since left, which the member directory no
 * longer lists.
 */
const environmentPersonSchema = z
  .object({
    userId: z.string().min(1),
    name: z.string().nullable(),
    handle: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  })
  .strict();
export type EnvironmentPerson = z.infer<typeof environmentPersonSchema>;

/**
 * `found` for someone who is or was a member; `not-found` for authn's 404
 * `person_not_found` (never a member, or not readable by this sign-in). Any
 * other answer throws.
 */
export type EnvironmentPersonResult =
  | { readonly kind: "found"; readonly person: EnvironmentPerson }
  | { readonly kind: "not-found" };

export async function fetchEnvironmentPerson(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  userId: string,
  signal: AbortSignal | null,
): Promise<EnvironmentPersonResult> {
  const abort = composeRequestAbort(signal, 15_000);
  try {
    const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
    const url = new URL(
      `api/v3/environments/${encodeURIComponent(environmentId)}/people/${encodeURIComponent(userId)}`,
      base,
    );
    const response = await untilAborted(
      fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
        },
        // A redirect is an answer that is not this read, never a hop to take
        // with the sign-in attached.
        redirect: "manual",
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (response.status === 404) return { kind: "not-found" };
    if (response.status !== 200) {
      throw new Error(`environment person read answered ${response.status}`);
    }
    const body: unknown = await untilAborted(
      response.json(),
      abort.signal,
    ).catch(() => null);
    const parsed = environmentPersonSchema.safeParse(body);
    if (!parsed.success || parsed.data.userId !== userId) {
      throw new Error("environment person read answered an unreadable body");
    }
    return { kind: "found", person: parsed.data };
  } finally {
    abort.clear();
  }
}
