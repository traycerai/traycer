import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useAuthStore,
  type AuthState,
  type TerminalCloudVerdictLoss,
} from "@/stores/auth/auth-store";

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

// ── E10: cloudVerdictLoss ─────────────────────────────────────────────────
//
// Why an `unverified` session holds no cloud verdict, so the share-refusal
// toast can pick copy the host itself cannot know.
describe("auth-store: cloudVerdictLoss", () => {
  it("defaults to unreachable, the network fact rather than a rejected credential", () => {
    // A fresh store (module init, before AuthService ever runs) has not yet
    // latched a credential rejection, so the safe default is the transient,
    // self-clearing cause.
    expect(useAuthStore.getState().cloudVerdictLoss).toBe("unreachable");
  });

  it("setCloudVerdictLoss writes the field and nothing else", () => {
    const before = useAuthStore.getState();
    try {
      before.setCloudVerdictLoss("session-rejected");
      expect(useAuthStore.getState().cloudVerdictLoss).toBe("session-rejected");

      before.setCloudVerdictLoss("account-unavailable");
      expect(useAuthStore.getState().cloudVerdictLoss).toBe(
        "account-unavailable",
      );

      before.setCloudVerdictLoss("unreachable");
      expect(useAuthStore.getState().cloudVerdictLoss).toBe("unreachable");
    } finally {
      before.setCloudVerdictLoss("unreachable");
    }
  });
});

// ── hostRefusedHeldBearer ─────────────────────────────────────────────────
//
// A host refused the bearer an `unverified` session holds AFTER authn refused
// the session. The rule for when that is recorded lives in the store so every
// transport that sees a refusal can report it without restating it; these
// tests pin the rule and the five status reducers that retire the fact.
describe("auth-store: hostRefusedHeldBearer", () => {
  const profile = {
    userId: "refused-user",
    userName: "Refused",
    email: "refused@example.com",
  } as const;
  const contextMetadata = {
    userId: "refused-user",
    username: "Refused",
  } as const;
  const terminalLosses: ReadonlyArray<TerminalCloudVerdictLoss> = [
    "session-rejected",
    "account-unavailable",
    "ended-elsewhere",
  ];

  function resetStore(): void {
    useAuthStore.getState().setSignedOut();
    useAuthStore.getState().setCloudVerdictLoss("unreachable");
  }

  /** `unverified` on a refused cloud verdict, host refusal NOT yet recorded. */
  function holdRefusedSession(loss: TerminalCloudVerdictLoss): void {
    const state = useAuthStore.getState();
    state.setUnverifiedSession(profile, contextMetadata);
    state.setCloudVerdictLoss(loss);
  }

  beforeEach(resetStore);
  afterEach(resetStore);

  it("defaults to false", () => {
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it("records nothing when the session is signed-in, even with a refused verdict latched", () => {
    const state = useAuthStore.getState();
    state.setSignedIn(profile, contextMetadata, []);
    // A latched loss under `signed-in` is a stale value the status guard must
    // ignore: the rule keys on the STATUS, not on the loss alone.
    state.setCloudVerdictLoss("session-rejected");

    state.noteHostRefusedHeldBearer();

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it("records nothing when the session is signed-out", () => {
    const state = useAuthStore.getState();
    state.setSignedOut();
    state.setCloudVerdictLoss("session-rejected");

    state.noteHostRefusedHeldBearer();

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it("records nothing while a sign-in is in flight", () => {
    const state = useAuthStore.getState();
    state.setSigningIn("device");
    state.setCloudVerdictLoss("session-rejected");

    state.noteHostRefusedHeldBearer();

    expect(useAuthStore.getState().status).toBe("signing-in");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it("records nothing for an unverified session whose authn was merely unreachable", () => {
    const state = useAuthStore.getState();
    state.setUnverifiedSession(profile, contextMetadata);
    expect(useAuthStore.getState().cloudVerdictLoss).toBe("unreachable");

    state.noteHostRefusedHeldBearer();

    expect(useAuthStore.getState().status).toBe("unverified");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  for (const loss of terminalLosses) {
    it(`records the refusal for an unverified session whose cloud verdict was lost as ${loss}`, () => {
      holdRefusedSession(loss);
      expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

      useAuthStore.getState().noteHostRefusedHeldBearer();

      const after = useAuthStore.getState();
      expect(after.hostRefusedHeldBearer).toBe(true);
      // The status stays `unverified`: the identity is kept and nothing
      // account-scoped is purged. Only the shell's admission changes.
      expect(after.status).toBe("unverified");
      expect(after.cloudVerdictLoss).toBe(loss);
      expect(after.profile?.userId).toBe("refused-user");
      expect(after.contextMetadata?.userId).toBe("refused-user");
    });
  }

  it("does not notify subscribers when it records nothing", () => {
    // The stream revalidator reports every reconnect refusal, so a no-op that
    // still produced a new state would re-render every subscriber each time.
    useAuthStore.getState().setUnverifiedSession(profile, contextMetadata);
    let notifications = 0;
    const unsubscribe = useAuthStore.subscribe(() => {
      notifications += 1;
    });
    try {
      useAuthStore.getState().noteHostRefusedHeldBearer();
      expect(notifications).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  const resettingReducers: ReadonlyArray<{
    readonly name: string;
    readonly apply: (state: AuthState) => void;
  }> = [
    {
      name: "setSigningIn",
      apply: (state) => {
        state.setSigningIn("device");
      },
    },
    {
      name: "setSignedIn",
      apply: (state) => {
        state.setSignedIn(profile, contextMetadata, []);
      },
    },
    {
      name: "setUnverifiedSession",
      apply: (state) => {
        state.setUnverifiedSession(profile, contextMetadata);
      },
    },
    {
      name: "setSignedOut",
      apply: (state) => {
        state.setSignedOut();
      },
    },
    {
      name: "setInteractiveAttemptFailed",
      apply: (state) => {
        state.setInteractiveAttemptFailed();
      },
    },
  ];

  for (const reducer of resettingReducers) {
    it(`${reducer.name} retires the recorded refusal`, () => {
      holdRefusedSession("session-rejected");
      useAuthStore.getState().noteHostRefusedHeldBearer();
      // Guard against a vacuous reset: the flag really was set going in.
      expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);

      reducer.apply(useAuthStore.getState());

      expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
    });
  }
});
