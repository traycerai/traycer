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
 * requester) and `@/hooks/host/use-host-supports-method` (negotiation reads
 * the hook needs to enable its queries at all). Every other hook the SUT calls
 * - `useHostQuery`, `useProvidersListForClient`,
 * `useGuiHarnessesQueryForClient`, `useGuiHarnessModelsQueryForClient` - runs
 * for real against the mock host.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
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
import type { AutoJudgeGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useAutoJudgeBilling } from "@/hooks/auto-mode/use-auto-judge-billing";

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

/**
 * A fresh fixture per test: a real `QueryClient`, a real `HostClient`
 * requester pinned to a NON-local host entry (`mockRemoteHostEntry` - nothing
 * prefetched this host's cache, unlike the app-wide default host), and a
 * `MockHostMessenger` whose four handlers read mutable test state. The
 * `autoJudge.get` handler can HOLD: while `armHold()` is active, every call
 * awaits a test-controlled promise, so a test can observe billing mid-refetch.
 */
function createFixture() {
  const queryClient = createAppQueryClient();
  let requestSeq = 0;
  let traycerGreen = false;
  let claudeNativeAutoJudge = false;
  let claudeAutoJudge: "traycer" | "provider" | undefined = undefined;
  let hold: HoldGate | null = null;
  const listModelsHarnessIds: GuiHarnessId[] = [];

  function armHold(): void {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold = { promise, release };
  }
  function releaseHold(): void {
    hold?.release();
    hold = null;
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
      "autoJudge.get": async () => {
        if (hold !== null) await hold.promise;
        const response: AutoJudgeGetResponse = {
          selection: null,
          effective: traycerGreen
            ? {
                source: "default",
                harnessId: "traycer",
                model: TRAYCER_MODEL_SLUG,
              }
            : { source: "fallback" },
          blocked: null,
        };
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
  };
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
        });
      },
      { timeout: WAIT_TIMEOUT_MS },
    );

    expect(fixture.listModelsRequestedFor("traycer")).toBe(true);
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
