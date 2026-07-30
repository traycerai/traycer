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
  // The activity options the client-scoped gate asked its query for. Captured
  // rather than asserted through behaviour because the whole point of the
  // `active` parameter is that it changes NOTHING about the gate's answer -
  // only whether a subscription is held - so a behavioural assertion could not
  // tell the two wirings apart.
  lastClientActivity: null as {
    enabled: boolean;
    subscribed: boolean;
  } | null,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: providersResponse() }),
  useProvidersListForClient: (
    _client: unknown,
    activity: { enabled: boolean; subscribed: boolean },
  ) => {
    testState.lastClientActivity = activity;
    return { data: providersResponse() };
  },
}));

function providersResponse() {
  return testState.providers === undefined
    ? undefined
    : { providers: testState.providers };
}

import {
  useProviderPackGate,
  useProviderPackGateForClient,
} from "@/hooks/providers/use-provider-pack-gate";

// `candidates: []` is the load-bearing default here: no bundled binary, no
// PATH install, nothing to fall back to. Every "blocks" assertion below depends
// on it, because the gate's question is "can this provider run", not "is a
// download in flight" - see `runnableProviderState` for the other half.
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

// The same provider with a runnable binary on disk. Which KIND does not matter
// to the gate (bundled, PATH and custom all resolve), so this uses the bundled
// one - the pre-cutover shape every host in the field is in today.
function runnableProviderState(
  providerId: ProviderCliState["providerId"],
  managedInstallState: ProviderManagedInstallState | null,
): ProviderCliState {
  return {
    ...providerState(providerId, managedInstallState),
    candidates: [
      {
        kind: "bundled",
        path: "/opt/traycer/bin/claude",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
    ],
  };
}

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
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

  // The regression this gate was rewritten for. Boot convergence enqueues EVERY
  // enabled pack, so `downloading 0%` is the ordinary first-boot state of every
  // provider on the machine - while their bundled binaries sit right there,
  // runnable. Gating on the pack alone dimmed the whole picker and took away
  // the only send button that would have promoted a pack up the install queue.
  it("does not block a download standing behind a runnable binary", () => {
    testState.providers = [
      runnableProviderState("claude-code", {
        status: "downloading",
        percent: 0,
      }),
    ];
    const { result } = renderHook(() => useProviderPackGate("claude"), {
      wrapper,
    });
    expect(result.current.blocked).toBe(false);
    // No hint either: every consumer feeds this into a DISABLED-state tooltip,
    // so a non-null hint here would explain why a live button is dead.
    expect(result.current.hint).toBeNull();
    // ...but the state is still reported, so a surface that wants to show
    // background install progress has it.
    expect(result.current.preparing?.kind).toBe("downloading");
  });

  it("does not block a failed pack standing behind a runnable binary", () => {
    // A managed copy hitting ENOSPC does not stop the user's existing binary
    // from working, and the host would resolve it without complaint.
    testState.providers = [
      runnableProviderState("claude-code", {
        status: "error",
        reason: "disk-full",
        message: "ENOSPC",
        retryAtMs: null,
      }),
    ];
    const { result } = renderHook(() => useProviderPackGate("claude"), {
      wrapper,
    });
    expect(result.current.blocked).toBe(false);
    expect(result.current.hint).toBeNull();
  });

  // Cross-provider isolation: one provider mid-download must not gate another.
  // On a first boot the host converges every enabled provider at once, so this
  // is the common case, not an edge one.
  it("gates only the harness whose own pack is preparing", () => {
    testState.providers = [
      providerState("claude-code", { status: "downloading", percent: 5 }),
      providerState("codex", { status: "installed" }),
    ];
    const { result: claude } = renderHook(() => useProviderPackGate("claude"), {
      wrapper,
    });
    const { result: codex } = renderHook(() => useProviderPackGate("codex"), {
      wrapper,
    });
    expect(claude.current.blocked).toBe(true);
    expect(codex.current.blocked).toBe(false);
  });
});

describe("useProviderPackGateForClient", () => {
  beforeEach(() => {
    testState.lastClientActivity = null;
  });

  // Only the focused top-level surface owns its catalog subscriptions - the
  // rule the chat composer already applies to the reauth gate and the
  // rate-limit prompt beside this one. An unfocused split partner renders its
  // body but cannot send, so a live `providers.list` stream there is a
  // per-host cost with no reader.
  it("holds the providers.list subscription only while active", () => {
    testState.providers = [providerState("claude-code", null)];
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useProviderPackGateForClient(null, "claude", active),
      { wrapper, initialProps: { active: true } },
    );
    expect(testState.lastClientActivity).toEqual({
      enabled: true,
      subscribed: true,
    });
    rerender({ active: false });
    expect(testState.lastClientActivity).toEqual({
      enabled: false,
      subscribed: false,
    });
  });

  // Dropping the subscription must not turn into a gate that blocks. An
  // unfocused tile reading a cache no query is refreshing lands on the same
  // fail-open the loading state does, and the host resolver's typed
  // `preparing` outcome stays the authoritative backstop either way.
  it("still answers from cached providers while inactive", () => {
    testState.providers = [
      providerState("claude-code", { status: "downloading", percent: 5 }),
    ];
    const { result } = renderHook(
      () => useProviderPackGateForClient(null, "claude", false),
      { wrapper },
    );
    expect(result.current.blocked).toBe(true);
  });
});
