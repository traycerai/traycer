import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { PATH_ID_PATTERN } from "./path-id";

/**
 * The executable-write grant a client mints before a write that can reach an
 * execution sink on a host (an MCP server, a shell, a launch-sensitive
 * variable, a command hook). Minted by authn on the USER's session, never by a
 * host: the host's forwarder only attaches what the client sent, so a write
 * that a host composed on its own carries none and is held as "needs you".
 *
 * Two calls, made together: `GET /api/v3/environments/me` answers the person's
 * environment id, then `POST .../executable-write-grants { hostId }` answers a
 * grant for that one host, valid for ten minutes.
 */

/** Bounds each call; both are single reads or writes of one row. */
export const EXECUTABLE_WRITE_GRANT_FETCH_TIMEOUT_MS = 15_000;

/**
 * A non-`ok` answer:
 *  - `unauthorized`  - the bearer was rejected (401/403).
 *  - `not-bound`     - authn knows no environment this host is bound to for
 *                      this user (404 `environment_not_found` or
 *                      `host_not_found`). The write then goes without a grant,
 *                      which is right: a host that is not bound forwards
 *                      nothing.
 *  - `network-error` - transport or timeout, a status with no meaning here, or
 *                      a body this build cannot parse. `detail` is a stable
 *                      classification, never a raw server body.
 */
export type ExecutableWriteGrantFetchResult =
  | {
      readonly kind: "ok";
      readonly grant: string;
      readonly expiresInSeconds: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not-bound" }
  | { readonly kind: "network-error"; readonly detail: string };

/**
 * The id is opaque here, read only as a path segment: the `env_` form belongs
 * to the services that mint and key on it, and an older authn's uuid stays
 * readable.
 */
const environmentMeSchema = z.object({
  environmentId: z.string().regex(PATH_ID_PATTERN),
});

const grantResponseSchema = z.object({
  grant: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
});

/** authn's grant route takes a host row id, which is a UUID. */
const HOST_ID_PATTERN = z.uuid();

type RawCall =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: unknown;
    }
  | { readonly kind: "network-error"; readonly detail: string };

function environmentsUrl(authnBaseUrl: string, path: string): string {
  const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
  return new URL(`api/v3/environments/${path}`, base).toString();
}

async function call(
  url: string,
  method: "GET" | "POST",
  body: string | null,
  bearerToken: string,
): Promise<RawCall> {
  // Not `AbortSignal.timeout`, which the iOS WebView floor does not have; see
  // `request-abort.ts`.
  const abort = composeRequestAbort(
    null,
    EXECUTABLE_WRITE_GRANT_FETCH_TIMEOUT_MS,
  );
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

function failureOf(status: number): ExecutableWriteGrantFetchResult | null {
  if (status === 401 || status === 403) return { kind: "unauthorized" };
  if (status === 404) return { kind: "not-bound" };
  if (status !== 200) {
    return {
      kind: "network-error",
      detail: `authn answered HTTP ${status}`,
    };
  }
  return null;
}

/**
 * Mints a grant for `hostId` on the person's own environment. A host id that
 * is not a UUID cannot be a bound host row, so it is `not-bound` before any
 * request.
 */
export async function mintExecutableWriteGrantViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  hostId: string,
): Promise<ExecutableWriteGrantFetchResult> {
  if (!HOST_ID_PATTERN.safeParse(hostId).success) return { kind: "not-bound" };
  const me = await call(
    environmentsUrl(authnBaseUrl, "me"),
    "GET",
    null,
    bearerToken,
  );
  if (me.kind === "network-error") return me;
  const meFailure = failureOf(me.status);
  if (meFailure !== null) return meFailure;
  const environment = environmentMeSchema.safeParse(me.body);
  if (!environment.success) {
    return {
      kind: "network-error",
      detail: "the environment answer did not match the contract",
    };
  }
  const minted = await call(
    environmentsUrl(
      authnBaseUrl,
      `${environment.data.environmentId}/executable-write-grants`,
    ),
    "POST",
    JSON.stringify({ hostId }),
    bearerToken,
  );
  if (minted.kind === "network-error") return minted;
  const mintFailure = failureOf(minted.status);
  if (mintFailure !== null) return mintFailure;
  const grant = grantResponseSchema.safeParse(minted.body);
  if (!grant.success) {
    return {
      kind: "network-error",
      detail: "the grant answer did not match the contract",
    };
  }
  return {
    kind: "ok",
    grant: grant.data.grant,
    expiresInSeconds: grant.data.expiresInSeconds,
  };
}
