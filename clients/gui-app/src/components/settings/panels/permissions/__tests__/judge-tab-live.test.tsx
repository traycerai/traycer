/**
 * `JudgeTab` against the REAL `useAutoJudgeQuery` and `useAutoJudgeSetMutation`,
 * through a real `QueryClient` and a `HostClient` over a `MockHostMessenger`.
 *
 * `judge-tab.test.tsx` replaces both hooks wholesale and calls `onSuccess` /
 * `onError` by hand, so it cannot see what the real stack does around a write
 * (the mutation writes the cache BEFORE the per-call settle runs, and
 * TanStack fires per-call callbacks for the latest `mutate` only), and its model
 * catalog answers synchronously, so the path that WAITS on a catalog was never
 * driven. Here `autoJudge.set` is held per call, and the model catalog starts
 * pending and is answered by the test.
 */
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
  type GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  AutoJudgeSelection,
  AutoJudgeSetRequest,
  AutoJudgeSetResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { JudgeTab } from "@/components/settings/panels/permissions/judge-tab";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";

// ---- host boundary --------------------------------------------------------

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));
vi.mock(
  "@/components/settings/host-scope/use-scoped-host-binding",
  async () => {
    const { scopedHostBindingFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      useScopedHostBinding: (scope: HostScope) =>
        scopedHostBindingFixture(scope),
    };
  },
);
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (): void => undefined,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "autoJudge.get" ? true : null,
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoJudge.set",
}));
const toastSpy = vi.hoisted(() =>
  vi.fn<(error: unknown, title: string) => void>(),
);
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (error: unknown, title: string): void =>
    toastSpy(error, title),
}));

// The hooks under test save and read through the app-wide client, which would
// otherwise need a whole `<HostRuntimeProvider>`.
const hostClientMock = vi.hoisted(() =>
  vi.fn<() => HostClient<HostRpcRegistry> | null>(() => null),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      const client = hostClientMock();
      if (client === null) throw new Error("no fixture host client yet");
      return client;
    },
  };
});

// ---- the catalog, providers and settings navigation -----------------------

type ModelsState =
  | { readonly kind: "pending" }
  | {
      readonly kind: "ready";
      readonly models: ReadonlyArray<GuiAgentModelOption>;
    }
  | { readonly kind: "error" };

// The model catalog per harness, answered by the test: it starts pending, then
// becomes a list (possibly empty) or an error.
const modelsStore = vi.hoisted(() => {
  const pending: ModelsState = { kind: "pending" };
  let states: Record<string, ModelsState> = {};
  const listeners = new Set<() => void>();
  return {
    get: (harnessId: string): ModelsState => states[harnessId] ?? pending,
    set: (harnessId: string, next: ModelsState): void => {
      states = { ...states, [harnessId]: next };
      for (const listener of listeners) listener();
    },
    reset: (): void => {
      states = {};
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

const harnessesState = vi.hoisted(
  (): { current: ReadonlyArray<GuiHarnessOption> } => ({ current: [] }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQuery: () => ({ data: { harnesses: harnessesState.current } }),
  useGuiHarnessModelsQuery: (harnessId: string) => {
    const state = useSyncExternalStore(modelsStore.subscribe, () =>
      modelsStore.get(harnessId),
    );
    return {
      data: state.kind === "ready" ? { models: state.models } : undefined,
      isError: state.kind === "error",
      isPending: state.kind === "pending",
    };
  },
}));

const providersState = vi.hoisted(
  (): { current: ReadonlyArray<ProviderCliState> } => ({ current: [] }),
);
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: { providers: providersState.current } }),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));
vi.mock(
  "@/components/settings/panels/permissions/provider-judge-switch",
  () => ({ ProviderJudgeSwitch: (): ReactNode => null }),
);

// ---- fixtures -------------------------------------------------------------

function harness(overrides: Partial<GuiHarnessOption>): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: "claude",
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    ...overrides,
  });
}

function model(
  harnessId: string,
  slug: string,
  label: string,
): GuiAgentModelOption {
  return guiAgentModelOptionSchema.parse({
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    metadata: {},
  });
}

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
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

function provider(
  providerId: ProviderId,
  profiles: ProviderProfile[],
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
  };
}

const CLAUDE_STORED: AutoJudgeSelection = {
  harnessId: "claude",
  model: "sonnet",
  profileId: null,
};

/** One `autoJudge.set` the host has received and not yet answered. */
interface HeldSet {
  readonly request: AutoJudgeSetRequest;
  readonly succeed: () => void;
  readonly refuse: () => void;
}

interface JudgeFixture {
  readonly queryClient: QueryClient;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  /** Every `autoJudge.set` the host has received and not yet answered. */
  readonly held: HeldSet[];
  /** How many `autoJudge.get` requests have reached the host. */
  readonly getCalls: () => number;
  /** From now on, `autoJudge.get` requests wait until `releaseGets`. */
  readonly holdGets: () => void;
  readonly releaseGets: () => void;
}

/**
 * A fresh fixture per test: a real `QueryClient`, a real `HostClient`
 * requester and a `MockHostMessenger` whose `autoJudge.set` HOLDS each call
 * until the test answers it. `autoJudge.get` answers what the last successful
 * write stored, as the host does.
 */
function createFixture(): JudgeFixture {
  const queryClient = createAppQueryClient();
  let requestSeq = 0;
  let stored: AutoJudgeSelection | null = CLAUDE_STORED;
  let getCalls = 0;
  let getGate: Promise<void> | null = null;
  let releaseGate: () => void = () => undefined;
  const held: HeldSet[] = [];

  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestSeq += 1;
      return `req-${String(requestSeq)}`;
    },
    handlers: {
      "autoJudge.get": async () => {
        getCalls += 1;
        // The answer is what the host stores WHEN THE REQUEST ARRIVES.
        const answer = {
          selection: stored,
          effective: { source: "fallback" as const },
          blocked: null,
        };
        if (getGate !== null) await getGate;
        return answer;
      },
      "autoJudge.set": (params) =>
        new Promise<AutoJudgeSetResponse>((resolve, reject) => {
          held.push({
            request: params,
            succeed: () => {
              stored = params.selection;
              resolve({
                selection: params.selection,
                effective: { source: "fallback" },
                blocked: null,
              });
            },
            refuse: () => reject(new Error("refused")),
          });
        }),
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
  hostClientMock.mockImplementation(() => client);

  return {
    queryClient,
    messenger,
    held,
    getCalls: (): number => getCalls,
    holdGets: (): void => {
      getGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    releaseGets: (): void => {
      getGate = null;
      releaseGate();
    },
  };
}

/** The `model` of an `autoJudge.set` request, or `null` for anything else. */
function requestedModel(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  if (!("selection" in params)) return null;
  const selection = params.selection;
  if (typeof selection !== "object" || selection === null) return null;
  if (!("model" in selection)) return null;
  return typeof selection.model === "string" ? selection.model : null;
}

/** Every model the host was asked to store, in arrival order. */
function sentModels(fixture: JudgeFixture): ReadonlyArray<string | null> {
  return fixture.messenger.calls
    .filter((call) => call.method === "autoJudge.set")
    .map((call) => requestedModel(call.params));
}

function renderTab(fixture: JudgeFixture): void {
  render(
    <QueryClientProvider client={fixture.queryClient}>
      <JudgeTab />
    </QueryClientProvider>,
  );
}

function heldAt(fixture: JudgeFixture, index: number): HeldSet {
  const call = fixture.held.at(index);
  if (call === undefined) throw new Error(`no held autoJudge.set #${index}`);
  return call;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function storedJudgeShown(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("judge-provider-select").textContent).toContain(
      "Claude Code",
    );
  });
}

function chooseProvider(label: string): void {
  fireEvent.click(screen.getByTestId("judge-provider-select"));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

function chooseAccount(name: RegExp): void {
  fireEvent.click(screen.getByTestId("judge-account-select"));
  fireEvent.click(screen.getByRole("option", { name }));
}

const NO_MODELS_LINE =
  "Codex offers no models on this machine. Pick another provider.";
const FAILED_LINE =
  "Couldn't load Codex's models. Reopen Settings to try again, or pick another provider.";

function providerText(): string {
  return screen.getByTestId("judge-provider-select").textContent;
}

/**
 * Records the Provider trigger's text after EVERY DOM mutation, so a frame
 * that shows a superseded selection is caught even when the end state is right.
 */
function watchProviderText(): {
  readonly history: string[];
  readonly stop: () => void;
} {
  const history: string[] = [];
  const record = (): void => {
    const trigger = document.querySelector(
      '[data-testid="judge-provider-select"]',
    );
    if (trigger !== null) history.push(trigger.textContent);
  };
  record();
  const observer = new MutationObserver(record);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  return { history, stop: () => observer.disconnect() };
}

beforeEach(() => {
  toastSpy.mockReset();
  modelsStore.reset();
  harnessesState.current = [
    harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
    harness({ id: "codex", label: "Codex", judgeDefaultModel: "gpt-mini" }),
  ];
  modelsStore.set("claude", {
    kind: "ready",
    models: [model("claude", "sonnet", "Claude Sonnet")],
  });
  providersState.current = [
    provider("claude-code", [profile("ambient", "ambient")]),
    provider("codex", [
      profile("ambient", "ambient"),
      profile("work", "managed"),
    ]),
  ];
});

afterEach(() => {
  cleanup();
  hostClientMock.mockReset();
});

describe("JudgeTab against the real query stack", () => {
  it("a: after a pick's write succeeds, no frame before the refetch answers shows the old selection", async () => {
    const fixture = createFixture();
    modelsStore.set("codex", {
      kind: "ready",
      models: [model("codex", "gpt-mini", "GPT Mini")],
    });
    renderTab(fixture);
    await storedJudgeShown();
    const watch = watchProviderText();

    chooseProvider("Codex");
    await waitFor(() => expect(fixture.held).toHaveLength(1));
    expect(providerText()).toContain("Codex");

    // The refetch the write's revalidation starts is HELD, so the window
    // between the write settling and the record answering is observable.
    fixture.holdGets();
    const getsBeforeSettle = fixture.getCalls();
    await act(async () => {
      heldAt(fixture, 0).succeed();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(fixture.getCalls()).toBeGreaterThan(getsBeforeSettle),
    );
    await flush();
    expect(providerText()).toContain("Codex");
    const firstPick = watch.history.findIndex((text) => text.includes("Codex"));
    expect(firstPick).toBeGreaterThanOrEqual(0);
    expect(
      watch.history.slice(firstPick).filter((text) => !text.includes("Codex")),
    ).toEqual([]);

    await act(async () => {
      fixture.releaseGets();
      await Promise.resolve();
    });
    await flush();
    watch.stop();

    expect(providerText()).toContain("Codex");
    expect(
      watch.history.slice(firstPick).filter((text) => !text.includes("Codex")),
    ).toEqual([]);
  });

  it("b: two rapid picks, the first written and the second refused, leave the controls on the first", async () => {
    const fixture = createFixture();
    modelsStore.set("codex", {
      kind: "ready",
      models: [
        model("codex", "gpt-mini", "GPT Mini"),
        model("codex", "gpt-big", "GPT Big"),
      ],
    });
    renderTab(fixture);
    await storedJudgeShown();

    chooseProvider("Codex");
    fireEvent.click(screen.getByTestId("judge-model-combobox"));
    fireEvent.click(screen.getByText("GPT Big"));
    await waitFor(() => expect(fixture.held).toHaveLength(1));

    await act(async () => {
      heldAt(fixture, 0).succeed();
      await Promise.resolve();
    });
    await waitFor(() => expect(fixture.held).toHaveLength(2));
    await act(async () => {
      heldAt(fixture, 1).refuse();
      await Promise.resolve();
    });
    await flush();

    expect(providerText()).toContain("Codex");
    expect(screen.getByTestId("judge-model-combobox").textContent).toContain(
      "GPT Mini",
    );
  });

  describe("a provider with no default model", () => {
    beforeEach(() => {
      harnessesState.current = [
        harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
        harness({ id: "codex", label: "Codex", judgeDefaultModel: null }),
      ];
    });

    it("c: an empty catalog then an account choice never sends an empty model", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();

      chooseProvider("Codex");
      act(() => {
        modelsStore.set("codex", { kind: "ready", models: [] });
      });
      await flush();
      chooseAccount(/work/);
      await flush();

      // The client refuses a `model: ""` before it reaches the messenger
      // (`min(1)` in the contract), so the request log alone cannot see the
      // attempt: the refusal is the "Couldn't save" toast.
      expect(sentModels(fixture)).not.toContain("");
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it("d: a failed catalog read sends no empty model and says so, never Loading models", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();

      chooseProvider("Codex");
      act(() => {
        modelsStore.set("codex", { kind: "error" });
      });
      await flush();
      chooseAccount(/work/);
      await flush();
      fireEvent.click(screen.getByTestId("judge-model-combobox"));
      await flush();

      expect(sentModels(fixture)).not.toContain("");
      expect(toastSpy).not.toHaveBeenCalled();
      expect(screen.queryByText("Loading models…")).toBeNull();
      expect(screen.getByTestId("auto-judge-pick-warning").textContent).toBe(
        FAILED_LINE,
      );
      // The line under the fields, and the one in the open Model popover.
      expect(screen.getAllByText(FAILED_LINE)).toHaveLength(2);
    });

    it("e: an empty catalog says so, and how to fix it, in the line and in the Model popover", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();

      chooseProvider("Codex");
      act(() => {
        modelsStore.set("codex", { kind: "ready", models: [] });
      });
      await flush();

      expect(screen.getByTestId("auto-judge-pick-warning").textContent).toBe(
        NO_MODELS_LINE,
      );
      fireEvent.click(screen.getByTestId("judge-model-combobox"));
      await flush();

      // The warning line has it too, so the popover makes two.
      expect(screen.getAllByText(NO_MODELS_LINE)).toHaveLength(2);
      expect(screen.queryByText("No matching models.")).toBeNull();
    });

    it("f: an uncommitted pick commits once, on the model the catalog names, when it answers", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();

      // Both choices are made while the catalog is still pending.
      chooseProvider("Codex");
      chooseAccount(/work/);
      await flush();
      expect(fixture.held).toHaveLength(0);

      act(() => {
        modelsStore.set("codex", {
          kind: "ready",
          models: [model("codex", "gpt-x", "GPT X")],
        });
      });
      await waitFor(() => expect(fixture.held).toHaveLength(1));
      await flush();

      const workProfile = providersState.current
        .flatMap((state) => state.profiles)
        .find((candidate) => candidate.profileId === "work");
      if (workProfile === undefined) throw new Error("no work profile");
      expect(heldAt(fixture, 0).request).toEqual({
        selection: {
          harnessId: "codex",
          model: "gpt-x",
          profileId: profileCommitId(workProfile),
        },
      });
      expect(sentModels(fixture)).toEqual(["gpt-x"]);
      expect(sentModels(fixture)).not.toContain("");
    });
  });
});
