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
      })?.attemptId,
    ).toBe("a-1");
    expect(
      findModelProviderPendingAuth(entries, {
        providerId: "opencode",
        hostId: "host-b",
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
      { providerId: "opencode", hostId: "host-a" },
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
        { providerId: "opencode", hostId: "host-a" },
      ),
    ).toBeNull();
  });

  it("answers null for an unresolved host", () => {
    const store = useModelProviderPendingAuthStore.getState();
    store.upsert(attempt({}));
    expect(
      findModelProviderPendingAuth(
        useModelProviderPendingAuthStore.getState().entries,
        { providerId: "opencode", hostId: null },
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
        modelProviderId: "anthropic",
      },
      "a",
    );
    const stillThere = store.get({
      hostId: "host-a",
      providerId: "opencode",
      modelProviderId: "anthropic",
    });
    expect(stillThere?.attemptId).toBe("b");

    store.remove(
      {
        hostId: "host-a",
        providerId: "opencode",
        modelProviderId: "anthropic",
      },
      "b",
    );
    expect(
      store.get({
        hostId: "host-a",
        providerId: "opencode",
        modelProviderId: "anthropic",
      }),
    ).toBeNull();
  });
});
