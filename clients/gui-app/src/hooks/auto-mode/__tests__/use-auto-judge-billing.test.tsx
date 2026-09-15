import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import type { AutoJudgeGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useAutoJudgeBilling } from "@/hooks/auto-mode/use-auto-judge-billing";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");

/**
 * The banned app-wide hook. Its own doc says a tab must never call it
 * (root AGENTS.md: "Tabs bind a `hostId` for life… Never use
 * `useAddressableHostId()` inside a tab"), and this hook is mounted by the
 * chat tab's composer toolbar - so the spy below is not a restatement of
 * production logic, it asserts a dependency this hook must never reach for
 * again. It used to fall back to exactly this hook for the `null`-target
 * case.
 */
const useAddressableHostIdMock = vi.hoisted(() =>
  vi.fn((): string | null => "app-wide-host-should-never-be-read"),
);
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => useAddressableHostIdMock(),
}));

/**
 * A client is opaque here - only its identity matters, since
 * `useReactiveHostReadiness` below is the one thing that turns it back into a
 * host id. Carrying the requested `hostId` on the object is what lets the
 * readiness mock answer truthfully without a real `HostClient`.
 */
type FakeClient = { readonly requestedHostId: string | null };

const useHostClientForHostIdMock = vi.hoisted(() =>
  vi.fn((hostId: string | null): FakeClient => ({ requestedHostId: hostId })),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    useHostClientForHostIdMock(hostId),
}));

/**
 * The FOLLOWING client's own host, modelled the way the real one behaves: a
 * client resolved for `null` is the app's following requester, and asking IT
 * which host it addresses answers a concrete id rather than `null`. That is
 * the whole substitution this hook made - the name used to come from
 * `useAddressableHostId()`, which reads the app-wide SELECTION, and now comes
 * from the client the query is already running on.
 */
const FOLLOWING_HOST_ID = "following-host";

const useReactiveHostReadinessMock = vi.hoisted(() =>
  vi.fn((client: FakeClient | null) => ({
    hostId:
      client === null ? null : (client.requestedHostId ?? FOLLOWING_HOST_ID),
    requestContextUserId: null,
    isReady: client !== null,
    hasRpcEndpoint: client !== null,
    canExecute: client !== null,
  })),
);
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: FakeClient | null) =>
    useReactiveHostReadinessMock(client),
}));

const useHostSupportsMethodMock = vi.hoisted(() =>
  vi.fn((_hostId: string | null, _method: string): boolean => true),
);
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) =>
    useHostSupportsMethodMock(hostId, method),
}));

let autoJudgeGetData: AutoJudgeGetResponse | undefined;
const useHostQueryMock = vi.hoisted(() =>
  vi.fn<() => { data: AutoJudgeGetResponse | undefined }>(),
);
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => useHostQueryMock(),
}));

let providersListData: { providers: ProviderCliState[] } | undefined;
const useProvidersListForClientMock = vi.hoisted(() =>
  vi.fn<
    (
      client: FakeClient | null,
      activity: { readonly enabled: boolean; readonly subscribed: boolean },
    ) => { data: { providers: ProviderCliState[] } | undefined }
  >(),
);
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: (
    client: FakeClient | null,
    activity: { readonly enabled: boolean; readonly subscribed: boolean },
  ) => useProvidersListForClientMock(client, activity),
}));

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  autoJudgeGetData = undefined;
  providersListData = undefined;
  useHostQueryMock.mockImplementation(() => ({ data: autoJudgeGetData }));
  useProvidersListForClientMock.mockImplementation(() => ({
    data: providersListData,
  }));
});

useHostQueryMock.mockImplementation(() => ({ data: autoJudgeGetData }));
useProvidersListForClientMock.mockImplementation(() => ({
  data: providersListData,
}));

describe("useAutoJudgeBilling", () => {
  it("never reads the app-wide host via useAddressableHostId - that dependency is banned inside a tab", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID));

    expect(useAddressableHostIdMock).not.toHaveBeenCalled();
  });

  it("asks the capability gate about the CLIENT's own host, not some other host", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID));

    // The client was resolved for "host-b", and the gate must be asked about
    // exactly that id - never the id `useHostClientForHostId` was CALLED
    // with in isolation, and never a second, independently-read host name.
    // This is the assertion that would have caught the two-sources defect:
    // before the fix, the gate could be asked about the app-wide selection
    // while the query still ran on this client.
    expect(useHostSupportsMethodMock).toHaveBeenCalledWith(
      "host-b",
      "autoJudge.get",
    );
    const askedHosts = useHostSupportsMethodMock.mock.calls.map(
      (call) => call[0],
    );
    expect(askedHosts).not.toContain("app-wide-host-should-never-be-read");
  });

  // The branch that actually changed, and the only one where the fallback's
  // VALUE is observable. The two cases above pass a concrete `host-b`, which
  // short-circuits the fallback entirely - they would pass against the old code
  // too, on the gate assertion alone. With a `null` target the old code asked
  // the gate about `useAddressableHostId()`'s answer (the app-wide selection);
  // the new code asks the client this hook already resolved. So this is the
  // positive half of the ban: not "the banned hook wasn't called", but "the
  // right host was named instead".
  it("names the FOLLOWING client's own host for a null target, never the app-wide selection", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling(null, CLAUDE_HARNESS_ID));

    expect(useHostSupportsMethodMock).toHaveBeenCalledWith(
      FOLLOWING_HOST_ID,
      "autoJudge.get",
    );
    const askedHosts = useHostSupportsMethodMock.mock.calls.map(
      (call) => call[0],
    );
    expect(askedHosts).not.toContain("app-wide-host-should-never-be-read");
  });

  it("returns null before the record has loaded", () => {
    autoJudgeGetData = undefined;
    providersListData = { providers: [] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toBeNull();
  });

  // The end-to-end shape of the JOB 3 defect: the host-wide selection is
  // Traycer's judge (unset, which `autoJudgeBillingFor` folds into
  // "traycer"), but the RUN harness's own provider row says it reviews its
  // own commands - so the composer must disclose "provider-native", not
  // "Uses your Traycer credits." for a call that will never be made.
  it("resolves to provider-native when the host-wide selection is Traycer but the run harness's provider reviews its own commands", () => {
    autoJudgeGetData = { selection: null };
    providersListData = {
      providers: [providerState({ autoJudge: "provider" })],
    };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({
      kind: "provider-native",
      harnessId: CLAUDE_HARNESS_ID,
      harnessLabel: "Claude Code",
    });
  });

  // JOB 3, end-to-end: `autoJudge.get` reports both a stored selection AND a
  // blocker on it. The hook must fold that into `{ kind: "blocked" }` rather
  // than billing the stored (but unrunnable) provider selection - the same
  // precedence `autoJudgeBillingForRun` encodes, exercised through the real
  // read path this composer surface actually uses.
  it("resolves to blocked when autoJudge.get reports a selection together with a blocker", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
      },
      blocked: { reason: "provider-disabled" },
    };
    providersListData = { providers: [] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID),
    );

    expect(result.current).toEqual({ kind: "blocked" });
  });
});
