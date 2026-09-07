/**
 * Test fixtures for the shared `RequestContext`.
 * Provides per-origin builders (host RPC, host stream, renderer, extension, and a generic "test") so test code can construct an authenticated context without importing host-only transport types.
 */
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type AuthenticatedIdentity,
  type RequestContext,
  type RequestContextOrigin,
} from "@traycer/protocol/auth/request-context";
import { createAuthenticatedUserFixture } from "./authenticated-user";

export interface RequestContextFixtureOverrides {
  readonly user: AuthenticatedUser | undefined;
  readonly userOverrides: Partial<AuthenticatedUser> | undefined;
  readonly identity: AuthenticatedIdentity | undefined;
  readonly bearerToken: string | undefined;
  readonly origin: RequestContextOrigin | undefined;
  readonly connectionId: string | undefined;
  readonly operationId: string | undefined;
  readonly externalAbortSignal: AbortSignal | undefined;
}

const DEFAULT_BEARER = "test-bearer-token";

function resolveIdentity(
  overrides: Partial<RequestContextFixtureOverrides>,
): AuthenticatedIdentity {
  if (overrides.identity !== undefined) {
    return overrides.identity;
  }
  if (overrides.user !== undefined) {
    return identityFromAuthenticatedUser(overrides.user);
  }
  return identityFromAuthenticatedUser(
    createAuthenticatedUserFixture(overrides.userOverrides),
  );
}

export function createRequestContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  const identity = resolveIdentity(overrides);
  return createRequestContext({
    identity,
    bearerToken: overrides.bearerToken ?? DEFAULT_BEARER,
    origin: overrides.origin ?? "test",
    connectionId: overrides.connectionId,
    operationId: overrides.operationId,
    externalAbortSignal: overrides.externalAbortSignal,
  });
}

export function createHostRpcContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  return createRequestContextFixture({
    ...overrides,
    origin: "host-rpc",
    connectionId: overrides.connectionId ?? "test-rpc-connection",
  });
}

export function createHostStreamContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  return createRequestContextFixture({
    ...overrides,
    origin: "host-stream",
    connectionId: overrides.connectionId ?? "test-stream-connection",
  });
}

export function createRendererContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  return createRequestContextFixture({
    ...overrides,
    origin: "renderer",
    connectionId: undefined,
  });
}

export function createExtensionContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  return createRequestContextFixture({
    ...overrides,
    origin: "extension",
    connectionId: undefined,
  });
}
