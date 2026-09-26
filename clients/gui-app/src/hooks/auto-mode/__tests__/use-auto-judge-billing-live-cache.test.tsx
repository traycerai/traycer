/**
 * `useAutoJudgeBilling` against REAL query machinery (a real `QueryClient`, a
 * real `HostClient` requester, a `MockHostMessenger`) rather than mocked host
 * hooks - `use-auto-judge-billing.test.tsx` mocks every host-data hook, which
 * proves the hook's own readiness GUARDS but cannot prove that a real
 * transition in the harness catalog (traycer's availability flipping) ever
 * reaches a fresh `autoJudge.get` read, or that a cold non-default host
 * actually fetches the judge harness's own model catalog.
 *
 * Mocks only `@/hooks/host/use-host-client-for-host-id` (returns the fixture's
 * requester), `@/hooks/host/use-host-supports-method` (negotiation reads
 * the hook needs to enable its queries at all) and `@/lib/host`'s
 * `useHostClient` (the app-wide client `useAutoJudgeSetMutation` saves through,
 * bound to the same requester). Every other hook the SUT calls
 * - `useHostQuery`, `useHostMutation`, `useProvidersListForClient`,
 * `useGuiHarnessesQueryForClient`, `useGuiHarnessModelsQueryForClient` - runs
 * for real against the mock host.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  GuiAgentModelOption,
  GuiHarnessId,
  GuiHarnessOption,
  ListGuiAgentModelsResponse,
} from "@traycer/protocol/host/index";
import type {
  AutoJudgeEffective,
  AutoJudgeGetResponse,
  AutoJudgeSetResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useAutoJudgeBilling } from "@/hooks/auto-mode/use-auto-judge-billing";
import { useAutoJudgeSetMutation } from "@/hooks/auto-mode/use-auto-judge-set-mutation";
import type { AutoJudgeBilling } from "@/lib/auto-mode/auto-judge-billing";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");
const CLAUDE_MODEL_SLUG = "claude-sonnet";
const TRAYCER_MODEL_SLUG = "traycer:judge-model";
const WAIT_TIMEOUT_MS = 2000;

// Mock only the two host-negotiation hooks the brief names; every other host
// hook the SUT calls runs for real against the mock messenger below.
const useHostClientForHostIdMock = vi.hoisted(() =>
  vi.fn<(hostId: string | null) => HostClient<HostRpcRegistry> | null>(
    () => null,
  ),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    useHostClientForHostIdMock(hostId),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
  useHostMethodSchemaVersion: (
    _hostId: string | null,
    method: string,
  ): { major: number; minor: number } | null => {
    if (method === "providers.list" || method === "agent.gui.listHarnesses") {
      return { major: 9, minor: 1 };
    }
    return null;
  },
}));

// `useAutoJudgeSetMutation` saves through the app-wide client, which would
// otherwise need a whole `<HostRuntimeProvider>`. It is the fixture's own
// requester here, so the save and the composer's read address one host and
// fold into one cache - the pair whose ordering E5 is about.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      const client = useHostClientForHostIdMock(null);
      if (client === null) throw new Error("no fixture host client yet");
      return client;
    },
  };
});

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

function harnessRow(args: {
  readonly id: GuiHarnessId;
  readonly label: string;
  readonly available: boolean;
  readonly availabilityPending: boolean;
  readonly nativeAutoJudge: boolean;
}): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: args.id,
    label: args.label,
    available: args.available,
    availabilityPending: args.availabilityPending,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    nativeAutoJudge: args.nativeAutoJudge,
    judgeDefaultModel: null,
  });
}

function modelRow(harnessId: GuiHarnessId, slug: string): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId,
    slug,
    label: slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    metadata: {},
  });
}

interface HoldGate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function holdGate(): HoldGate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const TRAYCER_BILLING: AutoJudgeBilling = {
  kind: "traycer",
  modelLabel: TRAYCER_MODEL_SLUG,
  effortLabel: null,
};

const PROVIDER_BILLING: AutoJudgeBilling = {
  kind: "provider",
  harnessId: CLAUDE_HARNESS_ID,
  harnessLabel: "Claude Code",
  modelLabel: CLAUDE_MODEL_SLUG,
  effortLabel: null,
};

/**
 * A fresh fixture per test: a real `QueryClient`, a real `HostClient`
 * requester pinned to a NON-local host entry (`mockRemoteHostEntry` - nothing
 * prefetched this host's cache, unlike the app-wide default host), and a
 * `MockHostMessenger` whose handlers read mutable test state. The
 * `autoJudge.get` handler can HOLD: while `armHold()` is active, every call
 * awaits a test-controlled promise, so a test can observe billing mid-refetch.
 * `autoJudge.set` holds the same way under `armSetHold()`.
 */
function createFixture() {
  const queryClient = createAppQueryClient();
  let requestSeq = 0;
  let traycerGreen = false;
  let claudeNativeAutoJudge = false;
  let claudeAutoJudge: "traycer" | "provider" | undefined = undefined;
  let hold: HoldGate | null = null;
  let setHold: HoldGate | null = null;
  const listModelsHarnessIds: GuiHarnessId[] = [];
  let autoJudgeGetCalls = 0;
  let autoJudgeSetCalls = 0;

  function armHold(): void {
    hold = holdGate();
  }
  function releaseHold(): void {
    hold?.release();
    hold = null;
  }
  function armSetHold(): void {
    setHold = holdGate();
  }
  function releaseSetHold(): void {
    setHold?.release();
    setHold = null;
  }
  // Automatic's verdict from the Traycer row as it stands NOW.
  function automaticEffective(): AutoJudgeEffective {
    return traycerGreen
      ? { source: "default", harnessId: "traycer", model: TRAYCER_MODEL_SLUG }
      : { source: "fallback" };
  }

  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestSeq += 1;
      return `req-${String(requestSeq)}`;
    },
    handlers: {
      "agent.gui.listHarnesses": () => ({
        harnesses: [
          harnessRow({
            id: CLAUDE_HARNESS_ID,
            label: "Claude Code",
            available: true,
            availabilityPending: false,
            nativeAutoJudge: claudeNativeAutoJudge,
          }),
          harnessRow({
            id: "traycer",
            label: "Traycer",
            available: traycerGreen,
            availabilityPending: !traycerGreen,
            nativeAutoJudge: false,
          }),
        ],
      }),
      "providers.list": () => ({
        providers: [
          providerState(
            claudeAutoJudge === undefined ? {} : { autoJudge: claudeAutoJudge },
          ),
        ],
        native: null,
      }),
      "agent.gui.listModels": (params) => {
        listModelsHarnessIds.push(params.harnessId);
        const slug =
          params.harnessId === "traycer"
            ? TRAYCER_MODEL_SLUG
            : CLAUDE_MODEL_SLUG;
        return {
          harnessId: params.harnessId,
          models: [modelRow(params.harnessId, slug)],
        };
      },
      // The verdict is decided when the request ARRIVES, the way the host's
      // getter reads the Traycer row before it awaits its model read - so a
      // held reply is an older verdict landing late, not a fresh one.
      "autoJudge.get": async () => {
        autoJudgeGetCalls += 1;
        const response: AutoJudgeGetResponse = {
          selection: null,
          effective: automaticEffective(),
          blocked: null,
        };
        if (hold !== null) await hold.promise;
        return response;
      },
      // The save echoes what it persisted plus a verdict derived the same way
      // and at the same moment as the host's (`autoJudge.set` persists, then
      // reads the Traycer row before awaiting its model read) - so a held
      // reply is a verdict from before anything that happens while it is
      // held.
      "autoJudge.set": async (params) => {
        autoJudgeSetCalls += 1;
        const response: AutoJudgeSetResponse = {
          selection: params.selection,
          effective: automaticEffective(),
          blocked: null,
        };
        if (setHold !== null) await setHold.promise;
        return response;
      },
    },
  });

  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockRemoteHostEntry);
  useHostClientForHostIdMock.mockImplementation(() => client);

  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );

  return {
    queryClient,
    Wrapper,
    hostId: mockRemoteHostEntry.hostId,
    listModelsRequestedFor: (harnessId: GuiHarnessId): boolean =>
      listModelsHarnessIds.includes(harnessId),
    autoJudgeGetCalls: (): number => autoJudgeGetCalls,
    autoJudgeSetCalls: (): number => autoJudgeSetCalls,
    harnessCatalogAnswered: (): boolean =>
      queryClient.getQueryData(
        hostQueryKeys.method(
          mockRemoteHostEntry.hostId,
          "agent.gui.listHarnesses",
          {},
        ),
      ) !== undefined,
    setTraycerGreen: (value: boolean) => {
      traycerGreen = value;
    },
    setClaudeNativeAutoJudge: (value: boolean) => {
      claudeNativeAutoJudge = value;
    },
    setClaudeAutoJudge: (value: "traycer" | "provider") => {
      claudeAutoJudge = value;
    },
    armHold,
    releaseHold,
    armSetHold,
    releaseSetHold,
  };
}

/**
 * Warms both model catalogs so a test about the VERDICT is not also waiting on
 * a model read (E3 covers the cold model read on its own).
 */
function prewarmModelCatalogs(fixture: {
  readonly queryClient: QueryClient;
  readonly hostId: string;
}): void {
  fixture.queryClient.setQueryData(
    hostQueryKeys.method(fixture.hostId, "agent.gui.listModels", {
      harnessId: CLAUDE_HARNESS_ID,
      workingDirectory: null,
    }),
    {
      harnessId: CLAUDE_HARNESS_ID,
      models: [modelRow(CLAUDE_HARNESS_ID, CLAUDE_MODEL_SLUG)],
    } satisfies ListGuiAgentModelsResponse,
  );
  fixture.queryClient.setQueryData(
    hostQueryKeys.method(fixture.hostId, "agent.gui.listModels", {
      harnessId: "traycer",
      workingDirectory: null,
    }),
    {
      harnessId: "traycer",
      models: [modelRow("traycer", TRAYCER_MODEL_SLUG)],
    } satisfies ListGuiAgentModelsResponse,
  );
}

afterEach(() => {
  cleanup();
});

describe("useAutoJudgeBilling against the real query cache", () => {
  it("E1: cold fallback transitions to the traycer default once the harness catalog reports it green", async () => {
    const fixture = createFixture();
    // Pre-warm BOTH model catalogs so this test is isolated from the cold-host
    // finding (E3) below - it is exercising the harness-catalog transition,
    // not the model-catalog fetch.
    fixture.queryClient.setQueryData(
      hostQueryKeys.method(fixture.hostId, "agent.gui.listModels", {
        harnessId: CLAUDE_HARNESS_ID,
        workingDirectory: null,
      }),
      {
        harnessId: CLAUDE_HARNESS_ID,
        models: [modelRow(CLAUDE_HARNESS_ID, CLAUDE_MODEL_SLUG)],
      } satisfies ListGuiAgentModelsResponse,
    );
    fixture.queryClient.setQueryData(
      hostQueryKeys.method(fixture.hostId, "agent.gui.listModels", {
        harnessId: "traycer",
        workingDirectory: null,
      }),
      {
        harnessId: "traycer",
        models: [modelRow("traycer", TRAYCER_MODEL_SLUG)],
      } satisfies ListGuiAgentModelsResponse,
    );

    const { result } = renderHook(
      () =>
        useAutoJudgeBilling(
          fixture.hostId,
          CLAUDE_HARNESS_ID,
          CLAUDE_MODEL_SLUG,
        ),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(
      () => {
        expect(result.current).toEqual({
          kind: "provider",
          harnessId: CLAUDE_HARNESS_ID,
          harnessLabel: "Claude Code",
          modelLabel: CLAUDE_MODEL_SLUG,
          effortLabel: null,
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    // Arm the hold BEFORE flipping state: the harness catalog's own condition
    // poll could otherwise refetch on its own timer and race this assertion.
    fixture.armHold();
    fixture.setTraycerGreen(true);
    await act(async () => {
      await fixture.queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(
          fixture.hostId,
          "agent.gui.listHarnesses",
        ),
      });
    });

    await waitFor(
      () => {
        expect(result.current).toBeNull();
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    fixture.releaseHold();

    await waitFor(
      () => {
        expect(result.current).toEqual({
          kind: "traycer",
          modelLabel: TRAYCER_MODEL_SLUG,
          effortLabel: null,
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });

  it("E2: cold default transitions back to the run's own provider once the harness catalog reports traycer unavailable", async () => {
    const fixture = createFixture();
    fixture.setTraycerGreen(true);
    fixture.queryClient.setQueryData(
      hostQueryKeys.method(fixture.hostId, "agent.gui.listModels", {
        harnessId: CLAUDE_HARNESS_ID,
        workingDirectory: null,
      }),
      {
        harnessId: CLAUDE_HARNESS_ID,
        models: [modelRow(CLAUDE_HARNESS_ID, CLAUDE_MODEL_SLUG)],
      } satisfies ListGuiAgentModelsResponse,
    );
    fixture.queryClient.setQueryData(
      hostQueryKeys.method(fixture.hostId, "agent.gui.listModels", {
        harnessId: "traycer",
        workingDirectory: null,
      }),
      {
        harnessId: "traycer",
        models: [modelRow("traycer", TRAYCER_MODEL_SLUG)],
      } satisfies ListGuiAgentModelsResponse,
    );

    const { result } = renderHook(
      () =>
        useAutoJudgeBilling(
          fixture.hostId,
          CLAUDE_HARNESS_ID,
          CLAUDE_MODEL_SLUG,
        ),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(
      () => {
        expect(result.current).toEqual({
          kind: "traycer",
          modelLabel: TRAYCER_MODEL_SLUG,
          effortLabel: null,
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    fixture.armHold();
    fixture.setTraycerGreen(false);
    await act(async () => {
      await fixture.queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(
          fixture.hostId,
          "agent.gui.listHarnesses",
        ),
      });
    });

    await waitFor(
      () => {
        expect(result.current).toBeNull();
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    fixture.releaseHold();

    await waitFor(
      () => {
        expect(result.current).toEqual({
          kind: "provider",
          harnessId: CLAUDE_HARNESS_ID,
          harnessLabel: "Claude Code",
          modelLabel: CLAUDE_MODEL_SLUG,
          effortLabel: null,
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });

  it("E3: a cold non-default host fetches the traycer judge's own model catalog and settles on the traycer default", async () => {
    const fixture = createFixture();
    fixture.setTraycerGreen(true);
    // Nothing pre-warmed: this host's cache starts empty.

    const { result } = renderHook(
      () =>
        useAutoJudgeBilling(
          fixture.hostId,
          CLAUDE_HARNESS_ID,
          CLAUDE_MODEL_SLUG,
        ),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(
      () => {
        expect(result.current).toEqual({
          kind: "traycer",
          modelLabel: TRAYCER_MODEL_SLUG,
          effortLabel: null,
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    expect(fixture.listModelsRequestedFor("traycer")).toBe(true);
  });

  it("E1b: a transition while the FIRST read is in flight re-asks the host and never renders the older fallback verdict", async () => {
    const fixture = createFixture();
    prewarmModelCatalogs(fixture);
    // The first read is held from the start, so it is still in flight when
    // the Traycer row changes: its captured `fallback` answer lands late.
    fixture.armHold();
    const seen: Array<AutoJudgeBilling | null> = [];
    renderHook(
      () => {
        const billing = useAutoJudgeBilling(
          fixture.hostId,
          CLAUDE_HARNESS_ID,
          CLAUDE_MODEL_SLUG,
        );
        seen.push(billing);
        return billing;
      },
      { wrapper: fixture.Wrapper },
    );
    await waitFor(
      () => {
        expect(fixture.harnessCatalogAnswered()).toBe(true);
        expect(fixture.autoJudgeGetCalls()).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    const callsBeforeTransition = fixture.autoJudgeGetCalls();
    fixture.setTraycerGreen(true);
    await act(async () => {
      await fixture.queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(
          fixture.hostId,
          "agent.gui.listHarnesses",
        ),
      });
    });
    // A NEW request, asked after the transition - not the held one reused.
    await waitFor(
      () => {
        expect(fixture.autoJudgeGetCalls()).toBeGreaterThan(
          callsBeforeTransition,
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    await act(async () => {
      fixture.releaseHold();
      await Promise.resolve();
    });
    await waitFor(
      () => {
        expect(seen.at(-1)).toEqual({
          kind: "traycer",
          modelLabel: TRAYCER_MODEL_SLUG,
          effortLabel: null,
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    expect(seen).not.toContainEqual({
      kind: "provider",
      harnessId: CLAUDE_HARNESS_ID,
      harnessLabel: "Claude Code",
      modelLabel: CLAUDE_MODEL_SLUG,
      effortLabel: null,
    });
  });

  it("E2b: the reverse transition while the FIRST read is in flight never renders the older Traycer verdict", async () => {
    const fixture = createFixture();
    fixture.setTraycerGreen(true);
    prewarmModelCatalogs(fixture);
    fixture.armHold();
    const seen: Array<AutoJudgeBilling | null> = [];
    renderHook(
      () => {
        const billing = useAutoJudgeBilling(
          fixture.hostId,
          CLAUDE_HARNESS_ID,
          CLAUDE_MODEL_SLUG,
        );
        seen.push(billing);
        return billing;
      },
      { wrapper: fixture.Wrapper },
    );
    await waitFor(
      () => {
        expect(fixture.harnessCatalogAnswered()).toBe(true);
        expect(fixture.autoJudgeGetCalls()).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    const callsBeforeTransition = fixture.autoJudgeGetCalls();
    fixture.setTraycerGreen(false);
    await act(async () => {
      await fixture.queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(
          fixture.hostId,
          "agent.gui.listHarnesses",
        ),
      });
    });
    await waitFor(
      () => {
        expect(fixture.autoJudgeGetCalls()).toBeGreaterThan(
          callsBeforeTransition,
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    await act(async () => {
      fixture.releaseHold();
      await Promise.resolve();
    });
    await waitFor(
      () => {
        expect(seen.at(-1)).toEqual({
          kind: "provider",
          harnessId: CLAUDE_HARNESS_ID,
          harnessLabel: "Claude Code",
          modelLabel: CLAUDE_MODEL_SLUG,
          effortLabel: null,
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    expect(seen).not.toContainEqual({
      kind: "traycer",
      modelLabel: TRAYCER_MODEL_SLUG,
      effortLabel: null,
    });
  });

  it("E5: a save reply held across a Traycer outage does not overwrite the refreshed fallback verdict, and the verdict is re-asked", async () => {
    const fixture = createFixture();
    fixture.setTraycerGreen(true);
    prewarmModelCatalogs(fixture);
    const seen: Array<AutoJudgeBilling | null> = [];
    const { result } = renderHook(
      () => {
        const billing = useAutoJudgeBilling(
          fixture.hostId,
          CLAUDE_HARNESS_ID,
          CLAUDE_MODEL_SLUG,
        );
        seen.push(billing);
        return { billing, save: useAutoJudgeSetMutation() };
      },
      { wrapper: fixture.Wrapper },
    );
    await waitFor(
      () => {
        expect(result.current.billing).toEqual(TRAYCER_BILLING);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    // Save Automatic while Traycer is green: the host derives `default` when
    // the save arrives, and that reply is held.
    fixture.armSetHold();
    act(() => {
      result.current.save.mutate({ selection: null });
    });
    await waitFor(
      () => {
        expect(fixture.autoJudgeSetCalls()).toBe(1);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    // Traycer goes red while the save is in flight, and the catalog's own
    // refresh settles the verdict on the fallback.
    fixture.setTraycerGreen(false);
    await act(async () => {
      await fixture.queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(
          fixture.hostId,
          "agent.gui.listHarnesses",
        ),
      });
    });
    await waitFor(
      () => {
        expect(result.current.billing).toEqual(PROVIDER_BILLING);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    // Now the older `default` echo lands.
    const getCallsBeforeRelease = fixture.autoJudgeGetCalls();
    const rendersBeforeRelease = seen.length;
    await act(async () => {
      fixture.releaseSetHold();
      await Promise.resolve();
    });
    await waitFor(
      () => {
        expect(result.current.save.isSuccess).toBe(true);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    // The verdict is re-asked after the save, rather than taken from its echo.
    await waitFor(
      () => {
        expect(fixture.autoJudgeGetCalls()).toBeGreaterThan(
          getCallsBeforeRelease,
        );
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    await waitFor(
      () => {
        expect(result.current.billing).toEqual(PROVIDER_BILLING);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    expect(seen.slice(rendersBeforeRelease)).not.toContainEqual(
      TRAYCER_BILLING,
    );
  });

  it("E4: a provider-native run never requests the traycer judge's model catalog", async () => {
    const fixture = createFixture();
    fixture.setTraycerGreen(true);
    fixture.setClaudeNativeAutoJudge(true);
    fixture.setClaudeAutoJudge("provider");

    const { result } = renderHook(
      () =>
        useAutoJudgeBilling(
          fixture.hostId,
          CLAUDE_HARNESS_ID,
          CLAUDE_MODEL_SLUG,
        ),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(
      () => {
        expect(result.current).toEqual({
          kind: "provider-native",
          harnessId: CLAUDE_HARNESS_ID,
          harnessLabel: "Claude Code",
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    expect(fixture.listModelsRequestedFor("traycer")).toBe(false);
  });
});
