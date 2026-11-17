import { z } from "zod";
import { composeRequestAbort, untilAborted } from "./request-abort";

// authn's person read also answers for a member who has left the environment.
const environmentPersonSchema = z.strictObject({
  userId: z.string().min(1),
  name: z.string().nullable(),
  handle: z.string(),
  avatarUrl: z.string().nullable(),
});
export type EnvironmentPerson = z.infer<typeof environmentPersonSchema>;

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
        // Carries a credential: never follow a redirect.
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
