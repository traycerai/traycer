import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { AutoJudgeGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
  type AgentReasoningEffortOption,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useAutoJudgeBilling } from "@/hooks/auto-mode/use-auto-judge-billing";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");

const useAddressableHostIdMock = vi.hoisted(() =>
  vi.fn((): string | null => "app-wide-host-should-never-be-read"),
);
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => useAddressableHostIdMock(),
}));

type FakeClient = { readonly requestedHostId: string | null };

const useHostClientForHostIdMock = vi.hoisted(() =>
  vi.fn((hostId: string | null): FakeClient => ({ requestedHostId: hostId })),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    useHostClientForHostIdMock(hostId),
}));

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
const providersListVersion = vi.hoisted(() => ({
  current: { major: 9, minor: 1 } as { major: number; minor: number } | null,
}));
const listHarnessesVersion = vi.hoisted(() => ({
  current: { major: 9, minor: 1 } as { major: number; minor: number } | null,
}));
// `null` (unset) unless a test negotiates a line explicitly - every case that
// does not name one keeps today's behaviour: `autoJudgeGetKnowsReasoningEffort`
// reads `null` as "not knowable" and every billing answer's `effortLabel`
// stays `null`.
const judgeGetVersion = vi.hoisted(() => ({
  current: null as { major: number; minor: number } | null,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) =>
    useHostSupportsMethodMock(hostId, method),
  useHostMethodSchemaVersion: (_hostId: string | null, method: string) => {
    if (method === "providers.list") return providersListVersion.current;
    if (method === "agent.gui.listHarnesses")
      return listHarnessesVersion.current;
    if (method === "autoJudge.get") return judgeGetVersion.current;
    return null;
  },
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
    ) => {
      data: { providers: ProviderCliState[] } | undefined;
      isSuccess: boolean;
      isError: boolean;
    }
  >(),
);
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: (
    client: FakeClient | null,
    activity: { readonly enabled: boolean; readonly subscribed: boolean },
  ) => useProvidersListForClientMock(client, activity),
}));

let harnessesData: { harnesses: GuiHarnessOption[] } | undefined;
let harnessesSettled = true;
const useGuiHarnessesQueryForClientMock = vi.hoisted(() =>
  vi.fn<
    (
      client: FakeClient | null,
      activity: { readonly enabled: boolean; readonly subscribed: boolean },
    ) => {
      data: { harnesses: GuiHarnessOption[] } | undefined;
      isSuccess: boolean;
      isError: boolean;
    }
  >(),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: (
    client: FakeClient | null,
    activity: { readonly enabled: boolean; readonly subscribed: boolean },
  ) => useGuiHarnessesQueryForClientMock(client, activity),
  useGuiHarnessModelsQueryForClient: () => judgeModelsQueryMock(),
}));

/** The model every stored-judge fixture below names, unless it says otherwise. */
const JUDGE_MODEL_SLUG = "claude-sonnet";

function judgeModelRow(
  slug: string,
  resolvedModel: string | null,
): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId: CLAUDE_HARNESS_ID,
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    metadata: resolvedModel === null ? {} : { resolvedModel },
  });
}

/** A judge model row that advertises reasoning efforts, for the effort tests. */
function judgeModelRowWithEfforts(
  slug: string,
  efforts: ReadonlyArray<string>,
): GuiAgentModelOption {
  const supportedReasoningEfforts: ReadonlyArray<AgentReasoningEffortOption> =
    efforts.map((id) => ({ id, label: id, description: null }));
  return guiAgentModelOptionSchema.parse({
    harnessId: CLAUDE_HARNESS_ID,
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts,
    metadata: {},
  });
}

interface JudgeModelsQueryResult {
  readonly data:
    | { readonly models: ReadonlyArray<GuiAgentModelOption> }
    | undefined;
  readonly isSuccess: boolean;
}

function judgeModelsAnswered(
  models: ReadonlyArray<GuiAgentModelOption>,
): JudgeModelsQueryResult {
  return { data: { models }, isSuccess: true };
}

const judgeModelsQueryMock = vi.fn<() => JudgeModelsQueryResult>(() =>
  judgeModelsAnswered([judgeModelRow(JUDGE_MODEL_SLUG, null)]),
);

function harnessRow(
  nativeAutoJudge: boolean,
  judgeDefaultModel: string | null,
): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: CLAUDE_HARNESS_ID,
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    nativeAutoJudge,
    judgeDefaultModel,
  });
}

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

function providerProfile(profileId: string): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: profileId,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  providersListVersion.current = { major: 9, minor: 1 };
  listHarnessesVersion.current = { major: 9, minor: 1 };
  judgeGetVersion.current = null;
  useHostSupportsMethodMock.mockImplementation(() => true);
  autoJudgeGetData = undefined;
  providersListData = undefined;
  harnessesData = { harnesses: [harnessRow(true, null)] };
  harnessesSettled = true;
  useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
    data: harnessesData,
    isSuccess: harnessesSettled,
    isError: false,
  }));
  useHostQueryMock.mockImplementation(() => ({ data: autoJudgeGetData }));
  useProvidersListForClientMock.mockImplementation(() => ({
    data: providersListData,
    isSuccess: true,
    isError: false,
  }));
  judgeModelsQueryMock.mockReturnValue(
    judgeModelsAnswered([judgeModelRow(JUDGE_MODEL_SLUG, null)]),
  );
});

useHostQueryMock.mockImplementation(() => ({ data: autoJudgeGetData }));
useProvidersListForClientMock.mockImplementation(() => ({
  data: providersListData,
  isSuccess: true,
  isError: false,
}));
harnessesData = { harnesses: [harnessRow(true, null)] };
useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
  data: harnessesData,
  isSuccess: harnessesSettled,
  isError: false,
}));

describe("useAutoJudgeBilling", () => {
  it("never reads the app-wide host via useAddressableHostId - that dependency is banned inside a tab", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""));

    expect(useAddressableHostIdMock).not.toHaveBeenCalled();
  });

  it("asks the capability gate about the CLIENT's own host, not some other host", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""));

    expect(useHostSupportsMethodMock).toHaveBeenCalledWith(
      "host-b",
      "autoJudge.get",
    );
    const askedHosts = useHostSupportsMethodMock.mock.calls.map(
      (call) => call[0],
    );
    expect(askedHosts).not.toContain("app-wide-host-should-never-be-read");
  });

  it("names the FOLLOWING client's own host for a null target, never the app-wide selection", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [] };

    renderHook(() => useAutoJudgeBilling(null, CLAUDE_HARNESS_ID, ""));

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
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toBeNull();
  });

  it("resolves to provider-native when the run harness's provider reviews its own commands, whatever the target names", () => {
    autoJudgeGetData = { selection: null };
    providersListData = {
      providers: [providerState({ autoJudge: "provider" })],
    };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toEqual({
      kind: "provider-native",
      harnessId: CLAUDE_HARNESS_ID,
      harnessLabel: "Claude Code",
    });
  });

  it("falls back to the traycer reading (with its model label) when the provider override says 'provider' but the catalog row is not capable", () => {
    autoJudgeGetData = {
      selection: null,
      effective: {
        harnessId: "traycer",
        model: JUDGE_MODEL_SLUG,
        source: "default",
      },
    };
    providersListData = {
      providers: [providerState({ autoJudge: "provider" })],
    };
    harnessesData = { harnesses: [harnessRow(false, null)] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toEqual({
      kind: "traycer",
      modelLabel: JUDGE_MODEL_SLUG,
      effortLabel: null,
    });
  });

  it("resolves to blocked when autoJudge.get reports a selection together with a blocker", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        reasoningEffort: null,
      },
      blocked: { reason: "provider-disabled" },
    };
    providersListData = { providers: [] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toEqual({ kind: "blocked" });
  });

  it("resolves to blocked when effective is explicitly null, whatever blocked says", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        reasoningEffort: null,
      },
      effective: null,
      blocked: undefined,
    };
    providersListData = { providers: [] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toEqual({ kind: "blocked" });
  });

  it("resolves to blocked when the stored judge names a profile the provider no longer offers", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: "removed-profile",
        reasoningEffort: null,
      },
    };
    providersListData = {
      providers: [
        providerState({ profiles: [providerProfile("kept-profile")] }),
      ],
    };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toEqual({ kind: "blocked" });
  });

  it("still bills the provider account (with its model label) when the stored judge's profile is still offered", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: "kept-profile",
        reasoningEffort: null,
      },
    };
    providersListData = {
      providers: [
        providerState({ profiles: [providerProfile("kept-profile")] }),
      ],
    };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toEqual({
      kind: "provider",
      harnessId: "claude",
      harnessLabel: "Claude Code",
      modelLabel: "claude-sonnet",
      effortLabel: null,
    });
  });

  it("resolves to blocked when the stored judge names a model its harness no longer lists", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "gone-model",
        profileId: null,
        reasoningEffort: null,
      },
    };
    providersListData = {
      providers: [providerState({})],
    };
    judgeModelsQueryMock.mockReturnValue(
      judgeModelsAnswered([judgeModelRow("kept-model", null)]),
    );

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toEqual({ kind: "blocked" });
  });

  it("still bills the provider account when the stored judge's model is still offered", () => {
    autoJudgeGetData = {
      selection: {
        harnessId: "claude",
        model: "kept-model",
        profileId: null,
        reasoningEffort: null,
      },
    };
    providersListData = {
      providers: [providerState({})],
    };
    judgeModelsQueryMock.mockReturnValue(
      judgeModelsAnswered([judgeModelRow("kept-model", null)]),
    );

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toEqual({
      kind: "provider",
      harnessId: "claude",
      harnessLabel: "Claude Code",
      modelLabel: "kept-model",
      effortLabel: null,
    });
  });

  describe("waits for providers.list to settle before publishing billing copy", () => {
    // A CONCRETE effective default judge, so the readiness guard is the only
    // thing standing between an unsettled read and a real billing verdict -
    // the old fixture (`{ selection: null }` with no `effective`) resolves to
    // an 'unknown' target regardless of these guards, so removing a guard
    // could never have reddened it.
    const EFFECTIVE_DEFAULT_JUDGE: AutoJudgeGetResponse = {
      selection: null,
      effective: {
        source: "default",
        harnessId: "traycer",
        model: JUDGE_MODEL_SLUG,
      },
      blocked: null,
    };

    it("returns null while autoJudge.get has data but providers.list is still in flight, then publishes billing once providers.list settles", () => {
      autoJudgeGetData = EFFECTIVE_DEFAULT_JUDGE;
      useProvidersListForClientMock.mockImplementation(() => ({
        data: undefined,
        isSuccess: false,
        isError: false,
      }));

      const { result, rerender } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toBeNull();

      useProvidersListForClientMock.mockImplementation(() => ({
        data: { providers: [providerState({})] },
        isSuccess: true,
        isError: false,
      }));
      rerender();

      expect(result.current).toEqual({
        kind: "traycer",
        modelLabel: JUDGE_MODEL_SLUG,
        effortLabel: null,
      });
    });

    it("resolves to provider-native once the providers read succeeds with a provider-native row", () => {
      autoJudgeGetData = { selection: null };
      useProvidersListForClientMock.mockImplementation(() => ({
        data: { providers: [providerState({ autoJudge: "provider" })] },
        isSuccess: true,
        isError: false,
      }));

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({
        kind: "provider-native",
        harnessId: CLAUDE_HARNESS_ID,
        harnessLabel: "Claude Code",
      });
    });

    it("keeps the disclosure hidden when the providers read fails, then publishes billing once providers.list succeeds", () => {
      autoJudgeGetData = EFFECTIVE_DEFAULT_JUDGE;
      useProvidersListForClientMock.mockImplementation(() => ({
        data: undefined,
        isSuccess: false,
        isError: true,
      }));

      const { result, rerender } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toBeNull();

      useProvidersListForClientMock.mockImplementation(() => ({
        data: { providers: [providerState({})] },
        isSuccess: true,
        isError: false,
      }));
      rerender();

      expect(result.current).toEqual({
        kind: "traycer",
        modelLabel: JUDGE_MODEL_SLUG,
        effortLabel: null,
      });
    });
  });

  describe("waits for the harness catalog to settle before publishing billing copy", () => {
    const EFFECTIVE_DEFAULT_JUDGE: AutoJudgeGetResponse = {
      selection: null,
      effective: {
        source: "default",
        harnessId: "traycer",
        model: JUDGE_MODEL_SLUG,
      },
      blocked: null,
    };

    it("returns null while autoJudge.get has data but the harness catalog is still in flight, then publishes billing once the harness catalog settles", () => {
      autoJudgeGetData = EFFECTIVE_DEFAULT_JUDGE;
      providersListData = { providers: [providerState({})] };
      harnessesData = undefined;
      harnessesSettled = false;
      useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
        data: undefined,
        isSuccess: false,
        isError: false,
      }));

      const { result, rerender } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toBeNull();

      useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
        data: { harnesses: [harnessRow(true, null)] },
        isSuccess: true,
        isError: false,
      }));
      rerender();

      expect(result.current).toEqual({
        kind: "traycer",
        modelLabel: JUDGE_MODEL_SLUG,
        effortLabel: null,
      });
    });

    it("keeps the disclosure hidden when the harness-catalog read fails, even though autoJudge.get and providers.list both succeeded, then publishes billing once the harness catalog settles", () => {
      autoJudgeGetData = EFFECTIVE_DEFAULT_JUDGE;
      providersListData = { providers: [providerState({})] };
      harnessesData = undefined;
      harnessesSettled = false;
      useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
        data: undefined,
        isSuccess: false,
        isError: true,
      }));

      const { result, rerender } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toBeNull();

      useGuiHarnessesQueryForClientMock.mockImplementation(() => ({
        data: { harnesses: [harnessRow(true, null)] },
        isSuccess: true,
        isError: false,
      }));
      rerender();

      expect(result.current).toEqual({
        kind: "traycer",
        modelLabel: JUDGE_MODEL_SLUG,
        effortLabel: null,
      });
    });
  });

  // Kept for compatibility: a pre-1.1 host answers with no `effective` key at
  // all. `autoJudgeTarget` reads that as 'unknown' (there is no stored
  // selection either), so this stays null however settled the other two
  // reads are - unrelated to the readiness guards above, which is exactly why
  // it must not be the ONLY case exercising them.
  it("returns null for a pre-1.1 host answer with no effective key, even though providers.list and the harness catalog are both settled", () => {
    autoJudgeGetData = { selection: null };
    providersListData = { providers: [providerState({})] };

    const { result } = renderHook(() =>
      useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
    );

    expect(result.current).toBeNull();
  });

  describe("the writable-but-unreadable provider judge (providers.list stuck at 9.0)", () => {
    it("returns null when the harness has a native judge but providers.list cannot report it", () => {
      autoJudgeGetData = { selection: null };
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(true, null)] };
      providersListVersion.current = { major: 9, minor: 0 };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toBeNull();
    });

    it("is unaffected by the same stuck providers.list when the harness has no native judge", () => {
      autoJudgeGetData = {
        selection: null,
        effective: {
          harnessId: "traycer",
          model: JUDGE_MODEL_SLUG,
          source: "default",
        },
      };
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(false, null)] };
      providersListVersion.current = { major: 9, minor: 0 };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({
        kind: "traycer",
        modelLabel: JUDGE_MODEL_SLUG,
        effortLabel: null,
      });
    });
  });

  describe("resolves the provider-native path from the catalog alone, without autoJudge.get", () => {
    it("resolves provider-native when autoJudge.get is unsupported but the negotiated listHarnesses line proves Auto mode", () => {
      useHostSupportsMethodMock.mockImplementation(() => false);
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(true, null)] };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({
        kind: "provider-native",
        harnessId: CLAUDE_HARNESS_ID,
        harnessLabel: "Claude Code",
      });
      expect(useProvidersListForClientMock).toHaveBeenCalledWith(
        expect.anything(),
        { enabled: true, subscribed: true },
      );
      expect(useGuiHarnessesQueryForClientMock).toHaveBeenCalledWith(
        expect.anything(),
        { enabled: true, subscribed: true },
      );
    });

    it("still answers null for a non-native harness when autoJudge.get is unsupported", () => {
      useHostSupportsMethodMock.mockImplementation(() => false);
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(false, null)] };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toBeNull();
      expect(useProvidersListForClientMock).toHaveBeenCalledWith(
        expect.anything(),
        { enabled: true, subscribed: true },
      );
    });
  });

  describe("waits for the judge harness's model catalog to settle before publishing billing copy", () => {
    it("returns null for a stored judge while the judge model read is unsettled", () => {
      autoJudgeGetData = {
        selection: {
          harnessId: "claude",
          model: "claude-sonnet",
          profileId: null,
          reasoningEffort: null,
        },
      };
      providersListData = { providers: [] };
      judgeModelsQueryMock.mockReturnValue({
        data: undefined,
        isSuccess: false,
      });

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toBeNull();
    });

    it("publishes billing for a stored judge once the judge model read succeeds listing the stored model", () => {
      autoJudgeGetData = {
        selection: {
          harnessId: "claude",
          model: "claude-sonnet",
          profileId: null,
          reasoningEffort: null,
        },
      };
      providersListData = { providers: [] };
      judgeModelsQueryMock.mockReturnValue(
        judgeModelsAnswered([judgeModelRow(JUDGE_MODEL_SLUG, null)]),
      );

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({
        kind: "provider",
        harnessId: "claude",
        harnessLabel: "Claude Code",
        modelLabel: JUDGE_MODEL_SLUG,
        effortLabel: null,
      });
    });

    it("still publishes provider-native when the judge model read is unsettled", () => {
      autoJudgeGetData = {
        selection: {
          harnessId: "claude",
          model: "claude-sonnet",
          profileId: null,
          reasoningEffort: null,
        },
      };
      providersListData = {
        providers: [providerState({ autoJudge: "provider" })],
      };
      harnessesData = { harnesses: [harnessRow(true, null)] };
      judgeModelsQueryMock.mockReturnValue({
        data: undefined,
        isSuccess: false,
      });

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({
        kind: "provider-native",
        harnessId: CLAUDE_HARNESS_ID,
        harnessLabel: "Claude Code",
      });
    });

    it("still publishes billing with no stored selection, resolved against the default judge's own model catalog", () => {
      autoJudgeGetData = {
        selection: null,
        effective: {
          harnessId: "traycer",
          model: JUDGE_MODEL_SLUG,
          source: "default",
        },
      };
      providersListData = { providers: [] };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({
        kind: "traycer",
        modelLabel: JUDGE_MODEL_SLUG,
        effortLabel: null,
      });
    });
  });

  describe("an unrecognized judge harness does not consult a stand-in catalog", () => {
    it("does not report the judge unrunnable for an unrecognized harness, even though the traycer catalog omits its model", () => {
      autoJudgeGetData = {
        selection: {
          harnessId: "some-future-harness",
          model: "some-future-model",
          profileId: null,
          reasoningEffort: null,
        },
      };
      providersListData = { providers: [] };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({
        kind: "provider",
        harnessId: "some-future-harness",
        harnessLabel: "some-future-harness",
        modelLabel: "some-future-model",
        effortLabel: null,
      });
    });

    it("does report the judge unrunnable when a recognized harness's own catalog omits the stored model", () => {
      autoJudgeGetData = {
        selection: {
          harnessId: "claude",
          model: "some-future-model",
          profileId: null,
          reasoningEffort: null,
        },
      };
      providersListData = { providers: [] };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({ kind: "blocked" });
    });
  });

  // The `source: "fallback"` arm: Automatic falls back to the RUN harness's
  // own model, not to Traycer. Which model it names depends on whether that
  // harness's catalog row advertises its own `judgeDefaultModel`.
  describe("effective.source === 'fallback' names the run harness's own model", () => {
    it("names the run harness's judgeDefaultModel when its catalog row has one", () => {
      autoJudgeGetData = {
        selection: null,
        effective: { source: "fallback" },
      };
      providersListData = { providers: [] };
      harnessesData = {
        harnesses: [harnessRow(false, "claude-fallback-default")],
      };
      judgeModelsQueryMock.mockReturnValue(
        judgeModelsAnswered([judgeModelRow("claude-fallback-default", null)]),
      );

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, "composer-model"),
      );

      expect(result.current).toEqual({
        kind: "provider",
        harnessId: CLAUDE_HARNESS_ID,
        harnessLabel: "Claude Code",
        modelLabel: "claude-fallback-default",
        effortLabel: null,
      });
    });

    it("falls back to the composer's own selected model when the run harness names no judge default", () => {
      autoJudgeGetData = {
        selection: null,
        effective: { source: "fallback" },
      };
      providersListData = { providers: [] };
      harnessesData = { harnesses: [harnessRow(false, null)] };
      judgeModelsQueryMock.mockReturnValue(
        judgeModelsAnswered([judgeModelRow("composer-model", null)]),
      );

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, "composer-model"),
      );

      expect(result.current).toEqual({
        kind: "provider",
        harnessId: CLAUDE_HARNESS_ID,
        harnessLabel: "Claude Code",
        modelLabel: "composer-model",
        effortLabel: null,
      });
    });

    it("returns null under fallback when there is no run harness to name", () => {
      autoJudgeGetData = {
        selection: null,
        effective: { source: "fallback" },
      };
      providersListData = { providers: [] };

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", null, "composer-model"),
      );

      expect(result.current).toBeNull();
    });
  });

  // The billing's `effortLabel` rides the NEGOTIATED `autoJudge.get` line, not
  // merely the model's own catalog: `autoJudgeGetKnowsReasoningEffort` gates
  // it off below `1.3`, so the same catalog and selection must answer
  // differently depending only on which line the host negotiated.
  describe("effortLabel rides the negotiated autoJudge.get line", () => {
    it("carries the model's lowest advertised effort label when the negotiated line is 1.3 and the selection names no effort", () => {
      judgeGetVersion.current = { major: 1, minor: 3 };
      autoJudgeGetData = {
        selection: {
          harnessId: CLAUDE_HARNESS_ID,
          model: JUDGE_MODEL_SLUG,
          profileId: null,
          reasoningEffort: null,
        },
      };
      providersListData = { providers: [] };
      judgeModelsQueryMock.mockReturnValue(
        judgeModelsAnswered([
          judgeModelRowWithEfforts(JUDGE_MODEL_SLUG, ["high", "low"]),
        ]),
      );

      const { result } = renderHook(() =>
        useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
      );

      expect(result.current).toEqual({
        kind: "provider",
        harnessId: CLAUDE_HARNESS_ID,
        harnessLabel: "Claude Code",
        modelLabel: JUDGE_MODEL_SLUG,
        effortLabel: "low",
      });
    });

    it.each([
      { major: 1, minor: 1 },
      // 1.2 is the last-pick line: that host runs the model's own default.
      { major: 1, minor: 2 },
    ])(
      "carries no effort label when the negotiated line is %o, even though the model advertises efforts",
      (line) => {
        judgeGetVersion.current = line;
        autoJudgeGetData = {
          selection: {
            harnessId: CLAUDE_HARNESS_ID,
            model: JUDGE_MODEL_SLUG,
            profileId: null,
            reasoningEffort: null,
          },
        };
        providersListData = { providers: [] };
        judgeModelsQueryMock.mockReturnValue(
          judgeModelsAnswered([
            judgeModelRowWithEfforts(JUDGE_MODEL_SLUG, ["high", "low"]),
          ]),
        );

        const { result } = renderHook(() =>
          useAutoJudgeBilling("host-b", CLAUDE_HARNESS_ID, ""),
        );

        expect(result.current).toEqual({
          kind: "provider",
          harnessId: CLAUDE_HARNESS_ID,
          harnessLabel: "Claude Code",
          modelLabel: JUDGE_MODEL_SLUG,
          effortLabel: null,
        });
      },
    );
  });
});
