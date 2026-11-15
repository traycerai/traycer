import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";

const mintResponseSchema = z.object({
  token: z.string().min(1),
  environmentId: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
const mintRefusalSchema = z.object({
  code: z.enum([
    "environment_not_found",
    "environment_action_forbidden",
    "seat_without_write",
    "broker_unavailable",
  ]),
});

type MintRefusalCode = z.infer<typeof mintRefusalSchema>["code"];

export type TeamComputerInstallTokenResult =
  | {
      readonly kind: "ok";
      readonly token: string;
      readonly environmentId: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "unauthorized" }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly code: MintRefusalCode;
    }
  | { readonly kind: "network-error"; readonly detail: string };

/** The install secret appears only in a successful result, never a diagnostic. */
export async function mintTeamComputerInstallTokenViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
): Promise<TeamComputerInstallTokenResult> {
  return requestTeamComputerInstallToken(
    authnBaseUrl,
    bearerToken,
    environmentId,
    (answeredEnvironmentId) => answeredEnvironmentId === environmentId,
  );
}

/**
 * Mints for the team named by its slug. authn answers with the environment id
 * the slug resolves to, which is what a staged install must be bound to.
 */
export async function mintTeamComputerInstallTokenBySlugViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  teamSlug: string,
): Promise<TeamComputerInstallTokenResult> {
  return requestTeamComputerInstallToken(
    authnBaseUrl,
    bearerToken,
    teamSlug,
    () => true,
  );
}

async function requestTeamComputerInstallToken(
  authnBaseUrl: string,
  bearerToken: string,
  selector: string,
  acceptsAnswer: (answeredEnvironmentId: string) => boolean,
): Promise<TeamComputerInstallTokenResult> {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  const url = new URL("api/v3/hosts/team-install-tokens", base).toString();
  const abort = composeRequestAbort(null, 15_000);
  let status: number;
  let body: unknown;
  try {
    const response = await untilAborted(
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ environmentId: selector }),
        // The answer carries a credential: a redirect is a non-success, never followed.
        redirect: "manual",
        signal: abort.signal,
      }),
      abort.signal,
    );
    status = response.status;
    const text = await untilAborted(response.text(), abort.signal);
    try {
      const parsed: unknown = JSON.parse(text);
      body = parsed;
    } catch {
      body = null;
    }
  } catch {
    return {
      kind: "network-error",
      detail: "the install-token request did not complete",
    };
  } finally {
    abort.clear();
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status < 200 || status >= 300) {
    const refusal = mintRefusalSchema.safeParse(body);
    return refusal.success
      ? { kind: "refused", status, code: refusal.data.code }
      : {
          kind: "network-error",
          detail: `the install-token request answered HTTP ${status}`,
        };
  }
  const result = mintResponseSchema.safeParse(body);
  if (!result.success || !acceptsAnswer(result.data.environmentId)) {
    return {
      kind: "network-error",
      detail: "the install-token answer did not match the request",
    };
  }
  return { kind: "ok", ...result.data };
}
