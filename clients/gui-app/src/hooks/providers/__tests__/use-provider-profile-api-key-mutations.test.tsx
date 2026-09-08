import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    getActiveHostId: vi.fn(() => "host-1"),
    request: vi.fn(),
  },
  useHostMutation: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.client,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => mocks.client,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: mocks.useHostMutation,
}));

// Only the singleton is stood in for - `AnalyticsEvent` stays real, so the
// assertions below name the same constant production does rather than a
// string that could drift away from it.
vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: { getInstance: () => ({ track: mocks.track }) },
  };
});

import { AnalyticsEvent } from "@/lib/analytics";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { providersMutationKeys } from "@/lib/query-keys";
import { PROFILE_API_KEY_MUTATION_SCOPE } from "@/hooks/providers/invalidations";
import { useClearProviderProfileApiKey } from "@/hooks/providers/use-clear-provider-profile-api-key-mutation";
import { useSetProviderProfileApiKey } from "@/hooks/providers/use-set-provider-profile-api-key-mutation";

interface CapturedMutation {
  readonly options: {
    readonly mutationKey: ReadonlyArray<unknown>;
    readonly scope: { readonly id: string } | undefined;
    readonly onSuccess: (
      data: unknown,
      variables: unknown,
      context: { readonly hostId: string | null },
    ) => void;
  };
}

function wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function captureLastMutation(): CapturedMutation {
  const call = mocks.useHostMutation.mock.calls.at(-1);
  if (call === undefined) throw new Error("useHostMutation was never called");
  return call[0] as CapturedMutation;
}

function renderAndSucceed(hook: () => unknown): CapturedMutation {
  mocks.useHostMutation.mockClear();
  mocks.track.mockClear();
  renderHook(hook, { wrapper });
  const captured = captureLastMutation();
  captured.options.onSuccess({}, {}, { hostId: "host-1" });
  return captured;
}

// `globals: false` here, so Testing Library's auto-cleanup never registers:
// an unmounted hook left over from the previous case would keep re-rendering
// into the `useHostMutation` call log this suite reads back.
afterEach(cleanup);

describe("per-profile API-key mutations", () => {
  it("reports a stored key as an api_key provider change", () => {
    // These hooks used to call `useHostMutation` directly, which bypasses
    // `useHostScopedMutation` - the only path that emits
    // `ProviderConfigurationChanged`. Every per-profile key change was
    // therefore missing from the metric that counts provider-wide ones, which
    // undercounts hardest for a provider whose key has NO provider-wide form
    // (Antigravity).
    //
    // FALSIFICATION: remove the `setProfileApiKey` entry from
    // `PROVIDER_MUTATION_OPERATIONS` and this reddens; route the hook back
    // through a bare `useHostMutation` and it reddens too.
    renderAndSucceed(useSetProviderProfileApiKey);

    expect(mocks.track).toHaveBeenCalledWith(
      AnalyticsEvent.ProviderConfigurationChanged,
      { operation: "api_key" },
    );
  });

  it("reports a removed key the same way", () => {
    // Same operation, not a second one: `api_key` answers "did this user
    // configure a key", and the provider-wide pair already reports set and
    // clear under one value.
    renderAndSucceed(useClearProviderProfileApiKey);

    expect(mocks.track).toHaveBeenCalledWith(
      AnalyticsEvent.ProviderConfigurationChanged,
      { operation: "api_key" },
    );
  });

  it("CONTROL: tracking is keyed by the mutation key, not by every success", () => {
    // Otherwise the two arms above would pass against a helper that reports
    // `api_key` for anything that succeeds through it. `startLogin` runs the
    // same helper and is deliberately absent from the operations map, so it
    // must stay silent while the two above speak.
    mocks.useHostMutation.mockClear();
    mocks.track.mockClear();
    renderHook(
      () =>
        useHostScopedMutation({
          method: "providers.startLogin",
          mutationKey: providersMutationKeys.startLogin(),
          errorMessage: "Couldn't start the login.",
          invalidateMethods: [],
        }),
      { wrapper },
    );
    captureLastMutation().options.onSuccess({}, {}, { hostId: "host-1" });

    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("puts both halves of the pair in ONE mutation scope", () => {
    // The scope is what makes a set and a clear arrive in the order they were
    // fired. `mode: "fifo"` in the host policy table cannot: the request
    // coordinator keys its queues by `[hostId, userId, method, params]`, so
    // two different methods never share one.
    //
    // FALSIFICATION: drop `scope` from either hook - or from
    // `useHostScopedMutation`'s options passthrough, which is where it now
    // travels - and the ids stop matching.
    mocks.useHostMutation.mockClear();
    renderHook(() => useSetProviderProfileApiKey(), { wrapper });
    const set = captureLastMutation();

    mocks.useHostMutation.mockClear();
    renderHook(() => useClearProviderProfileApiKey(), { wrapper });
    const clear = captureLastMutation();

    expect(set.options.scope?.id).toBe(PROFILE_API_KEY_MUTATION_SCOPE.id);
    expect(clear.options.scope?.id).toBe(PROFILE_API_KEY_MUTATION_SCOPE.id);
  });
});
