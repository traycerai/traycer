import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";

interface CapturedOptions {
  readonly invalidateMethods: readonly string[];
  readonly onSuccess: (
    data: unknown,
    variables: { readonly providerId: string },
    hostId: string | null,
  ) => void;
}

const captured = vi.hoisted((): { options: CapturedOptions | null } => ({
  options: null,
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutation: (options: CapturedOptions) => {
    captured.options = options;
    return {};
  },
}));

import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";

describe("useProvidersSetEnabled native invalidation", () => {
  afterEach(() => {
    cleanup();
    captured.options = null;
  });

  it("refreshes only the selected provider on the mutation host", async () => {
    const queryClient = new QueryClient();
    const hostAClassic = hostQueryKeys.method<
      HostRpcRegistry,
      "providers.list"
    >("host-a", "providers.list", { native: null });
    const hostANativeSelected = providersNativeQueryKeys.skillsList("host-a", {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
    });
    const hostANativeOther = providersNativeQueryKeys.skillsList("host-a", {
      providerId: "claude-code",
      scope: "global",
      workspaceRoot: null,
    });
    const hostBNativeSelected = providersNativeQueryKeys.skillsList("host-b", {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
    });
    const calls = new Map<string, number>();
    const observers: QueryObserver[] = [];

    const observe = (key: QueryKey, label: string): void => {
      const observer = new QueryObserver<unknown>(queryClient, {
        queryKey: key,
        queryFn: () => {
          calls.set(label, (calls.get(label) ?? 0) + 1);
          return Promise.resolve({ providers: [], native: null });
        },
        staleTime: Infinity,
        retry: false,
      });
      observer.subscribe(() => undefined);
      observers.push(observer);
    };

    observe(hostAClassic, "host-a-classic");
    observe(hostANativeSelected, "host-a-selected");
    observe(hostANativeOther, "host-a-other");
    observe(hostBNativeSelected, "host-b-selected");
    await Promise.all(observers.map((observer) => observer.refetch()));

    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    renderHook(() => useProvidersSetEnabled(), { wrapper: Wrapper });

    const options = captured.options;
    if (options === null) throw new Error("Expected mutation options.");
    expect(options.invalidateMethods).toEqual([
      "agent.gui.listHarnesses",
      "agent.tui.listHarnesses",
      "agent.selectionGuide.getGlobal",
      "agent.selectionGuide.getGlobalOnboardingDraft",
    ]);

    const before = new Map(calls);
    await act(async () => {
      options.onSuccess({}, { providerId: "codex" }, "host-a");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(calls.get("host-a-classic")).toBe(
        (before.get("host-a-classic") ?? 0) + 1,
      );
      expect(calls.get("host-a-selected")).toBe(
        (before.get("host-a-selected") ?? 0) + 1,
      );
    });
    expect(calls.get("host-a-other")).toBe(before.get("host-a-other"));
    expect(calls.get("host-b-selected")).toBe(before.get("host-b-selected"));

    for (const observer of observers) observer.destroy();
  });
});
