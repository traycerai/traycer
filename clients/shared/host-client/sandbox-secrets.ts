import {
  sandboxGrantsSummarySchema,
  secretRequestDecideBodySchema,
  type SandboxGrantsSummary,
  type SecretRequestDecision,
} from "@traycer/protocol/host/sandbox-secrets";
import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { PATH_ID_PATTERN } from "./path-id";

/**
 * The two calls a client makes to the secrets broker (authn) with the user's
 * bearer: the grants summary a sandbox's card shows, and the decision on an
 * agent's grant request. Everything else about a secret is the Secrets
 * page's.
 *
 * Both go to authn directly, never through the sandbox host: a sandbox holds
 * no user bearer, and its own credential is refused by these routes. Both are
 * rooted at the environment the sandbox or request belongs to; a caller that
 * does not know it (a server or host that predates environments) passes
 * `null`, which resolves the person's Personal environment first.
 */

/** Bounds either call; both are single reads or writes of one row. */
export const SANDBOX_SECRETS_FETCH_TIMEOUT_MS = 15_000;

/**
 * A non-`ok` answer:
 *  - `unauthorized`  - the bearer was rejected (401/403).
 *  - `not-found`     - no such host or request for this user (404). The
 *                      broker answers a foreign id the same way.
 *  - `network-error` - transport or timeout, a status with no meaning here, a
 *                      body this build cannot parse, or an id that is not one
 *                      path segment (refused before any request). `detail` is
 *                      a stable classification, never a raw server body.
 */
export type SandboxSecretsFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not-found" }
  | { readonly kind: "network-error"; readonly detail: string };

export type SandboxGrantsFetchResult =
  | { readonly kind: "ok"; readonly summary: SandboxGrantsSummary }
  | SandboxSecretsFailure;

/**
 * `ok` is the `200`: the request now stands at `status` (repeating a decision
 * answers the same). `conflict` is the `409`: it stands at `status` and this
 * decision did not change it - decided otherwise, expired, or `code` names
 * what is missing (`secret_required`).
 */
export type SecretRequestDecideFetchResult =
  | {
      readonly kind: "ok";
      readonly status: string;
      readonly decidedBy: string | null;
    }
  | {
      readonly kind: "conflict";
      readonly status: string;
      readonly code: string | null;
      /** Who settled it, when another answer got there first. */
      readonly decidedBy: string | null;
    }
  | SandboxSecretsFailure;

/**
 * A team's environment: `ok` with its id, or `not-a-member` for the route's
 * `404 team_not_found`, which it answers the same for a team the caller is not
 * an accepted member of and one that does not exist.
 */
export type TeamEnvironmentFetchResult =
  | { readonly kind: "ok"; readonly environmentId: string }
  | { readonly kind: "not-a-member" }
  | SandboxSecretsFailure;

/**
 * How many providers an environment has: its API keys (`provider` secrets) and
 * its linked plans (`connected` harness connections). Counts only: no secret's
 * name or value is kept.
 */
export interface EnvironmentProviderCounts {
  readonly providerSecretCount: number;
  readonly connectedPlanCount: number;
}

export type EnvironmentProvidersFetchResult =
  | { readonly kind: "ok"; readonly counts: EnvironmentProviderCounts }
  | SandboxSecretsFailure;

const INVALID_ID: SandboxSecretsFailure = {
  kind: "network-error",
  detail: "the id is not one path segment",
};

function environmentsUrl(authnBaseUrl: string, path: string): string {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  return new URL(`api/v3/environments/${path}`, base).toString();
}

function secretsUrl(
  authnBaseUrl: string,
  environmentId: string,
  path: string,
): string {
  return environmentsUrl(authnBaseUrl, `${environmentId}/secrets/${path}`);
}

const environmentMeSchema = z.object({ environmentId: z.string().min(1) });

/** Tolerant: only each secret's `kind` is read, so its name never is. */
const secretKindsSchema = z.object({
  secrets: z.array(z.object({ kind: z.string() })),
});

/** Tolerant: only each connection's `status` is read. */
const connectionStatusesSchema = z.object({
  connections: z.array(z.object({ status: z.string() })),
});

/** The `secret` kind a provider's API key is stored as. */
const PROVIDER_SECRET_KIND = "provider";
/** A harness connection that is linked and usable. */
const CONNECTED_STATUS = "connected";

type RawCall =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: "network-error"; readonly detail: string };

async function call(
  url: string,
  method: "GET" | "POST",
  body: string | null,
  bearerToken: string,
): Promise<RawCall> {
  // Not `AbortSignal.timeout`, which the iOS WebView floor does not have; see
  // `request-abort.ts`. Cleared once the body is read, which the timeout also
  // bounds.
  const abort = composeRequestAbort(null, SANDBOX_SECRETS_FETCH_TIMEOUT_MS);
  try {
    const response = await untilAborted(
      fetch(url, {
        method,
        headers:
          body === null
            ? {
                Authorization: `Bearer ${bearerToken}`,
                Accept: "application/json",
              }
            : {
                Authorization: `Bearer ${bearerToken}`,
                Accept: "application/json",
                "Content-Type": "application/json",
              },
        body,
        signal: abort.signal,
      }),
      abort.signal,
    );
    // An empty or non-JSON body (a proxy's HTML page) reads as `null` rather
    // than throwing before the status is classified.
    const text = await untilAborted(response.text(), abort.signal);
    return {
      kind: "response",
      status: response.status,
      body: parseJsonOrNull(text),
    };
  } catch (error: unknown) {
    return {
      kind: "network-error",
      detail:
        error instanceof Error
          ? `the request never completed (${error.name})`
          : "the request never completed",
    };
  } finally {
    abort.clear();
  }
}

function parseJsonOrNull(text: string): unknown {
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/** The outcomes every status shares, or `null` for one the caller reads. */
function sharedFailureOf(status: number): SandboxSecretsFailure | null {
  if (status === 401 || status === 403) return { kind: "unauthorized" };
  if (status === 404) return { kind: "not-found" };
  return null;
}

/**
 * The environment a call is rooted at: the one given, or, for `null`, the
 * person's Personal environment from `GET /api/v3/environments/me`.
 */
async function environmentOf(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string | null,
): Promise<
  | { readonly kind: "ok"; readonly environmentId: string }
  | SandboxSecretsFailure
> {
  if (environmentId !== null) {
    return PATH_ID_PATTERN.test(environmentId)
      ? { kind: "ok", environmentId }
      : INVALID_ID;
  }
  const raw = await call(
    environmentsUrl(authnBaseUrl, "me"),
    "GET",
    null,
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  const failure = sharedFailureOf(raw.status);
  if (failure !== null) return failure;
  const parsed = environmentMeSchema.safeParse(raw.body);
  if (raw.status !== 200 || !parsed.success) {
    return {
      kind: "network-error",
      detail: "the environment answer did not match the contract",
    };
  }
  return PATH_ID_PATTERN.test(parsed.data.environmentId)
    ? { kind: "ok", environmentId: parsed.data.environmentId }
    : INVALID_ID;
}

/**
 * `GET /api/v3/environments/:environmentId/secrets/hosts/:hostId/grants`: the
 * secrets one sandbox host may use, with each brokered destination's route
 * id.
 */
export async function fetchSandboxGrantsViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string | null,
  hostId: string,
): Promise<SandboxGrantsFetchResult> {
  if (!PATH_ID_PATTERN.test(hostId)) return INVALID_ID;
  const environment = await environmentOf(
    authnBaseUrl,
    bearerToken,
    environmentId,
  );
  if (environment.kind !== "ok") return environment;
  const raw = await call(
    secretsUrl(
      authnBaseUrl,
      environment.environmentId,
      `hosts/${hostId}/grants`,
    ),
    "GET",
    null,
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  const failure = sharedFailureOf(raw.status);
  if (failure !== null) return failure;
  if (raw.status !== 200) {
    return {
      kind: "network-error",
      detail: `the broker answered HTTP ${raw.status}`,
    };
  }
  const parsed = sandboxGrantsSummarySchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the grants summary did not match the contract",
    };
  }
  return { kind: "ok", summary: parsed.data };
}

/**
 * `POST /api/v3/environments/:environmentId/secrets/requests/:id/decide`: the
 * user's answer to an agent's grant request.
 */
export async function decideSecretRequestViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string | null,
  requestId: string,
  decision: SecretRequestDecision,
): Promise<SecretRequestDecideFetchResult> {
  if (!PATH_ID_PATTERN.test(requestId)) return INVALID_ID;
  const environment = await environmentOf(
    authnBaseUrl,
    bearerToken,
    environmentId,
  );
  if (environment.kind !== "ok") return environment;
  const raw = await call(
    secretsUrl(
      authnBaseUrl,
      environment.environmentId,
      `requests/${requestId}/decide`,
    ),
    "POST",
    JSON.stringify({ decision }),
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  const failure = sharedFailureOf(raw.status);
  if (failure !== null) return failure;
  if (raw.status !== 200 && raw.status !== 409) {
    return {
      kind: "network-error",
      detail: `the broker answered HTTP ${raw.status}`,
    };
  }
  const parsed = secretRequestDecideBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    return {
      kind: "network-error",
      detail: "the decision's answer did not match the contract",
    };
  }
  return raw.status === 200
    ? {
        kind: "ok",
        status: parsed.data.status,
        decidedBy: parsed.data.decidedBy,
      }
    : {
        kind: "conflict",
        status: parsed.data.status,
        code: parsed.data.code,
        decidedBy: parsed.data.decidedBy,
      };
}

/**
 * `GET /api/v3/teams/:teamId/environment`: the team's environment id, for a
 * sandbox created into the team. The route creates the environment and syncs
 * the member's items on its first call, so a caller reads it for a team the
 * person picked, never for every team.
 */
export async function fetchTeamEnvironmentViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  teamId: string,
): Promise<TeamEnvironmentFetchResult> {
  if (!PATH_ID_PATTERN.test(teamId)) return INVALID_ID;
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  const raw = await call(
    new URL(`api/v3/teams/${teamId}/environment`, base).toString(),
    "GET",
    null,
    bearerToken,
  );
  if (raw.kind === "network-error") return raw;
  if (raw.status === 401 || raw.status === 403) return { kind: "unauthorized" };
  if (raw.status === 404) return { kind: "not-a-member" };
  const parsed = environmentMeSchema.safeParse(raw.body);
  if (raw.status !== 200 || !parsed.success) {
    return {
      kind: "network-error",
      detail: "the environment answer did not match the contract",
    };
  }
  return PATH_ID_PATTERN.test(parsed.data.environmentId)
    ? { kind: "ok", environmentId: parsed.data.environmentId }
    : INVALID_ID;
}

/**
 * Whether an environment has a provider: `GET .../secrets` counted by
 * `kind === "provider"` (its API keys) and `GET .../secrets/harness-connections`
 * counted by `status === "connected"` (its linked plans). Any member may read
 * both. A failure of either read is the result.
 */
export async function fetchEnvironmentProvidersViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
): Promise<EnvironmentProvidersFetchResult> {
  if (!PATH_ID_PATTERN.test(environmentId)) return INVALID_ID;
  const [secrets, connections] = await Promise.all([
    // No trailing slash: the list route is `.../secrets` itself.
    call(
      environmentsUrl(authnBaseUrl, `${environmentId}/secrets`),
      "GET",
      null,
      bearerToken,
    ),
    call(
      secretsUrl(authnBaseUrl, environmentId, "harness-connections"),
      "GET",
      null,
      bearerToken,
    ),
  ]);
  for (const raw of [secrets, connections]) {
    if (raw.kind === "network-error") return raw;
    const failure = sharedFailureOf(raw.status);
    if (failure !== null) return failure;
    if (raw.status !== 200) {
      return {
        kind: "network-error",
        detail: `the broker answered HTTP ${raw.status}`,
      };
    }
  }
  const kinds =
    secrets.kind === "response"
      ? secretKindsSchema.safeParse(secrets.body)
      : null;
  const statuses =
    connections.kind === "response"
      ? connectionStatusesSchema.safeParse(connections.body)
      : null;
  if (
    kinds === null ||
    statuses === null ||
    !kinds.success ||
    !statuses.success
  ) {
    return {
      kind: "network-error",
      detail: "the providers answer did not match the contract",
    };
  }
  return {
    kind: "ok",
    counts: {
      providerSecretCount: kinds.data.secrets.filter(
        (secret) => secret.kind === PROVIDER_SECRET_KIND,
      ).length,
      connectedPlanCount: statuses.data.connections.filter(
        (connection) => connection.status === CONNECTED_STATUS,
      ).length,
    },
  };
}
