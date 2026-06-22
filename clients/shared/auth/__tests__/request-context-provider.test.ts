/**
 * Tests for the client `RequestContextProvider` boundary contract.
 *
 * Pins the invariants documented in spec aca3ac84 §1.10 / §3.4 / §4
 * BEFORE GUI auth-store/runtime consumers are migrated:
 *
 *   1. Boundary mint helper preserves full `AuthenticatedUser` identity.
 *   2. Same-user refresh rotates the current context's credential lease
 *      and keeps the same context alive (no new emission, no userId
 *      change, abort signal stays unfired).
 *   3. Cross-user transition aborts/releases the previous context and
 *      emits the new (non-null) context.
 *   4. Sign-out aborts/releases the current context and emits null.
 *   5. Provider contract surface does NOT include raw-token APIs
 *      (`getToken()`, `onTokenChange(...)`); enforced via a static
 *      type-level assertion plus a runtime prototype scan.
 */
import { describe, expect, it } from "vitest";
import {
  CredentialLeaseReleasedError,
  IdentityMismatchError,
} from "@traycer/protocol/auth/request-context";
import {
  DefaultRequestContextProvider,
  mintRequestContextFromValidatedIdentity,
  type RequestContextProvider,
} from "../request-context-provider";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";

function createProvider(): DefaultRequestContextProvider {
  return new DefaultRequestContextProvider({ origin: "renderer" });
}

describe("mintRequestContextFromValidatedIdentity", () => {
  it("mints a context whose identity matches the supplied AuthenticatedUser", () => {
    const user = createAuthenticatedUserFixture({});
    const ctx = mintRequestContextFromValidatedIdentity({
      user,
      bearerToken: "bearer-1",
      origin: "renderer",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    expect(ctx.identity.userId).toBe(user.user.id);
    expect(ctx.identity.username).toBe(
      user.user.name ?? user.user.providerHandle,
    );
    expect(ctx.identity.providerHandle).toBe(user.user.providerHandle);
    expect(ctx.credentials.getBearerToken()).toBe("bearer-1");
    expect(ctx.origin).toBe("renderer");
  });
});

describe("DefaultRequestContextProvider - initial state", () => {
  it("starts with no current context", () => {
    const provider = createProvider();
    expect(provider.current()).toBeNull();
  });
});

describe("DefaultRequestContextProvider - sign-in transitions", () => {
  it("emits the new context to onChange listeners on first sign-in", () => {
    const provider = createProvider();
    const events: Array<RequestContext | null> = [];
    provider.onChange((ctx) => events.push(ctx));

    const user = createAuthenticatedUserFixture({});
    const ctx = provider.setSignedIn({
      user,
      bearerToken: "bearer-1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    expect(provider.current()).toBe(ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(ctx);
    expect(ctx.identity.userId).toBe(user.user.id);
  });

  it("aborts the previous context and emits the new one on cross-user sign-in", () => {
    const provider = createProvider();
    const userA = createAuthenticatedUserFixture({});
    (userA.user as { id: string }).id = "user-a";
    const userB = createAuthenticatedUserFixture({});
    (userB.user as { id: string }).id = "user-b";

    const ctxA = provider.setSignedIn({
      user: userA,
      bearerToken: "bearer-a",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    const events: Array<RequestContext | null> = [];
    provider.onChange((ctx) => events.push(ctx));

    expect(ctxA.isAborted).toBe(false);

    const ctxB = provider.setSignedIn({
      user: userB,
      bearerToken: "bearer-b",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    expect(ctxA.isAborted).toBe(true);
    expect(ctxA.abortSignal.reason).toBe("auth-identity-changed");
    expect(() => ctxA.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );

    expect(provider.current()).toBe(ctxB);
    expect(ctxB.identity.userId).toBe("user-b");
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(ctxB);
  });

  it("aborts the previous context and emits a fresh one even on same-user re-sign-in", () => {
    const provider = createProvider();
    const user = createAuthenticatedUserFixture({});

    const first = provider.setSignedIn({
      user,
      bearerToken: "bearer-1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });
    const events: Array<RequestContext | null> = [];
    provider.onChange((ctx) => events.push(ctx));

    const second = provider.setSignedIn({
      user,
      bearerToken: "bearer-2",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    expect(first.isAborted).toBe(true);
    expect(first.abortSignal.reason).toBe("auth-resigned-in");
    expect(second).not.toBe(first);
    expect(second.identity.userId).toBe(user.user.id);
    expect(second.credentials.getBearerToken()).toBe("bearer-2");
    expect(events).toEqual([second]);
  });
});

describe("DefaultRequestContextProvider - same-user credential rotation", () => {
  it("rotates the bearer in place without changing the live context reference", () => {
    const provider = createProvider();
    const user = createAuthenticatedUserFixture({});
    const ctx = provider.setSignedIn({
      user,
      bearerToken: "bearer-v1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    const events: Array<RequestContext | null> = [];
    provider.onChange((next) => events.push(next));

    provider.rotateCurrentBearer({
      userId: user.user.id,
      bearerToken: "bearer-v2",
    });

    expect(provider.current()).toBe(ctx);
    expect(ctx.credentials.getBearerToken()).toBe("bearer-v2");
    expect(ctx.isAborted).toBe(false);
    expect(events).toEqual([]);
    expect(ctx.identity.userId).toBe(user.user.id);
  });

  it("supports repeated rotations on the same context", () => {
    const provider = createProvider();
    const user = createAuthenticatedUserFixture({});
    const ctx = provider.setSignedIn({
      user,
      bearerToken: "bearer-v1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    provider.rotateCurrentBearer({
      userId: user.user.id,
      bearerToken: "bearer-v2",
    });
    provider.rotateCurrentBearer({
      userId: user.user.id,
      bearerToken: "bearer-v3",
    });

    expect(provider.current()).toBe(ctx);
    expect(ctx.credentials.getBearerToken()).toBe("bearer-v3");
  });

  it("rejects rotation when supplied userId differs from the live identity", () => {
    const provider = createProvider();
    const user = createAuthenticatedUserFixture({});
    const ctx = provider.setSignedIn({
      user,
      bearerToken: "bearer-v1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    expect(() =>
      provider.rotateCurrentBearer({
        userId: "other-user",
        bearerToken: "stolen",
      }),
    ).toThrow(IdentityMismatchError);

    expect(ctx.credentials.getBearerToken()).toBe("bearer-v1");
    expect(ctx.identity.userId).toBe(user.user.id);
  });

  it("throws when rotateCurrentBearer is called with no current context", () => {
    const provider = createProvider();

    expect(() =>
      provider.rotateCurrentBearer({
        userId: "u",
        bearerToken: "bearer",
      }),
    ).toThrow(/no current request context/);
  });
});

describe("DefaultRequestContextProvider - sign-out", () => {
  it("aborts the current context and emits null on signOut", () => {
    const provider = createProvider();
    const user = createAuthenticatedUserFixture({});
    const ctx = provider.setSignedIn({
      user,
      bearerToken: "bearer",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    const events: Array<RequestContext | null> = [];
    provider.onChange((next) => events.push(next));

    provider.signOut();

    expect(provider.current()).toBeNull();
    expect(ctx.isAborted).toBe(true);
    expect(ctx.abortSignal.reason).toBe("auth-signed-out");
    expect(() => ctx.credentials.getBearerToken()).toThrow(
      CredentialLeaseReleasedError,
    );
    expect(events).toEqual([null]);
  });

  it("is idempotent when already signed out", () => {
    const provider = createProvider();
    const events: Array<RequestContext | null> = [];
    provider.onChange((next) => events.push(next));

    provider.signOut();
    provider.signOut();

    expect(provider.current()).toBeNull();
    expect(events).toEqual([]);
  });

  it("a signed-in -> signed-out -> signed-in sequence emits exactly the transitions", () => {
    const provider = createProvider();
    const events: Array<RequestContext | null> = [];
    provider.onChange((next) => events.push(next));

    const user = createAuthenticatedUserFixture({});
    const first = provider.setSignedIn({
      user,
      bearerToken: "b1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });
    provider.signOut();
    const second = provider.setSignedIn({
      user,
      bearerToken: "b2",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    expect(events).toEqual([first, null, second]);
    expect(first.isAborted).toBe(true);
    expect(second.isAborted).toBe(false);
  });
});

describe("DefaultRequestContextProvider - listener management", () => {
  it("returns a disposer that unsubscribes the listener", () => {
    const provider = createProvider();
    const events: Array<RequestContext | null> = [];
    const dispose = provider.onChange((ctx) => events.push(ctx));

    const user = createAuthenticatedUserFixture({});
    provider.setSignedIn({
      user,
      bearerToken: "b1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });
    expect(events).toHaveLength(1);

    dispose();
    provider.signOut();
    expect(events).toHaveLength(1);
  });

  it("invoking the disposer twice is safe", () => {
    const provider = createProvider();
    const dispose = provider.onChange(() => {});
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  it("dispose() aborts the current context and silences future onChange registrations", () => {
    const provider = createProvider();
    const user = createAuthenticatedUserFixture({});
    const ctx = provider.setSignedIn({
      user,
      bearerToken: "b1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });

    provider.dispose();

    expect(ctx.isAborted).toBe(true);
    expect(provider.current()).toBeNull();

    let called = false;
    const dispose = provider.onChange(() => {
      called = true;
    });
    expect(called).toBe(false);
    dispose();
  });
});

describe("RequestContextProvider - provider contract is raw-token-free (static guard)", () => {
  type ForbiddenRawTokenKeys =
    | "getToken"
    | "getBearerToken"
    | "onTokenChange"
    | "setAuthToken"
    | "revalidateCurrentToken";

  type AssertNoForbidden<T> =
    Extract<keyof T, ForbiddenRawTokenKeys> extends never ? true : never;

  it("does not surface getToken()/onTokenChange/setAuthToken via its TypeScript contract", () => {
    const _typeGuard: AssertNoForbidden<RequestContextProvider> = true;
    expect(_typeGuard).toBe(true);
  });

  it("does not expose raw-token methods on the runtime instance either", () => {
    const provider: RequestContextProvider = createProvider();
    const proto = Object.getPrototypeOf(provider) as object;
    const ownNames = Object.getOwnPropertyNames(proto);
    const forbidden = [
      "getToken",
      "getBearerToken",
      "onTokenChange",
      "setAuthToken",
      "revalidateCurrentToken",
    ];
    for (const name of forbidden) {
      expect(
        ownNames.includes(name),
        `RequestContextProvider must not expose ${name}`,
      ).toBe(false);
    }

    const instanceKeys = Object.keys(provider as object);
    for (const name of forbidden) {
      expect(instanceKeys.includes(name)).toBe(false);
    }
  });

  it("exposes only context-oriented members on the public contract", () => {
    const expected: ReadonlyArray<keyof RequestContextProvider> = [
      "current",
      "onChange",
    ];
    type Equals<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    const _exact: Equals<
      keyof RequestContextProvider,
      (typeof expected)[number]
    > = true;
    expect(_exact).toBe(true);
  });
});
