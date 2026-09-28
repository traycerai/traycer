/**
 * `JudgeTab` against the REAL `useAutoJudgeQuery` and `useAutoJudgeSetMutation`,
 * through a real `QueryClient` and a `HostClient` over a `MockHostMessenger`.
 *
 * `judge-tab.test.tsx` replaces both hooks wholesale and calls `onSuccess` /
 * `onError` by hand, so it cannot see what the real stack does around a write
 * (the mutation writes the cache BEFORE the per-call settle runs, and
 * TanStack fires per-call callbacks for the latest `mutate` only). Here
 * `autoJudge.set` is held per call, the REAL `HarnessModelPicker` makes the
 * picks, and a provider's model catalog starts pending and is answered by the
 * test.
 */
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  AutoJudgeBlocked,
  AutoJudgeEffective,
  AutoJudgeSelection,
  AutoJudgeSetRequest,
  AutoJudgeSetResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import {
  judgeModelsFailedLine,
  judgeNoModelsLine,
} from "@/components/settings/panels/auto-judge-selection";
import { JudgeTab } from "@/components/settings/panels/permissions/judge-tab";
import {
  harness,
  judgeCatalog,
  model,
  profile,
  provider,
  resetModels,
  setModels,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys";
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
  useHostMethodSchemaVersion: (_hostId: string | null, method: string) =>
    method === "autoJudge.get" || method === "autoJudge.set"
      ? { major: 1, minor: 3 }
      : { major: 9, minor: 1 },
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
// The catalog, the providers list and the host plumbing the REAL
// `HarnessModelPicker` reads, all answering from `judge-test-support`.
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", async () =>
  (await import("./judge-test-support")).guiHarnessCatalogModuleMock(),
);
vi.mock("@/hooks/providers/use-providers-list-query", async () =>
  (await import("./judge-test-support")).providersListModuleMock(),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", async () =>
  (await import("./judge-test-support")).pickerHostMocks.clientForHostId(),
);
vi.mock("@/hooks/host/use-reactive-host-readiness", async () =>
  (
    await import("./judge-test-support")
  ).pickerHostMocks.reactiveHostReadiness(),
);
vi.mock("@/hooks/agent/use-host-reachability", async () =>
  (await import("./judge-test-support")).pickerHostMocks.hostReachability(),
);
vi.mock("@/hooks/host/use-addressable-host-id", async () =>
  (await import("./judge-test-support")).pickerHostMocks.addressableHostId(),
);
vi.mock("@/hooks/host/use-host-directory-list-query", async () =>
  (await import("./judge-test-support")).pickerHostMocks.hostDirectoryList(),
);
vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", async () =>
  (await import("./judge-test-support")).pickerHostMocks.ensurePack(),
);
vi.mock(
  "@/hooks/providers/use-providers-set-profile-enabled-mutation",
  async () =>
    (await import("./judge-test-support")).pickerHostMocks.setProfileEnabled(),
);
vi.mock("@/hooks/rate-limits/use-profile-usage-comparison", async () =>
  (await import("./judge-test-support")).pickerHostMocks.profileUsage(),
);
vi.mock("react-virtuoso", async () =>
  (await import("./judge-test-support")).pickerHostMocks.virtuoso(),
);
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));

// ---- fixtures -------------------------------------------------------------

const CLAUDE_STORED: AutoJudgeSelection = {
  harnessId: "claude",
  model: "sonnet",
  profileId: null,
  reasoningEffort: null,
};

/** What one `autoJudge.get` answers: the record and the host's verdict. */
interface JudgeAnswer {
  readonly selection: AutoJudgeSelection | null;
  readonly effective: AutoJudgeEffective;
  readonly lastSelection?: AutoJudgeSelection | null;
}

/** One `autoJudge.get` the host has received and not yet answered. */
interface HeldGet {
  readonly succeed: (answer: JudgeAnswer) => void;
  readonly fail: () => void;
}

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
  /** What the record stores, before the first read. */
  readonly setStored: (selection: AutoJudgeSelection | null) => void;
  /** The `effective` every later `autoJudge.get` answers. */
  readonly setEffective: (effective: AutoJudgeEffective) => void;
  /** The `blocked` every later, non-intercepted `autoJudge.get` answers. */
  readonly setBlocked: (blocked: AutoJudgeBlocked | null) => void;
  /** The whole answer the next `autoJudge.set` echoes on success. */
  readonly setEcho: (echo: JudgeAnswer) => void;
  /** While on, each `autoJudge.get` waits in `heldGets` for the test. */
  readonly interceptGets: (on: boolean) => void;
  readonly heldGets: HeldGet[];
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
  // What the host keeps as the last pick: the selection a switch to Automatic
  // cleared, as a 1.2 host does.
  let lastStored: AutoJudgeSelection | null = null;
  let getCalls = 0;
  let getGate: Promise<void> | null = null;
  let releaseGate: () => void = () => undefined;
  const held: HeldSet[] = [];
  const heldGets: HeldGet[] = [];
  let intercept = false;
  let effective: AutoJudgeEffective = { source: "fallback" };
  let blocked: AutoJudgeBlocked | null = null;
  let echo: JudgeAnswer | null = null;

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
          lastSelection: lastStored,
          effective,
          blocked,
        };
        if (intercept) {
          return new Promise<typeof answer>((resolve, reject) => {
            heldGets.push({
              succeed: (next) => {
                stored = next.selection;
                resolve({
                  ...next,
                  lastSelection: next.lastSelection ?? lastStored,
                  blocked: null,
                });
              },
              fail: () => reject(new Error("get refused")),
            });
          });
        }
        if (getGate !== null) await getGate;
        return answer;
      },
      "autoJudge.set": (params) =>
        new Promise<AutoJudgeSetResponse>((resolve, reject) => {
          held.push({
            request: params,
            succeed: () => {
              const answer: JudgeAnswer = echo ?? {
                selection: params.selection,
                effective: { source: "fallback" },
              };
              if (params.selection === null && stored !== null) {
                lastStored = stored;
              }
              stored = answer.selection;
              resolve({ ...answer, lastSelection: lastStored, blocked: null });
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
    heldGets,
    setStored: (selection): void => {
      stored = selection;
    },
    setEffective: (next): void => {
      effective = next;
    },
    setBlocked: (next): void => {
      blocked = next;
    },
    setEcho: (next): void => {
      echo = next;
    },
    interceptGets: (on): void => {
      intercept = on;
    },
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
      <SurfaceActivityProvider active>
        <TooltipProvider delayDuration={0}>
          <JudgeTab />
        </TooltipProvider>
      </SurfaceActivityProvider>
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

function face(): HTMLElement {
  return screen.getByTestId("auto-judge-model-face");
}

function faceText(): string {
  return face().textContent;
}

function faceDimmed(): boolean {
  return face().closest(".opacity-45") !== null;
}

async function storedJudgeShown(): Promise<void> {
  await waitFor(() => {
    expect(faceText()).toContain("Claude Sonnet");
  });
}

function pickerOpen(): boolean {
  return screen.queryByRole("dialog", { name: "Select model" }) !== null;
}

async function openPicker(user: UserEvent): Promise<void> {
  if (pickerOpen()) return;
  await user.click(face());
  await screen.findByRole("dialog", { name: "Select model" });
}

/** Opens the picker and clicks a provider on its rail. */
async function switchProvider(user: UserEvent, name: RegExp): Promise<void> {
  await openPicker(user);
  await user.click(await screen.findByRole("tab", { name }));
}

const NO_MODELS_LINE = judgeNoModelsLine("Codex");
const FAILED_LINE = judgeModelsFailedLine("Codex");

/**
 * Records the face's text after EVERY DOM mutation, so a frame that shows a
 * superseded selection is caught even when the end state is right.
 */
function watchFaceText(): {
  readonly history: string[];
  readonly stop: () => void;
} {
  const history: string[] = [];
  const record = (): void => {
    const trigger = document.querySelector(
      '[data-testid="auto-judge-model-face"]',
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
  resetModels();
  judgeCatalog.harnessesStatus = "answered";
  judgeCatalog.harnesses = [
    harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
    harness({ id: "codex", label: "Codex", judgeDefaultModel: "gpt-mini" }),
    harness({ id: "traycer", label: "Traycer" }),
  ];
  setModels("traycer", {
    kind: "ready",
    models: [model("traycer", "traycer-fast", "Traycer Fast", {})],
  });
  setModels("claude", {
    kind: "ready",
    models: [model("claude", "sonnet", "Claude Sonnet", {})],
  });
  judgeCatalog.providers = [
    provider("claude-code", [profile("ambient", "ambient")]),
    provider("codex", [profile("ambient", "ambient")]),
  ];
});

afterEach(() => {
  cleanup();
  hostClientMock.mockReset();
});

describe("JudgeTab against the real query stack", () => {
  it("a: after a pick's write succeeds, no frame before the refetch answers shows the old selection", async () => {
    const fixture = createFixture();
    setModels("codex", {
      kind: "ready",
      models: [model("codex", "gpt-mini", "GPT Mini", {})],
    });
    renderTab(fixture);
    await storedJudgeShown();
    const user = userEvent.setup();
    const watch = watchFaceText();

    await switchProvider(user, /Codex/);
    await waitFor(() => expect(fixture.held).toHaveLength(1));
    expect(faceText()).toContain("GPT Mini");

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
    expect(faceText()).toContain("GPT Mini");
    const firstPick = watch.history.findIndex((text) =>
      text.includes("GPT Mini"),
    );
    expect(firstPick).toBeGreaterThanOrEqual(0);
    expect(
      watch.history
        .slice(firstPick)
        .filter((text) => !text.includes("GPT Mini")),
    ).toEqual([]);

    await act(async () => {
      fixture.releaseGets();
      await Promise.resolve();
    });
    await flush();
    watch.stop();

    expect(faceText()).toContain("GPT Mini");
    expect(
      watch.history
        .slice(firstPick)
        .filter((text) => !text.includes("GPT Mini")),
    ).toEqual([]);
  });

  it("b: two rapid picks, the first written and the second refused, leave the tile on the first and toast", async () => {
    const fixture = createFixture();
    setModels("codex", {
      kind: "ready",
      models: [
        model("codex", "gpt-mini", "GPT Mini", {}),
        model("codex", "gpt-big", "GPT Big", {}),
      ],
    });
    renderTab(fixture);
    await storedJudgeShown();
    const user = userEvent.setup();

    await switchProvider(user, /Codex/);
    await openPicker(user);
    await user.click(await screen.findByRole("option", { name: /GPT Big/ }));
    await waitFor(() => expect(fixture.held).toHaveLength(1));

    await act(async () => {
      heldAt(fixture, 0).succeed();
      await Promise.resolve();
    });
    await waitFor(() => expect(fixture.held).toHaveLength(2));
    expect(toastSpy).not.toHaveBeenCalled();
    await act(async () => {
      heldAt(fixture, 1).refuse();
      await Promise.resolve();
    });
    await flush();

    // Snapped back to what the host holds, and said so.
    expect(faceText()).toContain("GPT Mini");
    expect(faceText()).not.toContain("GPT Big");
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("a refused write snaps the tiles back to the stored record and toasts", async () => {
    const fixture = createFixture();
    renderTab(fixture);
    await storedJudgeShown();

    fireEvent.click(screen.getByRole("radio", { name: /Automatic/ }));
    await waitFor(() => expect(fixture.held).toHaveLength(1));
    expect(
      screen
        .getByRole("radio", { name: /Automatic/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(toastSpy).not.toHaveBeenCalled();

    await act(async () => {
      heldAt(fixture, 0).refuse();
      await Promise.resolve();
    });
    await flush();

    expect(
      screen
        .getByRole("radio", { name: /A model you pick/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(faceText()).toContain("Claude Sonnet");
    expect(faceDimmed()).toBe(false);
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("switching to Automatic keeps the cleared pick on the second tile, dimmed, through the write and its refetch", async () => {
    const fixture = createFixture();
    renderTab(fixture);
    await storedJudgeShown();
    const watch = watchFaceText();

    fireEvent.click(screen.getByRole("radio", { name: /Automatic/ }));
    await waitFor(() => expect(fixture.held).toHaveLength(1));
    expect(faceText()).toContain("Claude Sonnet");
    expect(faceDimmed()).toBe(true);

    await act(async () => {
      heldAt(fixture, 0).succeed();
      await Promise.resolve();
    });
    await flush();
    watch.stop();

    // The host moved the pick into `lastSelection`; no frame on the way said
    // "Choose a model".
    expect(faceText()).toContain("Claude Sonnet");
    expect(faceDimmed()).toBe(true);
    expect(
      watch.history.filter((text) => text.includes("Choose a model")),
    ).toEqual([]);
  });

  describe("a provider with no default model", () => {
    beforeEach(() => {
      judgeCatalog.harnesses = [
        harness({ id: "claude", label: "Claude Code", nativeAutoJudge: true }),
        harness({ id: "codex", label: "Codex", judgeDefaultModel: null }),
      ];
    });

    it("c: an empty catalog, then closing the picker, sends nothing and re-seeds to the stored pick", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();
      const user = userEvent.setup();

      await switchProvider(user, /Codex/);
      act(() => {
        setModels("codex", { kind: "ready", models: [] });
      });
      await flush();
      await user.keyboard("{Escape}");
      await flush();

      expect(sentModels(fixture)).toEqual([]);
      expect(toastSpy).not.toHaveBeenCalled();
      expect(screen.queryByTestId("auto-judge-pending-switch")).toBeNull();
      expect(faceText()).toContain("Claude Sonnet");
    });

    it("d: a failed catalog read sends no empty model and says so, never a spinner", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();
      const user = userEvent.setup();

      await switchProvider(user, /Codex/);
      act(() => {
        setModels("codex", { kind: "error" });
      });
      await flush();

      expect(sentModels(fixture)).not.toContain("");
      expect(fixture.held).toHaveLength(0);
      expect(toastSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId("auto-judge-pending-switch").textContent).toBe(
        FAILED_LINE,
      );
    });

    it("e: an empty catalog says so, and how to fix it, on the second tile", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();
      const user = userEvent.setup();

      await switchProvider(user, /Codex/);
      act(() => {
        setModels("codex", { kind: "ready", models: [] });
      });
      await flush();

      expect(screen.getByTestId("auto-judge-pending-switch").textContent).toBe(
        NO_MODELS_LINE,
      );
      expect(fixture.held).toHaveLength(0);
    });

    it("f: a switch made while the catalog is pending commits once, on the model the catalog names, when it answers", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();
      const user = userEvent.setup();

      await switchProvider(user, /Codex/);
      await flush();
      expect(fixture.held).toHaveLength(0);
      expect(screen.getByTestId("auto-judge-pending-switch")).not.toBeNull();

      // Close the picker: the switch survives, still waiting.
      await user.keyboard("{Escape}");
      await flush();
      expect(screen.getByTestId("auto-judge-pending-switch")).not.toBeNull();

      act(() => {
        setModels("codex", {
          kind: "ready",
          models: [model("codex", "gpt-x", "GPT X", {})],
        });
      });
      await waitFor(() => expect(fixture.held).toHaveLength(1));
      await flush();

      expect(heldAt(fixture, 0).request).toEqual({
        selection: {
          harnessId: "codex",
          model: "gpt-x",
          profileId: null,
          reasoningEffort: null,
        },
      });
      expect(sentModels(fixture)).toEqual(["gpt-x"]);
      expect(sentModels(fixture)).not.toContain("");
    });

    it("R1: a click on Automatic while the switch waits wins when the catalog lands afterwards", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();
      const user = userEvent.setup();

      await switchProvider(user, /Codex/);
      expect(screen.getByTestId("auto-judge-pending-switch")).not.toBeNull();
      await user.keyboard("{Escape}");
      await flush();

      await user.click(screen.getByRole("radio", { name: /Automatic/ }));
      await waitFor(() => expect(fixture.held).toHaveLength(1));

      act(() => {
        setModels("codex", {
          kind: "ready",
          models: [model("codex", "gpt-x", "GPT X", {})],
        });
      });
      // Writes are serialised, so a stray Codex write would queue behind the
      // held one: answer it, then look at what the host was asked.
      await act(async () => {
        heldAt(fixture, 0).succeed();
        await Promise.resolve();
      });
      await flush();

      expect(sentModels(fixture)).toEqual([null]);
      expect(fixture.held).toHaveLength(1);
    });
  });

  describe("a verdict the host has since invalidated", () => {
    const DEFAULT_VERDICT: AutoJudgeEffective = {
      source: "default",
      harnessId: "traycer",
      model: "traycer-fast",
    };
    const FALLBACK_LINE =
      "Now: each conversation's own model · on your account there";

    /** The app's own reaction to a catalog change, run from the test. */
    function invalidateVerdict(fixture: JudgeFixture): Promise<void> {
      const queryKey = hostQueryKeys.methodScope(
        mockRemoteHostEntry.hostId,
        "autoJudge.get",
      );
      expect(
        fixture.queryClient.getQueryCache().findAll({ queryKey }).length,
      ).toBeGreaterThan(0);
      return fixture.queryClient
        .cancelQueries({ queryKey })
        .then(() => fixture.queryClient.invalidateQueries({ queryKey }));
    }

    function heldGetAt(fixture: JudgeFixture, index: number): HeldGet {
      const call = fixture.heldGets.at(index);
      if (call === undefined)
        throw new Error(`no held autoJudge.get #${index}`);
      return call;
    }

    function effectiveText(): string {
      return screen.getByTestId("auto-judge-effective").textContent;
    }

    it("g: an availability transition shows no Traycer verdict while the re-read is pending or refused, and the fallback once it answers", async () => {
      const fixture = createFixture();
      fixture.setStored(null);
      fixture.setEffective(DEFAULT_VERDICT);
      renderTab(fixture);
      await waitFor(() =>
        expect(effectiveText()).toContain("Traycer Fast on Traycer"),
      );
      expect(effectiveText()).toBe(
        "Now: Traycer Fast on Traycer · uses Traycer credits",
      );

      fixture.interceptGets(true);
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = invalidateVerdict(fixture);
        await Promise.resolve();
      });
      await waitFor(() => expect(fixture.heldGets).toHaveLength(1));
      await flush();
      expect(document.body.textContent).not.toContain("on Traycer");

      await act(async () => {
        heldGetAt(fixture, 0).fail();
        await Promise.resolve();
      });
      await flush();
      expect(document.body.textContent).not.toContain("on Traycer");

      // CONTROL: once the host answers the transition, the line is the
      // fallback's.
      fixture.interceptGets(false);
      fixture.setEffective({ source: "fallback" });
      await act(async () => {
        await invalidateVerdict(fixture);
      });
      await pending;
      await waitFor(() => expect(effectiveText()).toBe(FALLBACK_LINE));
    });

    it("i: a stored judge's blocked verdict is withheld while the re-read is pending or refused, and the next verdict shows once it answers", async () => {
      const fixture = createFixture();
      fixture.setStored(CLAUDE_STORED);
      fixture.setEffective({ source: "fallback" });
      fixture.setBlocked({ reason: "unsupported-harness" });
      renderTab(fixture);
      await storedJudgeShown();
      await waitFor(() =>
        expect(screen.getByTestId("auto-judge-warning").textContent).toContain(
          "can't run a judge on",
        ),
      );

      fixture.interceptGets(true);
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = invalidateVerdict(fixture);
        await Promise.resolve();
      });
      await waitFor(() => expect(fixture.heldGets).toHaveLength(1));
      await flush();
      expect(screen.queryByTestId("auto-judge-warning")).toBeNull();

      await act(async () => {
        heldGetAt(fixture, 0).fail();
        await Promise.resolve();
      });
      await flush();
      expect(screen.queryByTestId("auto-judge-warning")).toBeNull();

      // CONTROL, and a different verdict: the line comes back from a current
      // read, and it is the new one.
      fixture.interceptGets(false);
      fixture.setBlocked({ reason: "provider-disabled" });
      await act(async () => {
        await invalidateVerdict(fixture);
      });
      await pending;
      await waitFor(() =>
        expect(screen.getByTestId("auto-judge-warning").textContent).toContain(
          "is turned off on this machine",
        ),
      );
    });

    describe("h: a save whose echo names a verdict the next read replaces", () => {
      const AUTOMATIC_ECHO: JudgeAnswer = {
        selection: null,
        effective: DEFAULT_VERDICT,
      };

      async function chooseAutomaticHeld(fixture: JudgeFixture): Promise<void> {
        fixture.setStored(CLAUDE_STORED);
        fixture.setEffective({
          source: "selection",
          harnessId: "claude",
          model: "sonnet",
        });
        renderTab(fixture);
        await storedJudgeShown();
        fireEvent.click(screen.getByRole("radio", { name: /Automatic/ }));
        await waitFor(() => expect(fixture.held).toHaveLength(1));
      }

      it("h: while the post-save read is held or refused, no Traycer verdict shows", async () => {
        const fixture = createFixture();
        await chooseAutomaticHeld(fixture);
        fixture.setEcho(AUTOMATIC_ECHO);
        fixture.interceptGets(true);
        await act(async () => {
          heldAt(fixture, 0).succeed();
          await Promise.resolve();
        });
        await waitFor(() => expect(fixture.heldGets).toHaveLength(1));
        await flush();
        expect(document.body.textContent).not.toContain("on Traycer");

        await act(async () => {
          heldGetAt(fixture, 0).fail();
          await Promise.resolve();
        });
        await flush();
        expect(document.body.textContent).not.toContain("on Traycer");
      });

      it("h-control: the post-save read answering fallback shows the fallback line", async () => {
        const fixture = createFixture();
        await chooseAutomaticHeld(fixture);
        fixture.setEcho(AUTOMATIC_ECHO);
        fixture.interceptGets(true);
        await act(async () => {
          heldAt(fixture, 0).succeed();
          await Promise.resolve();
        });
        await waitFor(() => expect(fixture.heldGets).toHaveLength(1));
        await act(async () => {
          heldGetAt(fixture, 0).succeed({
            selection: null,
            effective: { source: "fallback" },
          });
          await Promise.resolve();
        });
        await flush();
        await waitFor(() => expect(effectiveText()).toBe(FALLBACK_LINE));
      });
    });
  });

  it("R4: no frame across a pick, Automatic before its write lands, and both refetches reads Choose a model", async () => {
    const fixture = createFixture();
    fixture.setStored(null);
    renderTab(fixture);
    await waitFor(() => expect(faceText()).toContain("Choose a model"));
    const user = userEvent.setup();
    const watch = watchFaceText();

    await switchProvider(user, /Claude/);
    await waitFor(() => expect(fixture.held).toHaveLength(1));
    await user.keyboard("{Escape}");
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /Automatic/ }));
    // The mutation is serialised by its scope: the second write waits for the
    // first, so the tiles run on the drafts alone until it is answered.
    await flush();
    expect(faceText()).toContain("Claude Sonnet");
    expect(faceDimmed()).toBe(true);

    await act(async () => {
      heldAt(fixture, 0).succeed();
      await Promise.resolve();
    });
    await waitFor(() => expect(fixture.held).toHaveLength(2));
    await flush();
    await act(async () => {
      heldAt(fixture, 1).succeed();
      await Promise.resolve();
    });
    await flush();
    watch.stop();

    expect(faceText()).toContain("Claude Sonnet");
    expect(faceDimmed()).toBe(true);
    const firstPick = watch.history.findIndex((text) =>
      text.includes("Claude Sonnet"),
    );
    expect(firstPick).toBeGreaterThanOrEqual(0);
    expect(
      watch.history
        .slice(firstPick)
        .filter((text) => text.includes("Choose a model")),
    ).toEqual([]);
  });

  describe("R8: the tab re-reads the judge when the window regains focus", () => {
    const OPUS: AutoJudgeSelection = {
      harnessId: "claude",
      model: "opus",
      profileId: null,
      reasoningEffort: null,
    };
    const FALLBACK_LINE =
      "Now: each conversation's own model · on your account there";

    function focusWindow(): void {
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
    }

    beforeEach(() => {
      setModels("claude", {
        kind: "ready",
        models: [
          model("claude", "sonnet", "Claude Sonnet", {}),
          model("claude", "opus", "Claude Opus", {}),
        ],
      });
    });

    it("shows a judge changed elsewhere, with no remount", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();

      fixture.setStored(OPUS);
      focusWindow();

      await waitFor(() => expect(faceText()).toContain("Claude Opus"));
    });

    it("keeps the verdict line up while the focus refetch is held", async () => {
      const fixture = createFixture();
      fixture.setStored(null);
      fixture.setEffective({ source: "fallback" });
      renderTab(fixture);
      await waitFor(() =>
        expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
          FALLBACK_LINE,
        ),
      );

      fixture.holdGets();
      const before = fixture.getCalls();
      focusWindow();
      await waitFor(() => expect(fixture.getCalls()).toBeGreaterThan(before));
      await flush();
      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        FALLBACK_LINE,
      );

      await act(async () => {
        fixture.releaseGets();
        await Promise.resolve();
      });
      await flush();
      expect(screen.getByTestId("auto-judge-effective").textContent).toBe(
        FALLBACK_LINE,
      );
    });

    it("does not overwrite a pick still saving, whatever the re-read answers, before or after the save settles", async () => {
      const fixture = createFixture();
      renderTab(fixture);
      await storedJudgeShown();
      const user = userEvent.setup();

      await openPicker(user);
      await user.click(
        await screen.findByRole("option", { name: /Claude Opus/ }),
      );
      await waitFor(() => expect(fixture.held).toHaveLength(1));
      expect(faceText()).toContain("Claude Opus");

      // The host has not stored the pick yet, and another window has moved
      // the judge somewhere else entirely.
      fixture.setStored({
        harnessId: "codex",
        model: "gpt-mini",
        profileId: null,
        reasoningEffort: null,
      });
      fixture.holdGets();
      const before = fixture.getCalls();
      focusWindow();
      await waitFor(() => expect(fixture.getCalls()).toBeGreaterThan(before));
      await act(async () => {
        fixture.releaseGets();
        await Promise.resolve();
      });
      await flush();
      expect(faceText()).toContain("Claude Opus");

      await act(async () => {
        heldAt(fixture, 0).succeed();
        await Promise.resolve();
      });
      await flush();
      expect(faceText()).toContain("Claude Opus");
    });
  });
});
