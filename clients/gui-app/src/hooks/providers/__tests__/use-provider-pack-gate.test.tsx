import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";

const testState = vi.hoisted(() => ({
  providers: undefined as ReadonlyArray<ProviderCliState> | undefined,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: providersResponse() }),
  useProvidersListForClient: () => ({ data: providersResponse() }),
}));

function providersResponse() {
  return testState.providers === undefined
    ? undefined
    : { providers: testState.providers };
}

import { useProviderPackGate } from "@/hooks/providers/use-provider-pack-gate";

function providerState(
  providerId: ProviderCliState["providerId"],
  managedInstallState: ProviderManagedInstallState | null,
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
    managedInstallState,
    versionVisibility: null,
    advisory: null,
  };
}

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  testState.providers = undefined;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("useProviderPackGate", () => {
  // The gate is UX; the host resolver is the authoritative backstop and refuses
  // independently. So an unknown answer must never block - a gate that failed
  // CLOSED here would lock the composer for the entire first `providers.list`
  // round trip on every app start.
  it("does not block while providers.list has not loaded", () => {
    const { result } = renderHook(() => useProviderPackGate("claude"), {
      wrapper,
    });
    expect(result.current.blocked).toBe(false);
    expect(result.current.hint).toBeNull();
  });

  it("does not block a harness with no selection", () => {
    testState.providers = [
      providerState("claude-code", { status: "downloading", percent: 10 }),
    ];
    const { result } = renderHook(() => useProviderPackGate(null), { wrapper });
    expect(result.current.blocked).toBe(false);
  });

  it("blocks the selected harness while its pack downloads, with a percent hint", () => {
    testState.providers = [
      providerState("claude-code", { status: "downloading", percent: 42 }),
    ];
    const { result } = renderHook(() => useProviderPackGate("claude"), {
      wrapper,
    });
    expect(result.current.blocked).toBe(true);
    expect(result.current.hint).toBe("Preparing Claude Code… 42%");
    expect(result.current.preparing?.kind).toBe("downloading");
  });

  it("blocks with a percent-less hint when a live sibling owns the download", () => {
    testState.providers = [
      providerState("claude-code", { status: "downloading", percent: null }),
    ];
    const { result } = renderHook(() => useProviderPackGate("claude"), {
      wrapper,
    });
    expect(result.current.blocked).toBe(true);
    // Never "0%" - the download is moving, this host just cannot see how far.
    expect(result.current.hint).toBe("Preparing Claude Code…");
  });

  it("blocks on a failed pack and names the reason", () => {
    testState.providers = [
      providerState("claude-code", {
        status: "error",
        reason: "disk-full",
        message: "ENOSPC",
        retryAtMs: 1_700_000_000_000,
      }),
    ];
    const { result } = renderHook(() => useProviderPackGate("claude"), {
      wrapper,
    });
    expect(result.current.blocked).toBe(true);
    expect(result.current.hint).toContain("disk space");
    expect(result.current.preparing?.retryAtMs).toBe(1_700_000_000_000);
  });

  it.each([
    ["installed", { status: "installed" as const }],
    ["absent (pre-cutover, still bundled)", { status: "absent" as const }],
    ["null (old host / unmanaged store)", null],
  ])("does not block on %s", (_label, managedInstallState) => {
    testState.providers = [providerState("claude-code", managedInstallState)];
    const { result } = renderHook(() => useProviderPackGate("claude"), {
      wrapper,
    });
    expect(result.current.blocked).toBe(false);
  });

  // Cross-provider isolation: one provider mid-download must not gate another.
  // On a first boot the host converges every enabled provider at once, so this
  // is the common case, not an edge one.
  it("gates only the harness whose own pack is preparing", () => {
    testState.providers = [
      providerState("claude-code", { status: "downloading", percent: 5 }),
      providerState("codex", { status: "installed" }),
    ];
    const { result: claude } = renderHook(
      () => useProviderPackGate("claude"),
      { wrapper },
    );
    const { result: codex } = renderHook(() => useProviderPackGate("codex"), {
      wrapper,
    });
    expect(claude.current.blocked).toBe(true);
    expect(codex.current.blocked).toBe(false);
  });
});
