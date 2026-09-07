import { describe, expect, it } from "vitest";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";


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
