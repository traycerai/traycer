import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";

/**
 * Captures the `options` object `useHostScopedMutationForClient` hands the
 * real `useHostMutation`. The mutation lifecycle (dispatch, host RPC, schema
 * validation) is not under test here - only whether the generic
 * `invalidateMethods` loop in `onSuccess` excludes immutable plugin-icon
 * cache entries, so calling `options.onSuccess` directly with a hand-built
 * context is the cheapest way to exercise it without a real host client.
 */
interface CapturedMutationOptions {
  readonly onSuccess: (
    data: unknown,
    variables: RequestOfMethod<HostRpcRegistry, "providers.setEnabled">,
    ctx: { readonly hostId: string | null; readonly captured: undefined },
  ) => void;
}

const mutationMocks = vi.hoisted(() => ({
  captured: [] as CapturedMutationOptions[],
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: { options: CapturedMutationOptions }) => {
    mutationMocks.captured.push(args.options);
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
  },
}));

function setup(): { readonly queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(
    () =>
      useHostScopedMutationForClient(null, {
        method: "providers.setEnabled",
        mutationKey: ["test-mutation"],
        errorMessage: "test error",
        invalidateMethods: ["providers.list"],
      }),
    { wrapper },
  );
  return { queryClient };
}

function fireSuccess(hostId: string, providerId: "claude-code"): void {
  const options = mutationMocks.captured.at(-1);
  if (options === undefined) throw new Error("useHostMutation was not invoked");
  options.onSuccess(
    undefined,
    { providerId, enabled: true, profileAction: null },
    { hostId, captured: undefined },
  );
}

function pluginIconKey(hostId: string, providerId: "claude-code") {
  return providersNativeQueryKeys.pluginIcon(hostId, {
    providerId,
    scope: "global",
    workspaceRoot: null,
    pluginId: "github@m",
    theme: "light",
    version: "1.0.0",
  });
}

describe("useHostScopedMutationForClient generic invalidation", () => {
  afterEach(() => {
    cleanup();
    mutationMocks.captured = [];
  });

  it("invalidates the classic providers.list scope but never an immutable plugin icon entry", async () => {
    const { queryClient } = setup();
    const classicKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      "host-A",
      "providers.list",
      { native: null },
    );
    const iconKey = pluginIconKey("host-A", "claude-code");
    queryClient.setQueryData(classicKey, { providers: [], native: null });
    queryClient.setQueryData(iconKey, { data: "icon-bytes" });

    fireSuccess("host-A", "claude-code");

    // The provider family's invalidation coalesces on a microtask.
    await waitFor(() => {
      expect(queryClient.getQueryState(classicKey)?.isInvalidated).toBe(true);
    });
    expect(queryClient.getQueryState(iconKey)?.isInvalidated).not.toBe(true);
  });

  it("does not invalidate another host's scope", async () => {
    const { queryClient } = setup();
    const otherHostKey = hostQueryKeys.method<
      HostRpcRegistry,
      "providers.list"
    >("host-B", "providers.list", { native: null });
    queryClient.setQueryData(otherHostKey, { providers: [], native: null });

    fireSuccess("host-A", "claude-code");
    // Let a would-be microtask invalidation land before asserting its absence.
    for (let hop = 0; hop < 20; hop += 1) await Promise.resolve();

    expect(queryClient.getQueryState(otherHostKey)?.isInvalidated).toBe(false);
  });
});
