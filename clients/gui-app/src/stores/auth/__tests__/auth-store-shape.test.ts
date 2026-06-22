import { describe, expect, it } from "vitest";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";

/**
 * Static / structural guard for the GUI auth store boundary contract.
 *
 * The Zustand auth store is part of the runtime UI surface host / shared
 * core consumers can subscribe to. Per the boundary contract, raw bearer
 * material is allowed only in the persisted token store, the
 * validation/refresh paths inside `AuthService`, the cross-window auth
 * projection bridge, and the final transport extraction. The public store
 * MUST therefore NOT carry a raw `token` field.
 *
 * If this test starts failing as a TypeScript error or a runtime regression,
 * a regression has reintroduced the raw bearer into the store - fix the
 * regression instead of relaxing this test.
 */

const forbiddenRawBearerStoreKeys = [
  "accessToken",
  "authToken",
  "bearer",
  "bearerToken",
  "rawBearer",
  "token",
] as const;

type Expect<T extends false> = T;

describe("auth-store boundary shape", () => {
  it("does NOT expose raw bearer fields on AuthState (compile-time guard)", () => {
    type Keys = keyof AuthState;
    type RawBearerKey = (typeof forbiddenRawBearerStoreKeys)[number];
    type HasRawBearerKey =
      Extract<Keys, RawBearerKey> extends never ? false : true;
    type _NoRawBearerKey = Expect<HasRawBearerKey>;
    const probe: _NoRawBearerKey = false;
    expect(probe).toBe(false);
  });

  it("setSignedIn takes only (profile, contextMetadata, shareableTeams) - never a raw bearer", () => {
    type SignedInArgs = Parameters<AuthState["setSignedIn"]>;
    type ExpectedArity = SignedInArgs["length"] extends 3 ? true : false;
    const arityOk: ExpectedArity = true;
    expect(arityOk).toBe(true);
  });

  it("the runtime store object has no `token` own property", () => {
    const snapshot = useAuthStore.getState();
    for (const key of forbiddenRawBearerStoreKeys) {
      expect(Object.prototype.hasOwnProperty.call(snapshot, key)).toBe(false);
    }
    expect(Object.keys(snapshot)).not.toEqual(
      expect.arrayContaining(Array.from(forbiddenRawBearerStoreKeys)),
    );
  });

  it("setSignedIn writes profile-only state and never persists a token field", () => {
    const initial = useAuthStore.getState();
    initial.setSignedOut();
    initial.setSignedIn(
      { userId: "guard-user", userName: "Guard", email: "guard@example.com" },
      { userId: "guard-user", username: "Guard" },
      [],
    );
    const after = useAuthStore.getState();
    expect(after.status).toBe("signed-in");
    expect(after.profile?.userId).toBe("guard-user");
    expect(after.contextMetadata?.userId).toBe("guard-user");
    expect(Object.keys(after)).not.toEqual(
      expect.arrayContaining(Array.from(forbiddenRawBearerStoreKeys)),
    );
    after.setSignedOut();
  });
});
