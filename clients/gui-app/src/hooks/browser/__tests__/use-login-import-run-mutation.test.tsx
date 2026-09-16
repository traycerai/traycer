import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LoginImportRequest,
  LoginImportResult,
} from "@traycer-clients/shared/platform/browser-view";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { BROWSER_SAVED_LOGIN_SITES_METHOD } from "@/hooks/browser/use-browser-saved-login-sites-query";
import { useLoginImportRun } from "@/hooks/browser/use-login-import-run-mutation";
import { queryKeys } from "@/lib/query-keys";
import { STORE_KEYS, persistKey } from "@/lib/persist";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

const runtime = vi.hoisted(() => ({ hostId: "host-a" }));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => runtime.hostId,
}));

const REQUEST: LoginImportRequest = {
  sourceId: "source-1",
  scanId: "scan-1",
  domains: ["example.com"],
  includeDeviceBound: false,
};

const PERSIST_KEY = persistKey(STORE_KEYS.onboarding);

function makeWrapper(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function importedResult(importedCookies: number): LoginImportResult {
  return {
    status: "imported",
    importedSites: importedCookies > 0 ? 1 : 0,
    importedCookies,
    replacedSites: 0,
    skippedInvalid: 0,
    notifiedHosts: 1,
  };
}

describe("useLoginImportRun setup completion", () => {
  let queryClient: QueryClient;
  let browserView: FakeBrowserViewBridge;

  beforeEach(() => {
    runtime.hostId = "host-a";
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    browserView = new FakeBrowserViewBridge({});
    useOnboardingStore.setState({
      setupProgress: { agents: -1, appearance: -1, cookies: -1 },
      activeSetup: null,
      completedAt: null,
      step: 0,
    });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    window.localStorage.removeItem(PERSIST_KEY);
  });

  it("completes cookie setup only after at least one cookie was imported", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    vi.spyOn(browserView, "importLogins").mockResolvedValue(importedResult(2));
    const { result } = renderHook(() => useLoginImportRun(browserView), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(REQUEST);
    });

    expect(useOnboardingStore.getState().setupProgress.cookies).toBe(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.hostMethodScope(
        "host-a",
        BROWSER_SAVED_LOGIN_SITES_METHOD,
      ),
    });
  });

  it("keeps cookie setup incomplete when an imported result contains no cookies", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    vi.spyOn(browserView, "importLogins").mockResolvedValue(importedResult(0));
    const { result } = renderHook(() => useLoginImportRun(browserView), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(REQUEST);
    });

    expect(useOnboardingStore.getState().setupProgress.cookies).toBe(-1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.hostMethodScope(
        "host-a",
        BROWSER_SAVED_LOGIN_SITES_METHOD,
      ),
    });
  });

  it("keeps cookie setup incomplete after a partial or cancelled import", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const importLogins = vi.spyOn(browserView, "importLogins");
    importLogins
      .mockResolvedValueOnce({ status: "blocked", reason: "incomplete" })
      .mockResolvedValueOnce({ status: "cancelled" });
    const { result } = renderHook(() => useLoginImportRun(browserView), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(REQUEST);
    });
    expect(useOnboardingStore.getState().setupProgress.cookies).toBe(-1);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.mutateAsync(REQUEST);
    });

    expect(useOnboardingStore.getState().setupProgress.cookies).toBe(-1);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });
});
