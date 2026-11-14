import {
  recordSignInRequestViaHttp,
  type SignInRequestClient,
} from "@traycer-clients/shared/host-client/provider-sign-in-request";
import type { ProviderLoginSignInRequest } from "@traycer/protocol/host/provider-schemas";
import { Response } from "undici";
import { vi, type Mock } from "vitest";

// Route body and strict request schema checked at internal commit
// 5d1c2206dd9d882c0e0bfa5007089a487047206c.
export const SIGN_IN_REQUEST_FIXTURE: ProviderLoginSignInRequest = {
  operationId: "8c6f4f97-8a2c-4b7e-9875-223456789abc",
  environmentId: "39c814a7-857f-4ca1-9db5-97342ad77fa9",
  sourceHostId: "2d46b26e-0ab3-482f-88c0-4693d42b07f7",
  sourceSharingGeneration: 3,
  harnessId: "claude-code",
};

export const SIGN_IN_REQUEST_AUTHN_URL = "https://authn.example.test";
export const SIGN_IN_REQUEST_BEARER = "test-bearer";

export type SignInRequestFetchReply =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: string;
    }
  | { readonly kind: "no-answer" };

export interface SignInRequestFetchHarness {
  readonly fetchMock: Mock<typeof fetch>;
  readonly client: SignInRequestClient;
  readonly enqueue: (reply: SignInRequestFetchReply) => void;
  readonly restore: () => void;
}

export function responseReply(
  status: number,
  body: unknown,
): SignInRequestFetchReply {
  return {
    kind: "response",
    status,
    body: JSON.stringify(body) ?? "",
  };
}

export const RECORDED_SIGN_IN_REQUEST_REPLY = responseReply(200, {
  operationId: SIGN_IN_REQUEST_FIXTURE.operationId,
  endsAt: 1_800_000_000,
});

export const UNAUTHORIZED_SIGN_IN_REQUEST_REPLY = responseReply(401, {
  statusCode: 401,
  error: "Invalid token",
});

export const FORBIDDEN_SIGN_IN_REQUEST_REPLY = responseReply(403, {
  statusCode: 403,
  error: `executable_write is not allowed here environment=${SIGN_IN_REQUEST_FIXTURE.environmentId}`,
  code: "environment_action_forbidden",
});

export const ENVIRONMENT_NOT_FOUND_SIGN_IN_REQUEST_REPLY = responseReply(404, {
  statusCode: 404,
  error: `environment not found environment=${SIGN_IN_REQUEST_FIXTURE.environmentId}`,
  code: "environment_not_found",
});

export const HOST_NOT_FOUND_SIGN_IN_REQUEST_REPLY = responseReply(404, {
  statusCode: 404,
  error: `host not found environment=${SIGN_IN_REQUEST_FIXTURE.environmentId} host=${SIGN_IN_REQUEST_FIXTURE.sourceHostId}`,
  code: "host_not_found",
});

export const MOVE_ACCEPTANCE_CONFLICT_SIGN_IN_REQUEST_REPLY = responseReply(
  409,
  {
    statusCode: 409,
    error: "this operation id names another intent",
    code: "move_acceptance_conflict",
  },
);

export const OPERATION_ACCEPTANCE_INVALID_SIGN_IN_REQUEST_REPLY = responseReply(
  409,
  {
    statusCode: 409,
    error: "this upload has no matching intent",
    code: "operation_acceptance_invalid",
    reason: "ownership_generation_mismatch",
  },
);

export const BROKER_UNAVAILABLE_SIGN_IN_REQUEST_REPLY = responseReply(503, {
  statusCode: 503,
  error: "test broker unavailable",
  code: "broker_unavailable",
});

export function noAnswerReply(): SignInRequestFetchReply {
  return { kind: "no-answer" };
}

export function installSignInRequestFetchHarness(): SignInRequestFetchHarness {
  const replies: SignInRequestFetchReply[] = [];
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const reply = replies.shift();
    if (reply === undefined || reply.kind === "no-answer") {
      throw new Error("test fetch has no answer");
    }
    return new Response(reply.body, { status: reply.status });
  });
  globalThis.fetch = fetchMock;

  return {
    fetchMock,
    client: {
      recordSignInRequest: (request, signal) =>
        recordSignInRequestViaHttp(
          SIGN_IN_REQUEST_AUTHN_URL,
          SIGN_IN_REQUEST_BEARER,
          request,
          signal,
        ),
    },
    enqueue: (reply) => replies.push(reply),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
