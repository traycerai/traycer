import type { z } from "zod";
import {
  environmentInvitationsAcceptResponseSchema,
  environmentInvitationsListResponseSchema,
  type EnvironmentInvitationsAcceptResponse,
  type EnvironmentInvitationsListResponse,
} from "@traycer/protocol/host/environment/contracts";
import { composeRequestAbort } from "./request-abort";

/** The same account routes the host and pool forward, for older serving tiers. */
const INVITATIONS_PATH = "api/v3/environments/me/invitations";

async function requestInvitations<T>(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string | null,
  schema: z.ZodType<T>,
  signal: AbortSignal | null,
): Promise<T> {
  const abort = composeRequestAbort(signal, 15_000);
  try {
    const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
    const response = await fetch(
      new URL(
        environmentId === null
          ? INVITATIONS_PATH
          : `${INVITATIONS_PATH}/accept`,
        base,
      ),
      {
        method: environmentId === null ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-traycer-invite-acceptance": "explicit",
        },
        body: environmentId === null ? null : JSON.stringify({ environmentId }),
        signal: abort.signal,
      },
    );
    const accepting = environmentId !== null;
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        accepting
          ? "Sign in again to accept this invitation."
          : "Sign in again to review team invitations.",
      );
    }
    if (!response.ok) {
      throw new Error(
        accepting
          ? "Couldn't accept this invitation. Try again."
          : "Couldn't reach team invitations. Try again.",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        accepting
          ? "Couldn't confirm this invitation. Check your teams and try again."
          : "Couldn't read team invitations. Try again.",
      );
    }
    return parsed.data;
  } finally {
    abort.clear();
  }
}

/** Reads invitations without accepting any, independent of a host's version. */
export function fetchEnvironmentInvitations(
  authnBaseUrl: string,
  bearerToken: string,
  signal: AbortSignal | null,
): Promise<EnvironmentInvitationsListResponse> {
  return requestInvitations(
    authnBaseUrl,
    bearerToken,
    null,
    environmentInvitationsListResponseSchema,
    signal,
  );
}

/** Accepts only the invitation whose grant the person reviewed. */
export function acceptEnvironmentInvitation(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
): Promise<EnvironmentInvitationsAcceptResponse> {
  return requestInvitations(
    authnBaseUrl,
    bearerToken,
    environmentId,
    environmentInvitationsAcceptResponseSchema,
    null,
  );
}
