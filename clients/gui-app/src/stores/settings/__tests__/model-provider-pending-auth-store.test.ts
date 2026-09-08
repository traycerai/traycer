import { beforeEach, describe, expect, it } from "vitest";
import {
  findModelProviderPendingAuth,
  useModelProviderPendingAuthStore,
  type ModelProviderPendingAuthEntry,
} from "@/stores/settings/model-provider-pending-auth-store";

type AttemptOverrides = Omit<Partial<ModelProviderPendingAuthEntry>, "key"> & {
  readonly key?: Partial<ModelProviderPendingAuthEntry["key"]>;
};

function attempt(overrides: AttemptOverrides): ModelProviderPendingAuthEntry {
  const { key: keyOverrides, ...rest } = overrides;
  return {
    key: {
      hostId: "host-a",
      providerId: "opencode",
      profileId: null,
      modelProviderId: "anthropic",
      ...keyOverrides,
    },
    attemptId: "attempt-1",
    startedAt: 1_000,
    authorizationUrl: "https://example.test/auth",
    method: "auto",
    instructions: null,
    ...rest,
  };
}

beforeEach(() => {
  useModelProviderPendingAuthStore.setState({ entries: {} });
});

describe("model provider pending-auth store", () => {
  it("keeps the same row on two hosts apart", () => {
    // The HOST keys its registry by (providerId, modelProviderId) because it
    // only ever speaks for itself. This store spans every host Settings can be
    // pointed at, so without `hostId` a sign-in started on host B would
    // overwrite host A's record - and A's panel would then resume against an
    // attemptId that names nothing on A.
    const store = useModelProviderPendingAuthStore.getState();
    store.upsert(attempt({ attemptId: "a-1" }));
    store.upsert(attempt({ key: { hostId: "host-b" }, attemptId: "b-1" }));

    const entries = useModelProviderPendingAuthStore.getState().entries;
    expect(Object.keys(entries)).toHaveLength(2);
    expect(
      findModelProviderPendingAuth(entries, {
        providerId: "opencode",
        hostId: "host-a",
        profileId: null,
      })?.attemptId,
    ).toBe("a-1");
    expect(
      findModelProviderPendingAuth(entries, {
        providerId: "opencode",
        hostId: "host-b",
        profileId: null,
      })?.attemptId,
    ).toBe("b-1");
  });

  it("resumes the NEWEST of two live attempts on one host", () => {
    // Single-flight is per (providerId, modelProviderId), so two different
    // upstream providers can each hold a live attempt at once. Returning "the
    // first row in the map" made which one resumed an accident of insertion
    // order.
    const store = useModelProviderPendingAuthStore.getState();
    store.upsert(attempt({ attemptId: "older", startedAt: 1_000 }));
    store.upsert(
      attempt({
        key: { modelProviderId: "openai" },
        attemptId: "newer",
        startedAt: 2_000,
      }),
    );
    const resumed = findModelProviderPendingAuth(
      useModelProviderPendingAuthStore.getState().entries,
      { providerId: "opencode", hostId: "host-a", profileId: null },
    );
    expect(resumed?.attemptId).toBe("newer");
    expect(resumed?.key.modelProviderId).toBe("openai");
  });

  it("matches the provider exactly, never just the host", () => {
    const store = useModelProviderPendingAuthStore.getState();
    store.upsert(attempt({ key: { providerId: "traycer" } }));
    expect(
      findModelProviderPendingAuth(
        useModelProviderPendingAuthStore.getState().entries,
        { providerId: "opencode", hostId: "host-a", profileId: null },
      ),
    ).toBeNull();
  });

  it("answers null for an unresolved host", () => {
    const store = useModelProviderPendingAuthStore.getState();
    store.upsert(attempt({}));
    expect(
      findModelProviderPendingAuth(
        useModelProviderPendingAuthStore.getState().entries,
        { providerId: "opencode", hostId: null, profileId: null },
      ),
    ).toBeNull();
  });

  it("does NOT let a late teardown delete a newer attempt's record", () => {
    // The concrete race: Stop waiting on attempt A, the form comes back, the
    // user starts attempt B for the same row - and only then does A's cancel
    // land. An unconditional remove would take B's only resume record with it,
    // leaving a host attempt holding a server lease that no surface can reach.
    const store = useModelProviderPendingAuthStore.getState();
    store.upsert(attempt({ attemptId: "a", startedAt: 1_000 }));
    store.upsert(attempt({ attemptId: "b", startedAt: 2_000 }));

    store.remove(
      {
        hostId: "host-a",
        providerId: "opencode",
        profileId: null,
        modelProviderId: "anthropic",
      },
      "a",
    );
    const stillThere = store.get({
      hostId: "host-a",
      providerId: "opencode",
      profileId: null,
      modelProviderId: "anthropic",
    });
    expect(stillThere?.attemptId).toBe("b");

    store.remove(
      {
        hostId: "host-a",
        providerId: "opencode",
        profileId: null,
        modelProviderId: "anthropic",
      },
      "b",
    );
    expect(
      store.get({
        hostId: "host-a",
        providerId: "opencode",
        profileId: null,
        modelProviderId: "anthropic",
      }),
    ).toBeNull();
  });

  // W3-T5: the host keys an attempt by (providerId, profileId, serverKey,
  // modelProviderId) - a managed profile leases its own server, so the same
  // upstream provider can hold independent live attempts under two different
  // profiles at once. The client key must carry `profileId` too, or a switch
  // would resume the wrong attempt under the right-looking key.
  it("keeps two profiles' attempts for one modelProviderId apart, and removes only the matching one", () => {
    const store = useModelProviderPendingAuthStore.getState();
    store.upsert(attempt({ key: { profileId: null }, attemptId: "default-1" }));
    store.upsert(
      attempt({ key: { profileId: "profile-a" }, attemptId: "profile-a-1" }),
    );

    const entries = useModelProviderPendingAuthStore.getState().entries;
    expect(Object.keys(entries)).toHaveLength(2);
    expect(
      findModelProviderPendingAuth(entries, {
        providerId: "opencode",
        hostId: "host-a",
        profileId: null,
      })?.attemptId,
    ).toBe("default-1");
    expect(
      findModelProviderPendingAuth(entries, {
        providerId: "opencode",
        hostId: "host-a",
        profileId: "profile-a",
      })?.attemptId,
    ).toBe("profile-a-1");

    // Removing the default account's attempt must not touch profile-a's.
    store.remove(
      {
        hostId: "host-a",
        providerId: "opencode",
        profileId: null,
        modelProviderId: "anthropic",
      },
      "default-1",
    );
    expect(
      store.get({
        hostId: "host-a",
        providerId: "opencode",
        profileId: null,
        modelProviderId: "anthropic",
      }),
    ).toBeNull();
    expect(
      store.get({
        hostId: "host-a",
        providerId: "opencode",
        profileId: "profile-a",
        modelProviderId: "anthropic",
      })?.attemptId,
    ).toBe("profile-a-1");
  });
});
